/**
 * 拡張のボタンが押されたときの手順と、ボタンの表示
 *
 * 映したいタブでボタン（ショートカットの既定は Alt+Shift+T）が押されたら、そのタブのストリームIDを取り、
 * offscreen document に取り込ませる。**映しているタブでもう一度押されたら止める**。別のタブで押されたら、そのタブに切り替える。
 *
 * Chrome の API は ControllerApi として外から受け取り、ここは「押されたら何をするか・何を表示するか」だけを決める（テストのため）。
 * 映しているタブは api.remember で覚える（サービスワーカーは眠ると変数を失うので、chrome.storage.session に置く）。
 *
 * 映さないサイト（issue #165）: 映し始めるたびに Worker から一覧を読み、押したタブが一覧のサイトなら映さない。
 * 映しているタブが一覧のサイトへ移り始めたら（handleNavigation）送るのを止め、映してよいページが表示されたら送り直す。
 * ボタンの右クリック（handleBlockSite）で、そのタブのホスト名を一覧に加える。
 *
 * 注意: IDを取れない・取り込めないときは、黙って何もしないのではなくバッジ「!」で知らせ、理由はボタンの説明に出す。
 * 注意: 映さないサイトの一覧を読めないときは映し始めない。保険が読めないまま映し続けるのは危険なので、安全側に倒す。
 */
import { hostOfPageUrl, isBlockedUrl } from '../../src/tab/blocked-hosts'
import { reasonOf } from './guards'
import type { OffscreenEvent } from './offscreen-event'

/** ボタンの状態 */
export type BadgeState =
  | { kind: 'idle' }
  | { kind: 'capturing'; viewers: number; warning: string | null }
  | { kind: 'problem'; message: string }
  /** 映さないサイトにいるので、合成ページへ送るのを止めている */
  | { kind: 'paused'; host: string }
  /** 映さないサイトに登録した */
  | { kind: 'registered'; host: string }

/** 映しているあいだに覚えておくこと（サービスワーカーは眠ると変数を失うので、まとめて chrome.storage.session に置く） */
export interface CaptureState {
  /** 映しているタブ */
  readonly tabId: number
  /** 映しているタブで最後に知ったURL（登録したサイトがいま映っているかを確かめるのに使う） */
  readonly url: string
  /** 映し始めたときに読んだ映さないサイトの一覧（右クリックで登録したら覚え直す） */
  readonly blockedHosts: readonly string[]
  /** 映さないサイトにいて送るのを止めているなら、そのサイト（止めていなければ null） */
  readonly pausedAt: string | null
}

/** この手順が使う Chrome の機能 */
export interface ControllerApi {
  /** いま映しているタブの記録（映していなければ null） */
  capturing(): Promise<CaptureState | null>
  /** 映しているタブの記録を覚える（null は映していない） */
  remember(state: CaptureState | null): Promise<void>
  /**
   * 映さないサイトの一覧を Worker から読む。
   *
   * @throws 読めない場合（ログインしていない・Worker につながらないなど）
   */
  loadBlockedHosts(): Promise<string[]>
  /**
   * ホスト名を映さないサイトに登録する。
   *
   * @returns 登録したあとの一覧
   * @throws 登録できなかった場合
   */
  addBlockedHost(host: string): Promise<string[]>
  /** targetTabId のタブを、この拡張の画面で取り込むためのIDを取る */
  getMediaStreamId(targetTabId: number): Promise<string>
  /**
   * offscreen document を用意して、このIDのタブを取り込ませる。
   *
   * @throws 取り込めなかった場合
   */
  startCapture(streamId: string): Promise<void>
  /** 映すのをやめさせ、offscreen document を閉じる */
  stopCapture(): Promise<void>
  /** 取り込みは保ったまま、合成ページへ送るのをやめさせる */
  pauseCapture(): Promise<void>
  /** pauseCapture で止めていた送信を再開させる */
  resumeCapture(): Promise<void>
  /** ボタンの表示を変える */
  show(state: BadgeState): Promise<void>
}

/** 押されたタブ（url はボタンかショートカットで呼ばれたときに Chrome が渡す。activeTab と同じ扱い） */
export interface ClickedTab {
  id?: number
  url?: string
}

/** 映しているタブの中でページが移ったこと */
export interface TabNavigation {
  readonly tabId: number
  readonly url: string
  /**
   * 新しいページが表示されたか。false は移り始めただけで、前のページがまだ映っている。
   *
   * 移り始め（webNavigation.onBeforeNavigate）で止め、表示されたとき（tabs.onUpdated の URL の変化。
   * history.pushState による画面遷移も含む）に送り直すために分ける。
   */
  readonly committed: boolean
}

const IDLE: BadgeState = { kind: 'idle' }
const HOW_TO_UNBLOCK = '一覧は HDAD の「タブの映像」のページで消せます'

