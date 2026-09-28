/**
 * チャットの読み上げのページ（speech/reader/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースに置き、Twitchのチャットを匿名IRCで受けて、同じPCで動いている VOICEVOX ENGINE に
 * 読み上げさせる。画面には何も映さないので、OBSでは音だけを載せる。
 *
 * 読み上げそのものは task.ts が受け持ち、ここはURLパラメータを読んでそれを呼ぶだけである
 * （裏方をまとめたページ（overlay/backstage/）も同じ task.ts を呼ぶ。issue #108）。
 *
 * 注意: 起動のときの失敗は画面に出して止める（Fail-Fast。読み上げが動いていないことに配信中に気づけないため）。
 */
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { SPEECH_NOUN, startSpeech } from './task'

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

const start = async (): Promise<void> => {
  const params = parseParams(schema, new URLSearchParams(location.search))
  if (params.key === '') {
    throw new ParamError(['key: オーバーレイ用キーを指定してください（例: ?key=<キー>）'])
  }
  await startSpeech({ key: params.key, box: document.body })
}

start().catch((error: unknown) => {
  showError(error, SPEECH_NOUN)
  throw error
})
