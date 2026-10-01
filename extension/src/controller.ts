/**
 * 拡張のボタンが押されたときの手順と、ボタンの表示
 *
 * 映したいタブでボタン（ショートカットの既定は Alt+Shift+T）が押されたら、そのタブのストリームIDを取り、
 * offscreen document に取り込ませる。**映しているタブでもう一度押されたら止める**。別のタブで押されたら、そのタブに切り替える。
 *
 * Chrome の API は ControllerApi として外から受け取り、ここは「押されたら何をするか・何を表示するか」だけを決める（テストのため）。
 * 映しているタブは api.remember で覚える（サービスワーカーは眠ると変数を失うので、chrome.storage.session に置く）。
 *
 * 注意: IDを取れない・取り込めないときは、黙って何もしないのではなくバッジ「!」で知らせ、理由はボタンの説明に出す。
 */
import { reasonOf } from './guards'
import type { OffscreenEvent } from './offscreen-event'

/** ボタンの状態 */
export type BadgeState =
  | { kind: 'idle' }
  | { kind: 'capturing'; viewers: number; warning: string | null }
  | { kind: 'problem'; message: string }

/** この手順が使う Chrome の機能 */
export interface ControllerApi {
  /** いま映しているタブ（映していなければ null） */
  capturingTabId(): Promise<number | null>
  /** 映しているタブを覚える（null は映していない） */
  remember(tabId: number | null): Promise<void>
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
  /** ボタンの表示を変える */
  show(state: BadgeState): Promise<void>
}

/** 押されたタブ */
export interface ClickedTab {
  id?: number
}

const IDLE: BadgeState = { kind: 'idle' }

/** 押されたタブを映す。映しているタブなら止める */
export const handleClick = async (tab: ClickedTab, api: ControllerApi): Promise<void> => {
  if (tab.id === undefined) {
    await api.show({ kind: 'problem', message: '映すタブを特定できませんでした。映したいタブを開いてから押してください' })
    return
  }
  const capturing = await api.capturingTabId()
  if (capturing === tab.id) {
    try {
      await api.stopCapture()
    } finally {
      // 止めるのに失敗しても記録は消す。残すと次に押したときも止めようとし続け、映し始められなくなる
      await api.remember(null)
    }
    await api.show(IDLE)
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
  await api.remember(tab.id)
  await api.show({ kind: 'capturing', viewers: 0, warning: null })
}

/** offscreen document からの知らせを、ボタンの表示に反映する */
export const handleOffscreenEvent = async (event: OffscreenEvent, api: ControllerApi): Promise<void> => {
  // 止めた直後に、止める前の状態が遅れて届くことがある。映していないなら表示に出さない
  if ((await api.capturingTabId()) === null) return
  switch (event.type) {
    case 'state':
      await api.show({ kind: 'capturing', viewers: event.viewers, warning: event.warning })
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
    case 'capturing': {
      if (state.warning !== null) return { text: PROBLEM_BADGE, color: PROBLEM_COLOR, title: `${state.warning}（${HOW_TO_STOP}）` }
      const viewers =
        state.viewers > 0 ? `合成ページ ${state.viewers} か所` : '合成ページとまだつながっていません。OBSに合成ページを読み込み、素材「タブの映像」を置いてください'
      return { text: CAPTURING_BADGE, color: CAPTURING_COLOR, title: `映しています（${viewers}）。${HOW_TO_STOP}` }
    }
  }
}
