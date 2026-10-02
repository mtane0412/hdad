/**
 * 拡張のボタンが押されたときの手順と、ボタンの表示
 *
 * 映したいタブでボタン（ショートカットの既定は Alt+Shift+T）が押されたら、そのタブのストリームIDを取り、
 * offscreen document に取り込ませる。**映しているタブでもう一度押されたら止める**。別のタブで押されたら、そのタブに切り替える。
 *
 * Chrome の API は ControllerApi として外から受け取り、ここは「押されたら何をするか・何を表示するか」だけを決める（テストのため）。
 * 映しているタブは api.remember で覚える（サービスワーカーは眠ると変数を失うので、chrome.storage.session に置く）。
 *
 * 映さないサイト（issue #165）: 一覧は Worker が持ち、拡張は最後に読んだ一覧を api.rememberBlockedHosts で覚える。
 * - 映し始めるたびに Worker から読み直し、押したタブが一覧のサイトなら映さない
 * - 映しているタブが一覧のサイトへ移り始めたら（handleNavigation）送るのを止め、映してよいページが表示されたら送り直す
 * - ボタンの右クリック（handleSiteMenuClick）で、そのタブのサイトを登録する。登録済みなら一覧から外す（項目の名前も切り替える）
 * - 拡張の設定ページ（handleSettingsRequest）で一覧を見て、ホスト名を入力して登録し、消す
 * 一覧が変わったら（applyBlockedHosts）、映しているタブにもすぐ反映する（止める・送り直す）。
 *
 * 映す範囲（issue #166）: ボタンの右クリック「映す範囲を選ぶ」（handlePickAreaClick）で、映しているタブに範囲を選ぶ画面を差し込む。
 * 選ばれた範囲は、そのタブから知らせが届いたら（handleAreaPicked）offscreen document に送らせる。「範囲を外す」
 * （handleClearAreaClick）でタブ全体に戻す。範囲は offscreen document が1つだけ持ち、別のタブに切り替えたら外れる。
 *
 * 注意: IDを取れない・取り込めないときは、黙って何もしないのではなくバッジ「!」で知らせ、理由はボタンの説明に出す。
 * 注意: 映さないサイトの一覧を読めないときは映し始めない。保険が読めないまま映し続けるのは危険なので、安全側に倒す。
 */
import { hostOfPageUrl, isBlockedUrl } from '../../src/tab/blocked-hosts'
import type { TabCrop } from '../../src/tab/crop'
import { isRecord, reasonOf } from './guards'
import type { OffscreenEvent } from './offscreen-event'
import type { SettingsReply, SettingsRequest } from './settings-request'

/** ボタンの状態 */
export type BadgeState =
  | { kind: 'idle' }
  | { kind: 'capturing'; viewers: number; warning: string | null }
  | { kind: 'problem'; message: string }
  /** 映さないサイトにいるので、合成ページへ送るのを止めている */
  | { kind: 'paused'; host: string }
  /** 映さないサイトに登録した */
  | { kind: 'registered'; host: string }
  /** 映さないサイトから外した */
  | { kind: 'unregistered'; host: string }

/** 映しているあいだに覚えておくこと（サービスワーカーは眠ると変数を失うので、まとめて chrome.storage.session に置く） */
export interface CaptureState {
  /** 映しているタブ */
  readonly tabId: number
  /** 映しているタブで最後に知ったURL（一覧が変わったとき、いま映っているページを照合し直すのに使う） */
  readonly url: string
  /** 映さないサイトにいて送るのを止めているなら、そのサイト（止めていなければ null） */
  readonly pausedAt: string | null
}

/**
 * chrome.storage.session から読み戻した値が、CaptureState として覚えた形か確かめる。
 *
 * 注意: CaptureState の項目を変えたら、ここも合わせて変える（食い違うと、映し始めたあとに記録を読む操作がすべて失敗する。
 * PR #178 で blockedHosts を外したときにここだけ残り、止める・範囲を選ぶが失敗した）。
 */
export const isCaptureState = (value: unknown): value is CaptureState =>
  isRecord(value) && typeof value.tabId === 'number' && typeof value.url === 'string' && (value.pausedAt === null || typeof value.pausedAt === 'string')