/** 映さないサイトとして表示する名前（読めないURLはホスト名が無いので、URLのまま出す） */
const siteOf = (url: string): string => hostOfPageUrl(url) ?? url

/**
 * 映さないサイトへ移ったので、送るのを止めて覚える。
 *
 * 注意: 止められなければ、映し続けずに取り込みごと止める（映してはいけないページを送り続けるより安全なため）。
 */
const pauseAt = async (state: CaptureState, url: string, api: ControllerApi): Promise<void> => {
  const site = siteOf(url)
  if (state.pausedAt === null) {
    try {
      await api.pauseCapture()
    } catch (error) {
      try {
        await api.stopCapture()
      } finally {
        await api.remember(null)
      }
      await api.show({ kind: 'problem', message: `映さないサイト（${site}）へ移りましたが、送るのを止められなかったので映すのをやめました: ${reasonOf(error)}` })
      return
    }
  }
  await api.remember({ ...state, url, pausedAt: site })
  await api.show({ kind: 'paused', host: site })
}

/** 押されたタブを映す。映しているタブなら止める */
export const handleClick = async (tab: ClickedTab, api: ControllerApi): Promise<void> => {
  if (tab.id === undefined) {
    await api.show({ kind: 'problem', message: '映すタブを特定できませんでした。映したいタブを開いてから押してください' })
    return
  }
  const capturing = await api.capturing()
  if (capturing?.tabId === tab.id) {
    try {
      await api.stopCapture()
    } finally {
      // 止めるのに失敗しても記録は消す。残すと次に押したときも止めようとし続け、映し始められなくなる
      await api.remember(null)
    }
    await api.show(IDLE)
    return
  }

  if (tab.url === undefined) {
    await api.show({ kind: 'problem', message: 'このタブのURLを読めないので映しません。映したいタブを開いてから押してください' })
    return
  }
  // IDは数秒で使えなくなるので、一覧はIDを取る前に読む
  let blockedHosts: string[]
  try {
    blockedHosts = await api.loadBlockedHosts()
  } catch (error) {
    await api.show({ kind: 'problem', message: `映さないサイトの一覧を読めないので映しません: ${reasonOf(error)}` })
    return
  }
  if (isBlockedUrl(tab.url, blockedHosts)) {
    await api.show({ kind: 'problem', message: `${siteOf(tab.url)} は映さないサイトに登録されているので映しません（${HOW_TO_UNBLOCK}）` })
    return
  }

  let streamId: string
  try {
    streamId = await api.getMediaStreamId(tab.id)
  } catch (error) {
    await api.show({ kind: 'problem', message: `このタブは映せません: ${reasonOf(error)}` })
    return
  }
  try {
    await api.startCapture(streamId)
  } catch (error) {
    // 映していなかったなら、取り込むために用意した offscreen document を片付ける。
    // 切り替えの途中なら、前のタブはまだ映っているので止めない
    if (capturing === null) {
      try {
        await api.stopCapture()
      } catch (cleanupError) {
        // 片付けの失敗は記録だけにし、配信者には取り込めなかった理由のほうを知らせる（同じ原因で失敗していることが多い）
        console.error('取り込めなかったあとの片付けに失敗しました', cleanupError)
      }
    }
    await api.show({ kind: 'problem', message: `タブを取り込めませんでした: ${reasonOf(error)}。もう一度押してください` })
    return
  }
  await api.remember({ tabId: tab.id, url: tab.url, blockedHosts, pausedAt: null })
  await api.show({ kind: 'capturing', viewers: 0, warning: null })
}

/**
 * 映しているタブの中でページが移ったら、映さないサイトかどうかで送るのを止める・送り直す。
 *
 * 映さないサイトへは移り始めた時点で止める（新しいページが描かれる前に止めるため）。映してよいページへは、表示されたときに
 * 送り直す（移り始めただけでは、映さないサイトのページがまだ映っているため）。
 */
export const handleNavigation = async (navigation: TabNavigation, api: ControllerApi): Promise<void> => {
  const state = await api.capturing()
  if (state === null || state.tabId !== navigation.tabId) return
  if (isBlockedUrl(navigation.url, state.blockedHosts)) {
    await pauseAt(state, navigation.url, api)
    return
  }
  if (!navigation.committed) return
  await api.remember({ ...state, url: navigation.url, pausedAt: null })
  if (state.pausedAt === null) return
  await api.resumeCapture()
  await api.show({ kind: 'capturing', viewers: 0, warning: null })
}

/**
 * ボタンの右クリックで、そのタブのホスト名を映さないサイトに登録する。映しているタブがそのサイトなら、すぐに送るのを止める。
 *
 * 手で打たせないので、登録できるのはいま開いているタブのホスト名だけである（docs/principles.md の方針2）。
 */
