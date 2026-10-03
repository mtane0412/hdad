/**
 * 作業ログの読み出し（オーバーレイ用API の呼び出し）
 *
 * 合成ページ（overlay/stage/index.html）はOBSに載せるページなのでログインを持たず、オーバーレイ用キー（URLの ?key=）で
 * Worker に受け付けてもらう。増えた1行は WebSocket（WORK_LOG_SOCKET_PATH）で押し出してもらい、ここで読むのは
 * 開いたとき・つなぎ直したとき・定期的に取り戻す一覧だけである。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 想定した形でなければエラーにする（Fail-Fast）。黙って空の一覧にすると、Workerの作りが変わって行が届かなくなっても、
 * 配信中は「まだ何も起きていない」と見分けが付かない。
 */
import { createCaller, readList } from '../core/api'
import { isWorkLogEntry, type WorkLogEntry } from './entry'

const PATH = '/api/overlay/work-log'

/** 増えた1行を押し出してもらう WebSocket のパス */
export const WORK_LOG_SOCKET_PATH = '/api/overlay/work-log/socket'

/** 一度もつながらないまま閉じたときに出す、いちばんありそうな原因 */
export const WORK_LOG_SOCKET_HINT = '作業ログの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

export interface WorkLogApi {
  /**
   * いまの配信の作業ログを読む。
   *
   * @returns 新しい順の行。配信していなければ空の一覧
   */
  read(): Promise<WorkLogEntry[]>
}

/**
 * 作業ログの読み出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createWorkLogApi = (fetchImpl: typeof fetch, key: string): WorkLogApi => {
  const call = createCaller(fetchImpl)
  const path = `${PATH}?key=${encodeURIComponent(key)}`

  return {
    read: async () => readList(await call(path), 'entries', isWorkLogEntry),
  }
}
