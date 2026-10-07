/**
 * WebMCP のツールの入力を読む部品
 *
 * 入力の形は各ツールの inputSchema で示すが、ブラウザがそれで検証してから execute を呼ぶとは限らないので、
 * execute でもここの関数で確かめる。受け付けない値は既定値に丸めずに投げ、投げた文面がそのままエージェントに返る
 * （エージェントが直してやり直せるよう、どの入力をどう直せばよいかを書く）。
 *
 * 注意: 値の中身（文言の長さ・ログイン名の形など）の検証は Worker だけが持つ（.claude/rules/implementation.md）。
 *   ここで確かめるのは型と、決まった候補から選ぶ値だけにする。
 */

/** 入力を持たないツールの入力の形 */
export const NO_INPUT = { type: 'object', properties: {} } as const

/** 入力のうち、決まった候補のどれかでなければならない値を読む */
export const readChoice = <T extends string>(input: Record<string, unknown>, key: string, choices: readonly T[]): T => {
  const value = input[key]
  const found = choices.find((choice) => choice === value)
  if (found === undefined) throw new Error(`${key} は ${choices.join('・')} のどれかにしてください`)
  return found
}

/** 入力のうち、真偽値でなければならない値を読む */
export const readBoolean = (input: Record<string, unknown>, key: string): boolean => {
  const value = input[key]
  if (typeof value !== 'boolean') throw new Error(`${key} は true か false にしてください`)
  return value
}

/** 入力のうち、文字列でなければならない値を読む */
export const readString = (input: Record<string, unknown>, key: string): string => {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`${key} は文字列にしてください`)
  return value
}

/** 省いてよい文字列の値を読む。省かれていれば undefined */
export const readOptionalString = (input: Record<string, unknown>, key: string): string | undefined =>
  input[key] === undefined ? undefined : readString(input, key)

/** 省いてよい数の値を読む。省かれていれば undefined */
export const readOptionalNumber = (input: Record<string, unknown>, key: string): number | undefined => {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number') throw new Error(`${key} は数にしてください`)
  return value
}
