/**
 * 作業机の1行の形と、完了したばかりの見分け方
 *
 * 合成ページの素材「作業机」は、視聴者が !task で宣言した作業を1人1行で並べる（issue #207）。
 * 作業机は2つの道から届く。開いたとき・つなぎ直したとき・定期的に読む一覧（api.ts）と、変わるたびに丸ごと届く押し出し（WebSocket）である。
 * どちらも作業机の丸ごとなので、届いたもので置き換えればよい。通信もDOMも持たないので、ここだけをテストできる。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、形はここで定義する（worker/task-desk.ts の TaskDeskEntry と合わせる）。
 * 想定した形でなければ投げる（Fail-Fast）。
 */
import { isRecord, readList } from '../core/api'

/** 作業机の1行 */
export interface TaskDeskEntry {
  /** 宣言した視聴者のユーザーID（行を見分けるのに使う） */
  readonly userId: string
  /** 出す名前（宣言したときの表示名） */
  readonly name: string
  readonly task: string
  /** 宣言した時刻（ISO 8601） */
  readonly declaredAt: string
  /** 完了した時刻（ISO 8601）。未完了なら null */
  readonly doneAt: string | null
}

/** 作業机の1行として読めるか */
export const isTaskDeskEntry = (value: unknown): value is TaskDeskEntry =>
  isRecord(value) &&
  typeof value.userId === 'string' &&
  typeof value.name === 'string' &&
  typeof value.task === 'string' &&
  typeof value.declaredAt === 'string' &&
  (typeof value.doneAt === 'string' || value.doneAt === null)

/**
 * WebSocket で押し出された文字列を、作業机の行の一覧として読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseTaskDeskSnapshot = (payload: string): TaskDeskEntry[] => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された作業机をJSONとして読めません')
  }
  return readList(body, 'entries', isTaskDeskEntry)
}

/**
 * 映していた行が、いま完了したばかりか（祝うかどうか）。
 *
 * 祝うのは、同じ宣言（宣言した時刻が同じ）が未完了から完了に変わったときだけにする。開いたときにもう完了している人や、
 * 打ち直して別の宣言になった人を祝わないためである。
 *
 * @param previous 同じ人について、前に映していた行。映していなければ undefined
 */
export const justCompleted = (previous: TaskDeskEntry | undefined, next: TaskDeskEntry): boolean =>
  previous !== undefined && previous.declaredAt === next.declaredAt && previous.doneAt === null && next.doneAt !== null
