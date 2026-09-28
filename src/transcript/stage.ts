/**
 * 文字起こしの中継ページ（transcript/relay/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースに置き、同じPCで動いているゆかコネNEO（ws://localhost:11901/）から音声認識の結果を
 * 受け取って、確定した発話だけを Worker へ押し込む。
 *
 * 中継そのものは task.ts が受け持ち、ここはURLパラメータを読んでそれを呼ぶだけである
 * （裏方をまとめたページ（overlay/backstage/）も同じ task.ts を呼ぶ。issue #108）。
 */
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { startTranscript, TRANSCRIPT_NOUN } from './task'

const schema = {
  key: {
    type: 'string',
    default: '',
    // Workerが発行するキー（worker/secret.ts の randomToken）は、URLにそのまま載せられる文字だけでできている
    pattern: /^[A-Za-z0-9_-]{32,}$/,
    example: '管理用API（/api/me）の overlayKey の値',
    description: 'オーバーレイ用キー（必須）',
  },
  host: {
    type: 'string',
    default: 'localhost',
    // ブラウザが ws:// への接続（混在コンテンツ）を許すのはループバックだけなので、そのどちらかしか受け取らない
    pattern: /^(?:localhost|127\.0\.0\.1)$/,
    example: 'localhost または 127.0.0.1',
    description: 'ゆかコネNEO が動いているホスト（OBSと同じPCなので localhost のまま使う）',
  },
  port: {
    type: 'number',
    default: 11901,
    min: 1,
    max: 65535,
    integer: true,
    description: 'ゆかコネNEO の WebSocket のポート番号（レジストリ HKCU\\Software\\YukarinetteConnectorNeo\\WebSocket の値。既定は 11901）',
  },
} as const satisfies ParamSchema

const start = (): void => {
  const root = document.querySelector<HTMLElement>('[data-transcript]')
  if (!root) throw new Error('data-transcript 属性を持つ要素が見つかりません')

  const params = parseParams(schema, new URLSearchParams(location.search))
  if (params.key === '') {
    throw new ParamError(['key: オーバーレイ用キーを指定してください（例: ?key=<キー>）'])
  }

  startTranscript({ key: params.key, host: params.host, port: params.port, root })
}

try {
  start()
} catch (error) {
  showError(error, TRANSCRIPT_NOUN)
  throw error
}
