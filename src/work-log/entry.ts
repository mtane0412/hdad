/**
 * 作業ログの1行の形と、行の重ね方
 *
 * 合成ページの素材「作業ログ」は、その配信の開発の出来事（コミット・PR のマージ）と章の見出しを時刻つきで並べる（issue #211）。
 * 行は2つの道から届く。開いたとき・つなぎ直したとき・定期的に読む一覧（api.ts）と、増えた1行の押し出し（WebSocket）である。
 * どちらから届いても同じ id の行は1行に重ね、新しい順に上限まで持つ（mergeEntries）。通信もDOMも持たないので、ここだけをテストできる。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、形はここで定義する（worker/work-log.ts の WorkLogEntry と合わせる）。
 * 想定した形でなければ投げる（Fail-Fast）。知らない種類の行を黙って出すと、機械の作った行と実際の出来事を取り違えて映しうる。
 */
import { isRecord } from '../core/api'

/** 1行の種類。chapter だけが機械（LLM）の作ったもので、commit・merge は実際に起きた出来事 */
export const WORK_LOG_KINDS = ['commit', 'merge', 'chapter'] as const

export type WorkLogKind = (typeof WORK_LOG_KINDS)[number]

/** 作業ログの1行 */
export interface WorkLogEntry {
  /** 押し出しと読み直しで同じ行を重ねるための識別子 */
  readonly id: string
  readonly kind: WorkLogKind
  /** 並べる時刻（ISO 8601） */
  readonly at: string
  /** 出す1行 */
  readonly text: string
}

/** 持っておく行数の上限。worker/work-log.ts の WORK_LOG_LIMIT と揃える（配信画面の箱に収まるのはこれより少ない） */
export const WORK_LOG_LIMIT = 20

const isWorkLogKind = (value: unknown): value is WorkLogKind => WORK_LOG_KINDS.some((kind) => kind === value)

/** 作業ログの1行として読めるか */
export const isWorkLogEntry = (value: unknown): value is WorkLogEntry =>
  isRecord(value) && typeof value.id === 'string' && isWorkLogKind(value.kind) && typeof value.at === 'string' && typeof value.text === 'string'

/**
 * WebSocket で押し出された文字列を、作業ログの1行として読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseWorkLogEntry = (payload: string): WorkLogEntry => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された作業ログの1行をJSONとして読めません')
  }
  if (!isWorkLogEntry(body)) throw new Error('押し出された作業ログの1行が想定した形ではありません')
  return { id: body.id, kind: body.kind, at: body.at, text: body.text }
}

/**
 * 持っている行に届いた行を重ね、新しい順に上限まで並べる。
 *
 * 同じ id の行は届いたほうで置き換える（GitHub の再送や、読み直しと押し出しの行き違いで2行にしない）。
 * 時刻が同じなら id で並びを決める（Worker の worker/work-log-store.ts と同じ並べ方）。
 */
export const mergeEntries = (current: readonly WorkLogEntry[], incoming: readonly WorkLogEntry[], limit: number): WorkLogEntry[] => {
  const byId = new Map(current.map((entry) => [entry.id, entry]))
  for (const entry of incoming) byId.set(entry.id, entry)
  return [...byId.values()].sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id)).slice(0, limit)
}

/** 時刻を「時:分」にする。配信画面の時計と同じく、ブラウザ（OBS を動かしている配信者の機械）の時刻で出す */
export const clockOf = (at: string): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
