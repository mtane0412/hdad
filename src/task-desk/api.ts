/**
 * 作業机の読み出し（オーバーレイ用API の呼び出し）
 *
 * 合成ページ（overlay/stage/index.html）はOBSに載せるページなのでログインを持たず、オーバーレイ用キー（URLの ?key=）で
 * Worker に受け付けてもらう。作業机が変わるたびに WebSocket（TASK_DESK_SOCKET_PATH）で丸ごと押し出してもらい、ここで読むのは
 * 開いたとき・つなぎ直したとき・定期的に取り戻す一覧だけである。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 想定した形でなければエラーにする（Fail-Fast）。黙って空の一覧にすると、Workerの作りが変わって行が届かなくなっても、
 * 配信中は「まだ誰も宣言していない」と見分けが付かない。
 */
import { createCaller } from '../core/api'
import { readTaskDeskSnapshot, type TaskDeskSnapshot } from './entry'

const PATH = '/api/overlay/task-desk'

/** 変わった作業机を押し出してもらう WebSocket のパス */
export const TASK_DESK_SOCKET_PATH = '/api/overlay/task-desk/socket'

/** 一度もつながらないまま閉じたときに出す、いちばんありそうな原因 */
export const TASK_DESK_SOCKET_HINT = '作業机の配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

export interface TaskDeskApi {
  /**
   * いまの配信の作業机を読む。
   *
   * @returns 並べる順の行（未完了が上）と、作業した時間の合計。配信していなければ空の一覧と null の合計
   */
  read(): Promise<TaskDeskSnapshot>
}

/**
 * 作業机の読み出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createTaskDeskApi = (fetchImpl: typeof fetch, key: string): TaskDeskApi => {
  const call = createCaller(fetchImpl)
  const path = `${PATH}?key=${encodeURIComponent(key)}`

  return {
    read: async () => readTaskDeskSnapshot(await call(path)),
  }
}