export const handleBlockSite = async (tab: ClickedTab, api: ControllerApi): Promise<void> => {
  const host = tab.url === undefined ? null : hostOfPageUrl(tab.url)
  if (host === null) {
    await api.show({ kind: 'problem', message: 'このページはホスト名で登録できません（登録できるのは http・https のページだけです）' })
    return
  }
  let blockedHosts: string[]
  try {
    blockedHosts = await api.addBlockedHost(host)
  } catch (error) {
    await api.show({ kind: 'problem', message: `映さないサイトに登録できませんでした: ${reasonOf(error)}` })
    return
  }
  const state = await api.capturing()
  if (state === null) {
    await api.show({ kind: 'registered', host })
    return
  }
  const next: CaptureState = { ...state, blockedHosts }
  if (state.pausedAt === null && isBlockedUrl(state.url, blockedHosts)) {
    await pauseAt(next, state.url, api)
    return
  }
  // 映しているタブには関わらないので、ボタンの表示（映している状態）はそのままにする
  await api.remember(next)
}

/** offscreen document からの知らせを、ボタンの表示に反映する */
export const handleOffscreenEvent = async (event: OffscreenEvent, api: ControllerApi): Promise<void> => {
  // 止めた直後に、止める前の状態が遅れて届くことがある。映していないなら表示に出さない
  const state = await api.capturing()
  if (state === null) return
  switch (event.type) {
    case 'state':
      // 映さないサイトで送るのを止めているあいだは、止めていることのほうを出し続ける
      await api.show(state.pausedAt === null ? { kind: 'capturing', viewers: event.viewers, warning: event.warning } : { kind: 'paused', host: state.pausedAt })
      return
    case 'ended':
      await api.stopCapture()
      await api.remember(null)
      await api.show(IDLE)
      return
  }
}

/**
 * 処理を1つずつ順に走らせる窓口を作る。
 *
 * ボタンの押下と offscreen document からの知らせは、どちらも「映しているタブ」の記録を読み書きする。並んで走ると、
 * 1回目の押下が記録する前に2回目の押下や知らせが記録を読み、映しているのに映していないと判断してしまう
 * （素早く2回押すと取り込みを片付けてしまう・最初の状態の知らせを捨ててしまう）。そこで順に走らせる。
 *
 * @param onError 処理の失敗を知らせる先。失敗しても次の処理は続ける
 * @returns 処理を並べる関数。並べた処理が終わる（失敗なら知らせ終える）と解決する
 */
export const createSerialQueue = (onError: (error: unknown) => void): ((task: () => Promise<void>) => Promise<void>) => {
  let tail: Promise<void> = Promise.resolve()
  return (task) => {
    tail = tail.then(task).catch(onError)
    return tail
  }
}

/** 知らせが無いときのボタンの説明（manifest.json の default_title と同じ） */
const DEFAULT_TITLE = 'このタブを配信に映す（HDAD）'
const CAPTURING_BADGE = 'ON'
const CAPTURING_COLOR = '#188038'
const PROBLEM_BADGE = '!'
const PROBLEM_COLOR = '#d93025'
const PAUSED_BADGE = '止'
const PAUSED_COLOR = '#e37400'
const HOW_TO_STOP = '映しているタブでもう一度押すと止めます'

/** ボタンに出すもの（color が null ならバッジの色を変えない） */
export interface BadgeView {
  text: string
  color: string | null
  title: string
}

/** ボタンの状態から、バッジと説明を決める */
export const describeBadge = (state: BadgeState): BadgeView => {
  switch (state.kind) {
    case 'idle':
      return { text: '', color: null, title: DEFAULT_TITLE }
    case 'problem':
      return { text: PROBLEM_BADGE, color: PROBLEM_COLOR, title: state.message }
    case 'paused':
      return {
        text: PAUSED_BADGE,
        color: PAUSED_COLOR,
        title: `映さないサイト（${state.host}）なので、合成ページへ送るのを止めています。映してよいページへ移ると再開します`,
      }
    case 'registered':
      return { text: '', color: null, title: `${state.host} を映さないサイトに登録しました（${HOW_TO_UNBLOCK}）` }
    case 'capturing': {
      if (state.warning !== null) return { text: PROBLEM_BADGE, color: PROBLEM_COLOR, title: `${state.warning}（${HOW_TO_STOP}）` }
      const viewers =
        state.viewers > 0 ? `合成ページ ${state.viewers} か所` : '合成ページとまだつながっていません。OBSに合成ページを読み込み、素材「タブの映像」を置いてください'
      return { text: CAPTURING_BADGE, color: CAPTURING_COLOR, title: `映しています（${viewers}）。${HOW_TO_STOP}` }
    }
  }
}
