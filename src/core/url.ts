/**
 * 素材のパラメータのクエリ文字列への直列化
 *
 * 合成オーバーレイの構成（src/overlay/form.ts）が持つ素材ごとのパラメータを、合成ページ
 * （overlay/stage/index.html）が URLSearchParams として読める形にする。
 * URLを短く保つため、既定値のままのパラメータは出力しない。
 */
import type { ParamSchema, ParamSpec, ParamValues } from './params'

const stripHash = (color: string): string => color.replace(/^#/, '')

const serialize = (spec: ParamSpec, value: number | string | boolean | readonly string[]): string => {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // 自由な文字列は & や = を含みうるため、これだけはエンコードする
  if (spec.type === 'string') return encodeURIComponent(String(value))
  if (typeof value === 'string') return stripHash(value)
  return value.map(stripHash).join(',')
}

/**
 * 既定値から変えたパラメータだけを、クエリ文字列（先頭の ? なし）にする。
 *
 * @param schema 素材のパラメータ宣言
 * @param values 現在のパラメータ値
 * @returns 例: `speed=2&colors=ffffff`（すべて既定値なら空文字）
 * @throws スキーマにあるパラメータの値が無い場合
 */
export const serializeParams = <T extends ParamSchema>(schema: T, values: ParamValues<T>): string => {
  const pairs: string[] = []
  for (const [name, spec] of Object.entries(schema)) {
    const value = values[name]
    if (value === undefined) throw new Error(`パラメータ「${name}」の値がありません`)
    const serialized = serialize(spec, value)
    if (serialized !== serialize(spec, spec.default)) pairs.push(`${name}=${serialized}`)
  }
  // 文字列以外の値は数値・16進数・カンマ・true / false だけなので、読みやすさを優先してエンコードせずに連結する
  return pairs.join('&')
}
