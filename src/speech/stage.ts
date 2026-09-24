/**
 * チャットの読み上げのページ（speech/reader/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースに置き、Twitchのチャットを匿名IRCで受けて、同じPCで動いている VOICEVOX ENGINE
 * （既定 http://localhost:50021）に読み上げさせる。画面には何も映さないので、OBSでは音だけを載せる。
 *
 * 読み上げ文の組み立ては text.ts、順番待ちは queue.ts、合成は voicevox.ts、再生は audio.ts にあり、
 * ここはそれらをつなぐだけである。素材ページの約束どおり React もログインも持ち込まない。
 * チャットボックス（src/chat/）と同じ匿名IRCなので、URLにオーバーレイ用キーも要らない
 * （接続先のチャンネル名だけを、キーの要らない公開API /api/chat/channel から受け取る）。
 *
 * 注意: 起動のときの失敗（VOICEVOX が動いていない・チャンネル名が読めない）は画面に出して止める
 * （Fail-Fast。読み上げが動いていないことに配信中に気づけないため）。一方、鳴らしている途中の1件の失敗では
 * 止めずにその1件を飛ばす。1件のために以降ずっと無音になると、OBSの再読み込みが要るためである。
 */
import { loadChannel } from '../chat/channel'
import { connectChat } from '../chat/connection'
import { showError } from '../core/mount'
import { parseParams, type ParamSchema } from '../core/params'
import { playSpeech } from './audio'
import { advanceSpeech, EMPTY_SPEECH_QUEUE, enqueueSpeech, type SpeechQueue } from './queue'
import { speechTextOf } from './text'
import { createVoicevox, voicevoxOrigin } from './voicevox'

const NOUN = 'チャットの読み上げ'

const schema = {
  host: {
    type: 'string',
    default: 'localhost',
    // ブラウザが http:// への通信（混在コンテンツ）を許すのはループバックだけなので、そのどちらかしか受け取らない
    pattern: /^(?:localhost|127\.0\.0\.1)$/,
    example: 'localhost または 127.0.0.1',
    description: 'VOICEVOX が動いているホスト（OBSと同じPCなので localhost のまま使う）',
  },
  port: {
    type: 'number',
    default: 50021,
    min: 1,
    max: 65535,
    integer: true,
    description: 'VOICEVOX ENGINE のポート番号（既定は 50021）',
  },
  speaker: {
    type: 'number',
    default: 3,
    min: 0,
    max: 100000,
    integer: true,
    description: '話者ID（VOICEVOX のキャラクターとスタイルの組み合わせ。既定の 3 はずんだもんのノーマル）',
  },
  speed: { type: 'number', default: 1, min: 0.5, max: 2, description: '読み上げ速度（1 が標準）' },
  volume: { type: 'number', default: 1, min: 0, max: 1, description: '音量（0〜1）' },
  maxLength: { type: 'number', default: 60, min: 1, max: 200, integer: true, description: '読み上げる本文の長さの上限（文字数）' },
  readName: { type: 'boolean', default: false, description: '本文の前に発言者の表示名を読むか' },
  ignore: {
    type: 'string',
    default: '',
    // Twitchのログイン名（英数字と下線、25文字まで）をカンマで並べる
    pattern: /^[A-Za-z0-9_]{1,25}(?:,[A-Za-z0-9_]{1,25})*$/,
    example: 'hdad_bot または hdad_bot,nightbot',
    description: '読み上げない人のログイン名（botの応答を読み上げさせないために使う）',
  },
} as const satisfies ParamSchema

const start = async (): Promise<void> => {
  const params = parseParams(schema, new URLSearchParams(location.search))
  const voicevox = createVoicevox((input, init) => fetch(input, init), {
    origin: voicevoxOrigin(params.host, params.port),
    speaker: params.speaker,
    speed: params.speed,
  })
  // 読み上げ先が動いていないまま配信を始めないよう、つなぎ始める前に確かめる
  await voicevox.checkReady()

  const ignoreLogins = params.ignore === '' ? [] : params.ignore.split(',')
  const textOptions = { readName: params.readName, maxLength: params.maxLength, ignoreLogins }

  let queue: SpeechQueue = EMPTY_SPEECH_QUEUE
  /** いま読み上げの処理を回しているか。1件ずつ順に読むため、回っているあいだは新しく始めない */
  let speaking = false

  const pump = async (): Promise<void> => {
    if (speaking) return
    speaking = true
    try {
      while (queue.current !== null) {
        const text = queue.current
        try {
          await playSpeech(await voicevox.synthesize(text), params.volume)
        } catch (error) {
          // 読めなかった1件のために、以降の読み上げを止めない。原因を追えるよう記録だけ残す
          console.error('読み上げできませんでした', text, error)
        }
        queue = advanceSpeech(queue)
      }
    } finally {
      speaking = false
    }
  }

  const { login } = await loadChannel((input, init) => fetch(input, init))
  connectChat(login, {
    onEvent: (event) => {
      if (event.type !== 'message') return
      const text = speechTextOf(event.message, textOptions)
      if (text === null) return
      queue = enqueueSpeech(queue, text)
      void pump()
    },
    // 切断と再接続は読み上げに関係しない（画面も持たないので知らせる先がない）
    onStatus: () => undefined,
  })
}

start().catch((error: unknown) => {
  showError(error, NOUN)
  throw error
})
