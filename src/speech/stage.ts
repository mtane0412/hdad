/**
 * チャットの読み上げのページ（speech/reader/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースに置き、Twitchのチャットを匿名IRCで受けて、同じPCで動いている VOICEVOX ENGINE
 * （既定 http://localhost:50021）に読み上げさせる。画面には何も映さないので、OBSでは音だけを載せる。
 *
 * 読み上げ文の組み立ては text.ts、順番待ちは queue.ts、合成は voicevox.ts、再生は audio.ts にあり、
 * ここはそれらをつなぐだけである。素材ページの約束どおり React もログインも持ち込まない。
 * チャットの受け取りはチャットボックス（src/chat/）と同じ匿名IRCなので、Twitchのトークンは持たない。
 *
 * 読み上げの設定（話者・速度・音量・長さ・名前を読むか・読み上げない人）は Worker が持ち、
 * オーバーレイ用キー（?key=）で /api/overlay/speech から読む（issue #86）。以前はすべてURLのクエリに
 * 埋めていたが、それだと配信中に音量ひとつ変えるにもURLを貼り替えることになるためである。
 * 設定は起動のあとも一定間隔で読み直し、次に読む1件から反映する（サイドスーパーと同じポーリング。
 * 押し出し（Durable Object）を使うほどの即時性は要らない）。
 *
 * 注意: ホストとポートだけは起動のときにしか使えない。つなぎ先が変わるとつなぎ直しが要るためで、
 * 変わったことに気づいたらOBSの再読み込みが要ることを画面に出す（黙って古いつなぎ先のまま読み続けない）。
 * 注意: 起動のときの失敗（VOICEVOX が動いていない・設定やチャンネル名が読めない）は画面に出して止める
 * （Fail-Fast。読み上げが動いていないことに配信中に気づけないため）。一方、鳴らしている途中の1件の失敗では
 * 止めずにその1件を飛ばす。1件のために以降ずっと無音になると、OBSの再読み込みが要るためである。
 * 設定の読み直しの失敗も止めず、前に読んだ設定のまま読み上げを続ける（一時的な通信の失敗で無音にしない）。
 */
import { loadChannel } from '../chat/channel'
import { connectChat } from '../chat/connection'
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { createSpeechOverlayApi, type SpeechSettings } from './api'
import { playSpeech } from './audio'
import { advanceSpeech, EMPTY_SPEECH_QUEUE, enqueueSpeech, type SpeechQueue } from './queue'
import { speechTextOf } from './text'
import { createVoicevox, voicevoxOrigin } from './voicevox'

const NOUN = 'チャットの読み上げ'

/**
 * 設定を読み直す間隔（ミリ秒）。
 *
 * 配信中に管理画面で音量や話者を変えたとき、これだけ待てば次の1件から効く。
 * サイドスーパーのオーバーレイ（src/side-super/stage.ts）と同じ間隔にしてある。
 */
const POLL_INTERVAL_MS = 30000

const schema = {
  key: {
    type: 'string',
    default: '',
    // Workerが発行するキー（worker/secret.ts の randomToken）は、URLにそのまま載せられる文字だけでできている
    pattern: /^[A-Za-z0-9_-]{32,}$/,
    example: '管理用API（/api/me）の overlayKey の値',
    description: 'オーバーレイ用キー（必須）',
  },
} as const satisfies ParamSchema

/** つなぎ先が変わったときに画面へ出す文面。読み上げは古いつなぎ先のまま続くので、直し方を添える */
const RECONNECT_NEEDED = new Error(
  'VOICEVOX のホストかポートが変わりました。新しいつなぎ先で読み上げるには、OBSでこのブラウザソースを再読み込みしてください（それまでは前のつなぎ先のまま読み上げます）',
)

const start = async (): Promise<void> => {
  const params = parseParams(schema, new URLSearchParams(location.search))
  if (params.key === '') {
    throw new ParamError(['key: オーバーレイ用キーを指定してください（例: ?key=<キー>）'])
  }

  const api = createSpeechOverlayApi((input, init) => fetch(input, init), params.key)
  // 1回目は起動の一部として扱う。ここで失敗したら画面に出して原因が分かるようにする
  let settings: SpeechSettings = await api.read()
  /** 起動のときのつなぎ先。以後これと違う設定が届いたら、OBSの再読み込みが要ると知らせる */
  const connectedTo = { host: settings.host, port: settings.port }

  const voicevox = createVoicevox((input, init) => fetch(input, init), {
    origin: voicevoxOrigin(settings.host, settings.port),
    // つながらないとき、ENGINE の設定で許可すべきオリジンとして画面に出すために渡す
    pageOrigin: location.origin,
  })
  // 読み上げ先が動いていないまま配信を始めないよう、つなぎ始める前に確かめる
  await voicevox.checkReady()

  /** つなぎ先が変わったことを、すでに画面へ出したか。30秒ごとに貼り出し続けないための印 */
  let reconnectNoticed = false
  window.setInterval(() => {
    void api
      .read()
      .then((latest) => {
        settings = latest
        if (reconnectNoticed || (latest.host === connectedTo.host && latest.port === connectedTo.port)) return
        reconnectNoticed = true
        showError(RECONNECT_NEEDED, NOUN)
      })
      .catch((error: unknown) => {
        // 一時的な通信の失敗で読み上げを止めない。前に読んだ設定のまま続け、原因は記録に残す
        console.error('読み上げの設定を読み込めませんでした', error)
      })
  }, POLL_INTERVAL_MS)

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
          // 声と音量は、その1件を鳴らす時点の設定で決める（読み上げの途中で変えても次の1件から効く）
          const audio = await voicevox.synthesize(text, { speaker: settings.speaker, speed: settings.speed })
          await playSpeech(audio, settings.volume)
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
      // 読むかどうかの判断も、届いた時点の設定で行う（読み上げない人を足したら次の発言から効く）
      const text = speechTextOf(event.message, {
        readName: settings.readName,
        maxLength: settings.maxLength,
        ignoreLogins: settings.ignoreLogins,
      })
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
