/**
 * 作業机の1行の形と、完了したばかりの見分け方
 *
 * 合成ページの素材「作業机」は、視聴者が !task で宣言した作業を1人1行で並べる（issue #207）。
 * 作業机は2つの道から届く。開いたとき・つなぎ直したとき・定期的に読む一覧（api.ts）と、変わるたびに丸ごと届く押し出し（WebSocket）である。
 * どちらも作業机の丸ごとなので、届いたもので置き換えればよい。通信もDOMも持たないので、ここだけをテストできる。
 * 作業机には、配信でみんなが作業した時間の合計も添えて届く（issue #209）。合計は読んだ時刻のものなので、
 * 映すときに「読んでからの経過時間 × 作業中の人数」を足して進める（読み直さなくても時間が進むように）。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、形はここで定義する（worker/task-desk.ts の TaskDeskEntry と合わせる）。
 * 想定した形でなければ投げる（Fail-Fast）。
 */
import { isRecord, readList } from '../core/api'
import { formatDuration } from '../stats/summary'

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

/** 配信でみんなが作業した時間の合計（worker/task-desk.ts の TaskDeskWorkTime と合わせる） */
export interface TaskDeskWorkTime {
  /** 宣言した人数（完了した人も含む） */
  readonly people: number
  /** 読んだ時刻までに作業した時間の合計（ミリ秒） */
  readonly totalMs: number
  /** 読んだ時刻に作業中（未完了）だった人数 */
  readonly working: number
  /** 合計を読んだ時刻（ISO 8601） */
  readonly measuredAt: string
}

/** いまの作業机（並べる行と、作業した時間の合計） */
export interface TaskDeskSnapshot {
  /** 並べる順の行（未完了が上） */
  readonly entries: TaskDeskEntry[]
  /** 配信していない・まだ誰も宣言していなければ null */
  readonly workTime: TaskDeskWorkTime | null
}

/** 作業机の1行として読めるか */
export const isTaskDeskEntry = (value: unknown): value is TaskDeskEntry =>
  isRecord(value) &&
  typeof value.userId === 'string' &&
  typeof value.name === 'string' &&
  typeof value.task === 'string' &&
  typeof value.declaredAt === 'string' &&
  (typeof value.doneAt === 'string' || value.doneAt === null)

const isTaskDeskWorkTime = (value: unknown): value is TaskDeskWorkTime =>
  isRecord(value) &&
  typeof value.people === 'number' &&
  typeof value.totalMs === 'number' &&
  typeof value.working === 'number' &&
  typeof value.measuredAt === 'string'

/**
 * Worker の応答（読み出しと押し出しで同じ形）を、いまの作業机として読む。
 *
 * @throws 想定した形でない場合。合計が無い応答も投げる（黙って合計を隠すと、出なくなったことに気付けないため）
 */
export const readTaskDeskSnapshot = (body: unknown): TaskDeskSnapshot => {
  const entries = readList(body, 'entries', isTaskDeskEntry)
  const workTime: unknown = isRecord(body) ? body.workTime : undefined
  if (!(workTime === null || isTaskDeskWorkTime(workTime))) throw new Error('Workerの応答の workTime が想定した形ではありません')
  return { entries, workTime }
}

/**
 * WebSocket で押し出された文字列を、いまの作業机として読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseTaskDeskSnapshot = (payload: string): TaskDeskSnapshot => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された作業机をJSONとして読めません')
  }
  return readTaskDeskSnapshot(body)
}

/**
 * いまの時刻での作業した時間の合計を「14時間32分（5人）」の形で表す。
 *
 * 読んだ時刻からの経過時間を、作業中の人数ぶん足して進める。合成ページの時計が Worker より遅れていて
 * いまが読んだ時刻より前になっても、合計は減らさない。
 */
export const workTimeText = (workTime: TaskDeskWorkTime, now: number): string => {
  const elapsedMs = Math.max(0, now - Date.parse(workTime.measuredAt))
  return `${formatDuration(workTime.totalMs + workTime.working * elapsedMs)}（${workTime.people}人）`
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
