/**
 * URLクエリパラメータの解析
 *
 * 背景ごとに宣言したスキーマ（ParamSchema）に沿って URLSearchParams を型付きの値へ変換する。
 * - 省略されたパラメータはスキーマに明記した既定値になる
 * - 不正な値・範囲外の値・未対応のパラメータ名は、既定値へ黙って戻さず ParamError にする（Fail-Fast）
 * - 色はURLで「#」がフラグメント扱いになるため、「#」なしの16進数（ff0080 / f08）で受け取る
 * - 真偽値は true / false だけを受け取る
 * - 文字列はスキーマに書いた書式（正規表現）に合うものだけを受け取る
 */

/** 数値パラメータの宣言 */
export interface NumberParamSpec {
  readonly type: 'number'
  readonly default: number
  readonly min: number
  readonly max: number
  /** true の場合は整数のみ受け付ける */
  readonly integer?: boolean
  readonly description: string
}

/** 単色パラメータの宣言 */
export interface ColorParamSpec {
  readonly type: 'color'
  readonly default: string
  /** true の場合は transparent（透過）も受け付ける */
  readonly allowTransparent?: boolean
  readonly description: string
}

/** カンマ区切りの配色パラメータの宣言 */
export interface ColorsParamSpec {
  readonly type: 'colors'
  readonly default: readonly string[]
  readonly minCount: number
  readonly maxCount: number
  readonly description: string
}

/** 真偽値パラメータの宣言（URLでは true / false で指定する） */
export interface BooleanParamSpec {
  readonly type: 'boolean'
  readonly default: boolean
  readonly description: string
}

/**
 * 文字列パラメータの宣言
 *
 * 注意: 既定値は書式の確認対象にしない。「未指定」を空文字で表したい場合は default を '' にする。
 */
export interface StringParamSpec {
  readonly type: 'string'
  readonly default: string
  /** 値の全体が合うべき書式（^ と $ で全体を囲むこと） */
  readonly pattern: RegExp
  /** 書式に合わなかったときにエラーで示す指定例 */
  readonly example: string
  readonly description: string
}

export type ParamSpec =
  | NumberParamSpec
  | ColorParamSpec
  | ColorsParamSpec
  | BooleanParamSpec
  | StringParamSpec
export type ParamSchema = Readonly<Record<string, ParamSpec>>

type ParamValue<S extends ParamSpec> = S extends NumberParamSpec
  ? number
  : S extends ColorParamSpec | StringParamSpec
    ? string
    : S extends BooleanParamSpec
      ? boolean
      : readonly string[]

/** スキーマから導かれる解析結果の型 */
export type ParamValues<T extends ParamSchema> = { readonly [K in keyof T]: ParamValue<T[K]> }

/**
 * パラメータ指定の誤りを表すエラー
 *
 * 注意: 問題点は最初の1件で止めず、すべて problems に集めてから投げる。
 */
export class ParamError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`URLパラメータに問題があります:\n${problems.join('\n')}`)
    this.name = 'ParamError'
    this.problems = problems
  }
}

/** 解析中に見つかった1件の問題。値と区別するために専用クラスで表す */
class Problem {
  constructor(readonly message: string) {}
}

const HEX_COLOR = /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
// Number() は空文字や空白を 0 と解釈してしまうため、先に書式を確認する
const DECIMAL_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/

const parseColor = (raw: string, allowTransparent: boolean): string | Problem => {
  if (allowTransparent && raw === 'transparent') return 'transparent'
  if (!HEX_COLOR.test(raw)) {
    const examples = allowTransparent ? 'ff0080, f08, transparent' : 'ff0080, f08'
    return new Problem(`「${raw}」は色として読めません（例: ${examples}）`)
  }
  const hex = raw.toLowerCase()
  // 3桁表記（f08）は各桁を重ねて6桁（ff0088）に展開する
  const sixDigits = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
  return `#${sixDigits}`
}

const parseNumber = (raw: string, spec: NumberParamSpec): number | Problem => {
  if (!DECIMAL_NUMBER.test(raw)) return new Problem(`「${raw}」は数値ではありません`)
  const value = Number(raw)
  if (spec.integer && !Number.isInteger(value)) return new Problem(`${value} は整数ではありません`)
  if (value < spec.min || value > spec.max) {
    return new Problem(`${value} は範囲外です（${spec.min}〜${spec.max}）`)
  }
  return value
}

const parseColors = (raw: string, spec: ColorsParamSpec): readonly string[] | Problem => {
  const colors: string[] = []
  for (const part of raw.split(',')) {
    const color = parseColor(part, false)
    if (color instanceof Problem) return color
    colors.push(color)
  }
  if (colors.length < spec.minCount || colors.length > spec.maxCount) {
    return new Problem(
      `色の数は ${spec.minCount}〜${spec.maxCount} 個で指定してください（${colors.length} 個でした）`,
    )
  }
  return colors
}

// 1 / yes / on などの別表記を受け付けると指定方法が曖昧になるため、true / false だけを認める
const parseBoolean = (raw: string): boolean | Problem => {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return new Problem(`「${raw}」は真偽値として読めません（true または false）`)
}

const parseString = (raw: string, spec: StringParamSpec): string | Problem =>
  spec.pattern.test(raw) ? raw : new Problem(`「${raw}」は書式に合いません（例: ${spec.example}）`)

const parseValue = (raw: string, spec: ParamSpec) => {
  switch (spec.type) {
    case 'number':
      return parseNumber(raw, spec)
    case 'color':
      return parseColor(raw, spec.allowTransparent ?? false)
    case 'colors':
      return parseColors(raw, spec)
    case 'boolean':
      return parseBoolean(raw)
    case 'string':
      return parseString(raw, spec)
  }
}

/**
 * スキーマに沿ってクエリパラメータを解析する。
 *
 * @param schema 背景が受け付けるパラメータの宣言
 * @param searchParams 解析対象（通常は location.search から作る）
 * @returns 省略分を既定値で埋めた、型付きのパラメータ値
 * @throws ParamError 不正な値・未対応の名前・重複指定が1件でもある場合
 */
export const parseParams = <T extends ParamSchema>(
  schema: T,
  searchParams: URLSearchParams,
): ParamValues<T> => {
  const problems: string[] = []
  const values: Record<string, unknown> = {}

  for (const name of new Set(searchParams.keys())) {
    if (!Object.hasOwn(schema, name)) {
      problems.push(`${name}: 未対応のパラメータです（使用可能: ${Object.keys(schema).join(', ')}）`)
    }
  }

  for (const [name, spec] of Object.entries(schema)) {
    const raws = searchParams.getAll(name)
    const [raw] = raws
    if (raw === undefined) {
      values[name] = spec.default
    } else if (raws.length > 1) {
      problems.push(`${name}: 複数回指定されています`)
    } else {
      const parsed = parseValue(raw, spec)
      if (parsed instanceof Problem) problems.push(`${name}: ${parsed.message}`)
      else values[name] = parsed
    }
  }

  if (problems.length > 0) throw new ParamError(problems)
  // values はスキーマの全キーを spec.type に対応する型で埋めているが、
  // 動的に組み立てるため型システムでは表現できず、ここでのみ型アサーションを使う
  return values as ParamValues<T>
}
