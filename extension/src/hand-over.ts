/**
 * 拡張がタブのストリームIDを送り手のページへ渡す手順
 *
 * 映したいタブでショートカットかボタンが押されたら、送り手のページ（HDAD の /tab/）を受け取り先にして
 * chrome.tabCapture.getMediaStreamId でIDを取り、送り手のページの URL の # に入れて渡す（issue #164）。
 * 取り込みと送信は送り手のページが配信者のセッションで行うので、拡張はログインも鍵も持たない。
 *
 * # で渡すのは、フォークした人ごとに HDAD のドメインが違い、拡張がドメインを前もって知らなくても済むためである
 * （ページへスクリプトを差し込むにはドメインごとの権限が要る）。# だけを書き換えてもページは読み込み直されない。
 * IDは受け取り先のタブでしか使えないので、URL に出ても他人には使えない。
 *
 * Chrome の API は ExtensionApi として外から受け取り、ここは「どのタブへ渡すか・いつ知らせるか」だけを決める（テストのため）。
 *
 * 注意: 送り手のページが見つからない・複数ある・取り込めないときは、黙って何もしないのではなく拡張のバッジで知らせる。
 */
import { buildStreamHash } from '../../src/tab/signal'

/** 送り手のページのパス */
const SENDER_PATH = '/tab/'

/** 拡張から見たタブ1枚 */
export interface TabInfo {
  id?: number
  title?: string
  url?: string
}

/** この手順が使う Chrome の機能 */
export interface ExtensionApi {
  /** 開いているタブすべて */
  listTabs(): Promise<readonly TabInfo[]>
  /** targetTabId のタブを、consumerTabId のタブで取り込むためのIDを取る */
  getMediaStreamId(targetTabId: number, consumerTabId: number): Promise<string>
  /** タブの URL を書き換える（# だけを変えれば読み込み直されない） */
  updateTabUrl(tabId: number, url: string): Promise<void>
  /** 拡張のバッジで知らせる（null は知らせを消す） */
  showProblem(message: string | null): Promise<void>
}

/** パスが /tab/ のタブか（ドメインは問わない。フォークした人ごとに違うため） */
const isSenderTab = (tab: TabInfo): boolean => {
  if (tab.url === undefined) return false
  try {
    return new URL(tab.url).pathname === SENDER_PATH
  } catch {
    return false
  }
}

/** URL から # を取り除く（前に渡したIDが残っていても置き換えるため） */
const withoutHash = (url: string): string => {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
}

/** 押されたタブ（target）を映すよう、送り手のページへIDを渡す */
export const handOverTab = async (target: TabInfo, api: ExtensionApi): Promise<void> => {
  const senders = (await api.listTabs()).filter(isSenderTab)
  const [sender] = senders
  if (sender?.id === undefined || sender.url === undefined) {
    await api.showProblem('HDAD の「タブの映像」のページ（/tab/）を開いてから押してください')
    return
  }
  if (senders.length > 1) {
    await api.showProblem('「タブの映像」のページ（/tab/）が2つ以上開かれています。1つだけにしてください')
    return
  }
  if (target.id === undefined) {
    await api.showProblem('映すタブを特定できませんでした。映したいタブを開いてから押してください')
    return
  }
  if (target.id === sender.id) {
    await api.showProblem('「タブの映像」のページ自身は映せません。映したいタブを開いてから押してください')
    return
  }

  let streamId: string
  try {
    streamId = await api.getMediaStreamId(target.id, sender.id)
  } catch (error) {
    await api.showProblem(`このタブは映せません: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  // 題名の無いページもあるので、そのときは空にする（送り手のページの表示が空になるだけで、映すことはできる）
  await api.updateTabUrl(sender.id, `${withoutHash(sender.url)}${buildStreamHash({ streamId, title: target.title ?? '' })}`)
  await api.showProblem(null)
}
