/**
 * OBSのブラウザソースに貼る素材URLの組み立て
 *
 * URLを短く保つため、既定値のままのパラメータは出力しない。
 */
import type { ParamSchema, ParamSpec, ParamValues } from '../params'

const stripHash = (color: string): string => color.replace(/^#/, '')

const serialize = (spec: ParamSpec, value: number | string | boolean | readonly string[]): string => {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  // 自由な文字列は & や = を含みうるため、これだけはエンコードする
  if (spec.type === 'string') return encodeURIComponent(String(value))
  if (typeof value === 'string') return stripHash(value)
  return value.map(stripHash).join(',')
}

/**
 * @param galleryUrl ギャラリーページ自身のURL（背景ページは同じ階層の <id>/ にある）
 * @param id 背景ID
 * @param schema 背景のパラメータ宣言
 * @param values 現在のパラメータ値
 * @returns 背景ページの絶対URL
 */
export const buildBackgroundUrl = <T extends ParamSchema>(
  galleryUrl: string,
  id: string,
  schema: T,
  values: ParamValues<T>,
): string => {
  const url = new URL(`${id}/`, galleryUrl)
  const pairs: string[] = []
  for (const [name, spec] of Object.entries(schema)) {
    const value = values[name]
    if (value === undefined) throw new Error(`パラメータ「${name}」の値がありません`)
    const serialized = serialize(spec, value)
    if (serialized !== serialize(spec, spec.default)) pairs.push(`${name}=${serialized}`)
  }
  // 文字列以外の値は数値・16進数・カンマ・true / false だけなので、読みやすさを優先してエンコードせずに連結する
  return pairs.length > 0 ? `${url.href}?${pairs.join('&')}` : url.href
}
