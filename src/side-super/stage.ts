/**
 * サイドスーパーのオーバーレイ（side-super/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースに置き、配信画面の隅（左上・右上）に「いま何をしているか」を2行のテロップで出し続ける。
 * 文言は cron（worker/collect.ts）が5分おきに作って Worker に貯めてあるので、このページは定期的に
 * 読みに行って映すだけでよい（アラートのように押し出してもらう必要がない）。
 *
 * 読み出しは api.ts、画面は view.ts にあり、ここはそれらをつなぐだけである。
 * 素材ページの約束どおり、React もログインも持ち込まず、オーバーレイ用キー（?key=）で Worker に受け付けてもらう。
 *
 * ?demo=true なら Worker に接続せず、サンプルの文言を一定間隔で順に流す（見栄えと配置の調整用）。
 * ふだんの文言は cron が5分おきに作るものなので、配信していないあいだや作られる前は何も映らない。
 * それでは OBS での配置を決められないため、アラート（src/alerts/stage.ts）と同じ道を用意している。
 *
 * 注意: 起動のときの失敗（キーの誤りなど）は画面に出す。OBSではコンソールを見られないので、
 * 何も映らない理由が分からなくなるためである。いっぽう2回目以降の読み出しの失敗は画面に出さず、
 * 前回の文言をそのまま映し続ける。一時的な通信の失敗で配信画面にエラーが出ないようにするためである。
 */
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { createSideSuperApi } from './api'
import { demoSideSupers } from './demo'
import { createSideSuperView } from './view'

const NOUN = 'サイドスーパー'

/**
 * 文言を読みに行く間隔（ミリ秒）。
 *
 * 作り直しは cron の5分おきなので、これより短くしても新しい文言は増えない。それでも30秒にしているのは、
 * 配信を始めた直後やOBSを開き直した直後に、最初の文言が出るまでの待ちを短くするためである。
 */
const POLL_INTERVAL_MS = 30000

/**
 * デモでサンプルを切り替える間隔（ミリ秒）。
 *
 * ふだんの作り直しは5分おきだが、それでは配置を確かめるのに待たされる。文言が変わるときの
 * 出現の動きも見たいので、読み切れるだけの長さ（6秒）で次のサンプルへ移る。
 */
const DEMO_INTERVAL_MS = 6000

const schema = {
  key: {
    type: 'string',
    default: '',
    // Workerが発行するキー（worker/secret.ts の randomToken）は、URLにそのまま載せられる文字だけでできている
    pattern: /^[A-Za-z0-9_-]{32,}$/,
    example: '管理用API（/api/me）の overlayKey の値',
    description: 'オーバーレイ用キー（必須）',
  },
  demo: { type: 'boolean', default: false, description: 'サンプルの文言を流す（見栄えと配置の調整用。Workerには接続しない）' },
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
  if (!params.demo && params.key === '') {
    throw new ParamError([
      'key: オーバーレイ用キーを指定してください（例: ?key=<キー>）',
      '見栄えと配置を確かめるだけなら ?demo=true を指定してください',
    ])
  }

  // 寄せる向きはCSS（src/side-super/side-super.css）が data-position から決める
  root.dataset.position = params.position

  const view = createSideSuperView(root)

  if (params.demo) {
    // サンプルを先頭から順に、一巡したらまた先頭から流す
    let demoIndex = 0
    const showDemo = (): void => {
      const lines = demoSideSupers[demoIndex % demoSideSupers.length]
      demoIndex += 1
      if (lines) view.setLines(lines)
    }
    showDemo()
    window.setInterval(showDemo, DEMO_INTERVAL_MS)
    return
  }

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