/** ボタンの右クリックに出す「映さない・映す」の項目 */
export interface SiteMenuView {
  readonly title: string
  /** false なら押せなくする（ホスト名で登録できないページ） */
  readonly enabled: boolean
}

/** この手順が使う Chrome の機能 */
export interface ControllerApi {
  /** いま映しているタブの記録（映していなければ null） */
  capturing(): Promise<CaptureState | null>
  /** 映しているタブの記録を覚える（null は映していない） */
  remember(state: CaptureState | null): Promise<void>
  /** 最後に読んだ映さないサイトの一覧（読んだことが無い・忘れたなら null） */
  knownBlockedHosts(): Promise<readonly string[] | null>
  /** 読んだ映さないサイトの一覧を覚える */
  rememberBlockedHosts(hosts: readonly string[]): Promise<void>
  /** いま前に出ているタブ（右クリックの項目の名前を決めるのに使う。無ければ null） */
  activeTab(): Promise<ClickedTab | null>
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
   * @throws 登録できなかった場合（ホスト名の形が違う場合を含む。形の検証は Worker が持つ）
   */
  addBlockedHost(host: string): Promise<string[]>
  /**
   * ホスト名を映さないサイトから外す。
   *
   * @returns 外したあとの一覧
   * @throws 外せなかった場合
   */
  removeBlockedHost(host: string): Promise<string[]>
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
  /**
   * このタブに、映す範囲を選ぶ画面を差し込む（選ばれたら、そのタブから知らせが届く）。
   *
   * @throws 差し込めないページ（chrome:// のページなど）の場合
   */
  pickArea(tabId: number): Promise<void>
  /**
   * offscreen document に映す範囲を送らせる（null はタブ全体）。
   *
   * @throws offscreen document が応じられなかった場合
   */
  setCrop(crop: TabCrop | null): Promise<void>
  /** ボタンの表示を変える */
  show(state: BadgeState): Promise<void>
  /** 右クリックの「映さない・映す」の項目を変える */
  showSiteMenu(menu: SiteMenuView): Promise<void>
}

/** 範囲を選ぶ画面から届いた、選ばれた範囲 */
export interface PickedArea {
  /** 選ばれたタブ（知らせの送り主。Chrome が渡す） */
  readonly tabId: number
  readonly crop: TabCrop
}

/** 押されたタブ（url は権限 tabs があるので Chrome が渡す） */
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
const CAPTURING: BadgeState = { kind: 'capturing', viewers: 0, warning: null }
const HOW_TO_UNBLOCK = 'ボタンの右クリックか拡張の設定で外せます'
const NOT_A_SITE = 'このページはホスト名で登録できません（登録できるのは http・https のページだけです）'

/** 映さないサイトとして表示する名前（読めないURLはホスト名が無いので、URLのまま出す） */
const siteOf = (url: string): string => hostOfPageUrl(url) ?? url

/** 止めているあいだ・止められなかったとき・一覧が分からないときに、取り込みごと止めて理由を出す */
const stopWith = async (message: string, api: ControllerApi): Promise<void> => {
  try {
    await api.stopCapture()
  } finally {
    await api.remember(null)
  }
  await api.show({ kind: 'problem', message })
}

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
      await stopWith(`映さないサイト（${site}）へ移りましたが、送るのを止められなかったので映すのをやめました: ${reasonOf(error)}`, api)
      return
    }
  }
  await api.remember({ ...state, url, pausedAt: site })
  await api.show({ kind: 'paused', host: site })
}

/**
 * 止めていた送信を再開して覚える。
 *
 * 送り直せたときだけ「止めていない」と覚える。先に覚えると、送り直しに失敗したあと止めたままなのに送り直さなくなる。
 */
const resumeAt = async (state: CaptureState, url: string, api: ControllerApi): Promise<void> => {
  await api.resumeCapture()
  await api.remember({ ...state, url, pausedAt: null })
  await api.show(CAPTURING)
}

