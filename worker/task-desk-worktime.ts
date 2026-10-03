/**
 * 作業した時間の合計と、差し込み語 {worktime}
 *
 * 作業机の宣言（worker/task-desk-store.ts の task_declarations）から、配信でみんなが作業した時間の合計と人数を出す（issue #209）。
 * 「今日この配信でみんな合わせて 14時間32分 作業しました」と見せて、ひとりで作業しているのではない感覚を数字で出すためである。
 * - 1件の宣言の時間は「宣言から完了まで」。完了していない宣言は、打ち切る時刻（配信中ならいま、終わった配信なら終わった時刻）までを数える
 * - !task を打ち直す前の宣言の時間は、行の priorWorkMs に足し込んである（1人1行のまま、打ち直しても時間が消えないように）
 * - 配信者のポモドーロの作業時間は含めない。配信者も !task すれば視聴者と同じく数えられる
 *
 * 通信も時刻も持たない純粋な関数だけを置く。チャットコマンドの応答文の {worktime} も、{bgm}（bgm-credit.ts）と同じくここで置き換える。
 *
 * 注意: 宣言が1件も無い配信は 0 ではなく null にする（方針6）。誰も宣言しなかった配信で「0分」と出すと、
 * 「誰も作業しなかった」と「作業机を使っていなかった」が同じ見た目になるためである。
 */

/** 合計に使う、宣言の1行 */
export interface WorkTimeRow {
  /** いまの宣言をした時刻（ISO 8601） */
  readonly declaredAt: string
  /** 完了した時刻（ISO 8601）。未完了なら null */
  readonly doneAt: string | null
  /** 打ち直す前の宣言で作業した時間の合計（ミリ秒） */
  readonly priorWorkMs: number
}

/** 配信でみんなが作業した時間の合計 */
export interface WorkTime {
  /** 宣言した人数（完了した人も含む） */
  readonly people: number
  /** 作業した時間の合計（ミリ秒） */
  readonly totalMs: number
  /** いま作業中（未完了）の人数。合成ページは合計にこの人数ぶんの経過時間を足して、読み直さずに時間を進める */
  readonly working: number
}

/** 応答文に書く差し込み語 */
export const WORK_TIME_PLACEHOLDER = '{worktime}'

/** 宣言の記録が無い（配信していない・まだ誰も宣言していない）ときに {worktime} へ入れる文言 */
export const NO_WORK_TIME = 'まだ作業の記録がありません'

/**
 * {worktime} が置き換わる文の最大の長さ。応答文の長さの検証（bot-config.ts）が、保存の時点で見積もるのに使う。
 * 「24000時間59分（1000人）」（1000人が24時間ずつ作業した配信）でも17文字なので、余裕を持たせて決めてある
 */
export const MAX_WORK_TIME_TEXT_LENGTH = 30

const MS_PER_MINUTE = 60 * 1000
const MINUTES_PER_HOUR = 60

/**
 * 宣言の行から、作業した時間の合計と人数を出す。
 *
 * @param until 打ち切る時刻（ミリ秒）。配信中ならいま、終わった配信なら終わった時刻。これより後の完了もこの時刻で数える
 * @returns 宣言が1件も無ければ null
 */
export const sumWorkTime = (rows: readonly WorkTimeRow[], until: number): WorkTime | null => {
  if (rows.length === 0) return null
  const totalMs = rows.reduce((sum, row) => {
    const end = row.doneAt === null ? until : Math.min(Date.parse(row.doneAt), until)
    // 配信の区切りが後から閉じられたときなど、宣言が打ち切る時刻より後になることがあるので、マイナスにはしない
    return sum + row.priorWorkMs + Math.max(0, end - Date.parse(row.declaredAt))
  }, 0)
  return { people: rows.length, totalMs, working: rows.filter((row) => row.doneAt === null).length }
}

/**
 * 合計を「14時間32分（5人）」の形の文にする。端数の秒は切り捨てる。
 *
 * @param workTime 合計。記録が無ければ null
 * @throws 文が MAX_WORK_TIME_TEXT_LENGTH を超える場合（保存の時点で見積もった長さを超えて送らないため）
 */
export const workTimeText = (workTime: WorkTime | null): string => {
  if (workTime === null) return NO_WORK_TIME
  const minutes = Math.floor(workTime.totalMs / MS_PER_MINUTE)
  const hours = Math.floor(minutes / MINUTES_PER_HOUR)
  const duration = hours === 0 ? `${minutes}分` : `${hours}時間${minutes % MINUTES_PER_HOUR}分`
  const text = `${duration}（${workTime.people}人）`
  if (text.length > MAX_WORK_TIME_TEXT_LENGTH) {
    throw new Error(`作業した時間の合計の文が${text.length}文字あり、上限（${MAX_WORK_TIME_TEXT_LENGTH}文字）を超えています: ${text}`)
  }
  return text
}

/**
 * 文言の差し込み語 {worktime} を、作業した時間の合計に置き換える。
 *
 * 注意: 置き換える値は関数で渡す（文字列で渡すと `$&` などが置換の特殊な指定として解釈されるため。stream-summary.ts と同じ）。
 */
export const fillWorkTime = (text: string, workTime: WorkTime | null): string =>
  text.replaceAll(WORK_TIME_PLACEHOLDER, () => workTimeText(workTime))
