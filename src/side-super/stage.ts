/**
 * サイドスーパーのオーバーレイ（side-super/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースに置き、配信画面の隅（左上・右上）に「いま何をしているか」を2行までで出し続ける。
 * 文言は cron（worker/collect.ts）が5分おきに作って Worker に貯めてあるので、このページは定期的に
 * 読みに行って映すだけでよい（アラートのように押し出してもらう必要がない）。
 *
 * 読み出しは api.ts、画面は view.ts にあり、ここはそれらをつなぐだけである。
 * 素材ページの約束どおり、React もログインも持ち込まず、オーバーレイ用キー（?key=）で Worker に受け付けてもらう。
 *
 * 注意: 起動のときの失敗（キーの誤りなど）は画面に出す。OBSではコンソールを見られないので、
 * 何も映らない理由が分からなくなるためである。いっぽう2回目以降の読み出しの失敗は画面に出さず、
 * 前回の文言をそのまま映し続ける。一時的な通信の失敗で配信画面にエラーが出ないようにするためである。
 */
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { createSideSuperApi } from './api'
import { createSideSuperView } from './view'

const NOUN = 'サイドスーパー'

/**
 * 文言を読みに行く間隔（ミリ秒）。
 *
 * 作り直しは cron の5分おきなので、これより短くしても新しい文言は増えない。それでも30秒にしているのは、
 * 配信を始めた直後やOBSを開き直した直後に、最初の文言が出るまでの待ちを短くするためである。
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
  position: {
    type: 'string',
    default: 'left',
    pattern: /^(?:left|right)$/,
    example: 'left または right',
    description: '画面のどちら側に出すか（left: 左上、right: 右上）',
  },
} as const satisfies ParamSchema

const start = async (): Promise<void> => {
  const root = document.querySelector<HTMLElement>('[data-side-super]')
  if (!root) throw new Error('data-side-super 属性を持つ要素が見つかりません')

  const params = parseParams(schema, new URLSearchParams(location.search))
  if (params.key === '') {
    throw new ParamError(['key: オーバーレイ用キーを指定してください（例: ?key=<キー>）'])
  }

  // 寄せる向きはCSS（src/side-super/side-super.css）が data-position から決める
  root.dataset.position = params.position

  const view = createSideSuperView(root)
  const api = createSideSuperApi((input, init) => fetch(input, init), params.key)

  // 1回目は起動の一部として扱う。ここで失敗したら画面に出して原因が分かるようにする
  view.setLines(await api.read())

  window.setInterval(() => {
    void api
      .read()
      .then((lines) => view.setLines(lines))
      .catch((error: unknown) => {
        // 一時的な通信の失敗で配信画面を汚さない。前回の文言をそのまま映したまま、原因は記録に残す
        console.error('サイドスーパーを読み込めませんでした', error)
      })
  }, POLL_INTERVAL_MS)
}

start().catch((error: unknown) => {
  showError(error, NOUN)
  throw error
})