/** 右クリックの項目の名前を、ページのURLと覚えている一覧から決める */
export const describeSiteMenu = (url: string | undefined, hosts: readonly string[] | null): SiteMenuView => {
  const host = url === undefined ? null : hostOfPageUrl(url)
  if (host === null) return { title: 'このページは映さないサイトに登録できません', enabled: false }
  // 一覧を覚えていなければ、押したときに読んでから切り替える
  if (hosts === null) return { title: `このサイト（${host}）を映さない・映すを切り替える`, enabled: true }
  return { title: hosts.includes(host) ? `このサイト（${host}）を映す` : `このサイト（${host}）を映さない`, enabled: true }
}

/** いま前に出ているタブに合わせて、右クリックの項目の名前を変える（タブの切り替え・URLの変化・一覧の変化のたびに呼ぶ） */
export const refreshSiteMenu = async (api: ControllerApi): Promise<void> => {
  const tab = await api.activeTab()
  await api.showSiteMenu(describeSiteMenu(tab?.url, await api.knownBlockedHosts()))
}

/**
 * 一覧が変わったことを覚え、映しているタブにすぐ反映する（いま映っているページを照合し直し、止める・送り直す）。
 *
 * @returns 映しているタブの表示を変えたなら true（呼び出し側は、登録した・外したことの表示を重ねない）
 */
const applyBlockedHosts = async (hosts: readonly string[], api: ControllerApi): Promise<boolean> => {
  await api.rememberBlockedHosts(hosts)
  await refreshSiteMenu(api)
  const state = await api.capturing()
  if (state === null) return false
  const blocked = isBlockedUrl(state.url, hosts)
  if (blocked && state.pausedAt === null) {
    await pauseAt(state, state.url, api)
    return true
  }
  if (!blocked && state.pausedAt !== null) {
    await resumeAt(state, state.url, api)
    return true
  }
  return false
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
  await api.rememberBlockedHosts(blockedHosts)
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
  await api.remember({ tabId: tab.id, url: tab.url, pausedAt: null })
  await api.show(CAPTURING)
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
  const hosts = await api.knownBlockedHosts()
  if (hosts === null) {
    // 映し始めるときに覚えたはずの一覧が無い。照合できないまま映し続けるのは危険なので止める
    await stopWith('映さないサイトの一覧が分からなくなったので映すのをやめました。もう一度押してください', api)
    return
  }
  if (isBlockedUrl(navigation.url, hosts)) {
    await pauseAt(state, navigation.url, api)
    return
  }
  if (!navigation.committed) return
  if (state.pausedAt === null) {
    await api.remember({ ...state, url: navigation.url })
    return
  }
  await resumeAt(state, navigation.url, api)
}

/**
 * ボタンの右クリックで、そのタブのサイトを映さないサイトに登録する。登録済みなら一覧から外す。
 *
 * どちらにするかは、項目の名前を決めたのと同じ「覚えている一覧」で決める（名前と違う操作をしないため）。覚えていなければ読んでから決める。
 * 手で打たせないので、登録できるのはいま開いているタブのホスト名だけである（手で入力するのは設定ページ）。
 */
export const handleSiteMenuClick = async (tab: ClickedTab, api: ControllerApi): Promise<void> => {
  const host = tab.url === undefined ? null : hostOfPageUrl(tab.url)
  if (host === null) {
    await api.show({ kind: 'problem', message: NOT_A_SITE })
    return
  }
  let hosts = await api.knownBlockedHosts()
  if (hosts === null) {
    try {
      hosts = await api.loadBlockedHosts()
    } catch (error) {
      await api.show({ kind: 'problem', message: `映さないサイトの一覧を読めないので切り替えられません: ${reasonOf(error)}` })
      return
    }
  }
  const registered = hosts.includes(host)
  let next: string[]
  try {
    next = registered ? await api.removeBlockedHost(host) : await api.addBlockedHost(host)
  } catch (error) {
    await api.show({ kind: 'problem', message: `${registered ? '映すサイトに戻せませんでした' : '映さないサイトに登録できませんでした'}: ${reasonOf(error)}` })
    return
  }
  const changedCapture = await applyBlockedHosts(next, api)
  // 映しているなら、映している状態の表示を残す（登録したことは右クリックの項目の名前で分かる）
  if (changedCapture || (await api.capturing()) !== null) return
  await api.show({ kind: registered ? 'unregistered' : 'registered', host })
}

