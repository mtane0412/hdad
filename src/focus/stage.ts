/**
 * 注目コメントのオーバーレイ（focus/overlay/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースに置き、配信者が取り上げた1件を出しっぱなしにする。取り上げ方は2通りある
 * （worker/focus-config.ts）。
 * - 人に追従する: 匿名IRCで届く発言をその人で絞り、最新の1件へ差し替えながら映す
 * - 発言1件を取り上げる: Worker から受け取った本文をそのまま映す（次の発言では差し替わらない）
 *
 * 取り上げているものは Worker が持つので、このページは定期的に読みに行くだけでよい（サイドスーパーと
 * 同じポーリング。配信中に相手を変えるたびにOBSのURLを貼り替えないための作りである）。
 * 読み出しは api.ts、何を映すかの判断は focused.ts、画面は view.ts にあり、ここはそれらをつなぐ。
 *
 * 素材ページの約束どおり、React もログインも持ち込まず、オーバーレイ用キー（?key=）で Worker に
 * 受け付けてもらう。チャットの受け取りはチャットボックスと同じ匿名IRC（../chat/connection.ts）なので
 * Twitchのトークンは持たない。
 *
 * 注意: モデレーターが発言を消した・その人をBANしたときは、映すのをやめる（withRemoval）。
 * 配信画面に残ったままにすると取り返しがつかない。
 * 注意: 起動のときの失敗（キーの誤り・チャンネル名が読めない）は画面に出して止める。OBSでは
 * コンソールを見られないので、何も映らない理由が分からなくなるためである。いっぽう2回目以降の
 * 読み出しの失敗は画面に出さず、前に読んだ指定のまま映し続ける（一時的な通信の失敗で配信画面を汚さない）。
 * 注意: サードパーティ（7TV・BTTV・FFZ）のエモートは読み込まない。取得の失敗を知らせる場所が
 * このページには無く、1件を大きく映すのに要らないためである（公式エモートと Cheermote は絵で出る）。
 */
import { loadChannel } from '../chat/channel'
import { applyCheermotes, loadCheermotes, type CheermoteMap } from '../chat/cheermotes'
import { connectChat } from '../chat/connection'
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { createFocusOverlayApi } from './api'
import { demoFocused } from './demo'
import { NO_FOCUS, withMessage, withRemoval, withTarget, type FocusState } from './focused'
import { createFocusView } from './view'

const NOUN = '注目コメント'

/**
 * 取り上げているものを読みに行く間隔（ミリ秒）。
 *
 * 配信者は「今から怖い話をする」と言い出した人を見つけてから取り上げるので、切り替えてから映るまでの
 * 待ちは短いほうがよい。読むのはKVの1件だけなので、サイドスーパー（30秒）より短くしている。
 */
const POLL_INTERVAL_MS = 10000

/** デモでサンプルを切り替える間隔（ミリ秒）。読み切れるだけの長さで次のサンプルへ移る */
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
  demo: { type: 'boolean', default: false, description: 'サンプルを流す（見栄えと配置の調整用。Workerには接続しない）' },
} as const satisfies ParamSchema

// fetch をそのまま渡すと this が外れて Illegal invocation になるブラウザがあるので、包んで渡す
const callWorker: typeof fetch = (input, init) => fetch(input, init)

const start = async (): Promise<void> => {
  const root = document.querySelector<HTMLElement>('[data-focus]')
  if (!root) throw new Error('data-focus 属性を持つ要素が見つかりません')

  const params = parseParams(schema, new URLSearchParams(location.search))
  if (!params.demo && params.key === '') {
    throw new ParamError([
      'key: オーバーレイ用キーを指定してください（例: ?key=<キー>）',
      '見栄えと配置を確かめるだけなら ?demo=true を指定してください',
    ])
  }

  const view = createFocusView(root)

  if (params.demo) {
    // サンプルを先頭から順に、一巡したらまた先頭から流す
    let demoIndex = 0
    const showDemo = (): void => {
      const focused = demoFocused[demoIndex % demoFocused.length]
      demoIndex += 1
      if (focused) view.setFocused(focused)
    }
    showDemo()
    window.setInterval(showDemo, DEMO_INTERVAL_MS)
    return
  }

  const api = createFocusOverlayApi(callWorker, params.key)

  /** いま取り上げているものと、映している1件。ここだけが持ち、書き換えたら必ず画面へ反映する */
  let state: FocusState = NO_FOCUS
  const update = (next: FocusState): void => {
    if (next === state) return
    state = next
    view.setFocused(state.shown)
  }

  // 1回目の読み出しと接続先の取得は起動の一部として扱う。ここで失敗したら画面に出して原因が分かるようにする
  update(withTarget(state, await api.read()))
  const channel = await loadChannel(callWorker)

  // Cheermote（ビッツの絵）は対象が決まっているので先に読み込む。取得できなくても映すのは止めない（文字のまま出る）
  let cheermotes: CheermoteMap = new Map()
  void loadCheermotes(callWorker)
    .then((loaded) => {
      cheermotes = loaded
    })
    .catch((error: unknown) => {
      // このページには知らせる場所が無いので、配信画面は汚さず記録だけ残す
      console.error('Cheermote（ビッツの絵）を取得できませんでした', error)
    })

  connectChat(channel.login, {
    onEvent: (event) => {
      switch (event.type) {
        case 'message':
          update(withMessage(state, { ...event.message, fragments: applyCheermotes(event.message.fragments, cheermotes, event.message.bits) }))
          break
        case 'delete':
          update(withRemoval(state, { type: 'message', messageId: event.id }))
          break
        case 'clear-user':
          update(withRemoval(state, { type: 'user', login: event.login }))
          break
        case 'clear-all':
          update(withRemoval(state, { type: 'all' }))
          break
        case 'room':
        case 'notice':
          // 接続の知らせは映すものに関係しない（このページには知らせる場所も無い）
          break
      }
    },
    onStatus: () => {
      // 切断・再接続はこのページには出さない。再接続は connection.ts が続けるので、映しているものはそのまま残す
    },
  })

  window.setInterval(() => {
    void api
      .read()
      .then((target) => update(withTarget(state, target)))
      .catch((error: unknown) => {
        // 一時的な通信の失敗で配信画面を汚さない。前に読んだ指定のまま映したまま、原因は記録に残す
        console.error('取り上げているものを読み込めませんでした', error)
      })
  }, POLL_INTERVAL_MS)
}

start().catch((error: unknown) => {
  showError(error, NOUN)
  throw error
})