/**
 * 拡張の設定ページからの頼み（一覧・追加・削除）に応じる。一覧が変わったら映しているタブにもすぐ反映する。
 *
 * 注意: 失敗は投げずに理由を返す（設定ページがそのまま画面に出す）。ホスト名の形の検証は Worker が持つ。
 */
export const handleSettingsRequest = async (request: SettingsRequest, api: ControllerApi): Promise<SettingsReply> => {
  let hosts: string[]
  try {
    switch (request.type) {
      case 'list':
        hosts = await api.loadBlockedHosts()
        break
      case 'add':
        hosts = await api.addBlockedHost(request.host)
        break
      case 'remove':
        hosts = await api.removeBlockedHost(request.host)
        break
    }
  } catch (error) {
    return { ok: false, message: reasonOf(error) }
  }
  await applyBlockedHosts(hosts, api)
  return { ok: true, hosts }
}

/** offscreen document に範囲を送らせる。送れなければボタンで知らせる */
const sendCrop = async (crop: TabCrop | null, api: ControllerApi): Promise<void> => {
  try {
    await api.setCrop(crop)
  } catch (error) {
    await api.show({ kind: 'problem', message: `映す範囲を変えられませんでした: ${reasonOf(error)}` })
  }
}

/** ボタンの右クリック「映す範囲を選ぶ」。映しているタブでだけ、範囲を選ぶ画面を出す */
export const handlePickAreaClick = async (tab: ClickedTab, api: ControllerApi): Promise<void> => {
  const state = await api.capturing()
  if (state === null) {
    await api.show({ kind: 'problem', message: 'タブを映していません。映したいタブでボタンを押してから、範囲を選んでください' })
    return
  }
  // 範囲は映しているタブの見た目に対する割合なので、ほかのタブの上では選ばせない
  if (tab.id !== state.tabId) {
    await api.show({ kind: 'problem', message: '映す範囲は、映しているタブを開いて選んでください' })
    return
  }
  try {
    await api.pickArea(state.tabId)
  } catch (error) {
    await api.show({ kind: 'problem', message: `このページでは範囲を選べません: ${reasonOf(error)}` })
  }
}

/** 範囲を選ぶ画面で範囲が決まったら、offscreen document に送らせる */
export const handleAreaPicked = async (picked: PickedArea, api: ControllerApi): Promise<void> => {
  const state = await api.capturing()
  // 選んでいるあいだに別のタブへ切り替えた・止めたなら、その範囲は今の映像に合わない
  if (state?.tabId !== picked.tabId) {
    await api.show({ kind: 'problem', message: '範囲を選んでいるあいだに映すタブが変わったので、選んだ範囲は使いませんでした' })
    return
  }
  await sendCrop(picked.crop, api)
}

/** ボタンの右クリック「範囲を外す」。タブ全体を映す */
export const handleClearAreaClick = async (api: ControllerApi): Promise<void> => {
  if ((await api.capturing()) === null) {
    await api.show({ kind: 'problem', message: 'タブを映していないので、外す範囲はありません' })
    return
  }
  await sendCrop(null, api)
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
      return { text: '', color: null, title: `${state.host} を映さないサイトに登録しました（もう一度右クリックすると外せます。一覧は拡張の設定で見られます）` }
    case 'unregistered':
      return { text: '', color: null, title: `${state.host} を映さないサイトから外しました` }
    case 'capturing': {
      if (state.warning !== null) return { text: PROBLEM_BADGE, color: PROBLEM_COLOR, title: `${state.warning}（${HOW_TO_STOP}）` }
      const viewers =
        state.viewers > 0 ? `合成ページ ${state.viewers} か所` : '合成ページとまだつながっていません。OBSに合成ページを読み込み、素材「タブの映像」を置いてください'
      return { text: CAPTURING_BADGE, color: CAPTURING_COLOR, title: `映しています（${viewers}）。${HOW_TO_STOP}` }
    }
  }
}
