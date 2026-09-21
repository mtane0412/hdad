/**
 * 秘密の値を扱う小さな部品
 *
 * ランダムな値の生成（OAuthのstate・オーバーレイ用キー）、HMACによる署名、
 * 比較にかかる時間から中身を推測されない文字列比較をまとめる。
 */
const RANDOM_BYTES = 32

const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

/** 推測できないランダムな文字列（URLにそのまま載せられる文字だけ）を作る */
export const randomToken = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)))

/** 文字列 value に秘密鍵 secret で署名する（HMAC-SHA256） */
export const sign = async (value: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}

/**
 * 2つの文字列が等しいかを、一致した文字数によって処理時間が変わらない方法で比べる。
 *
 * 注意: 長さが違う場合はすぐ false を返す。比べる値はどれも固定長のランダム値か署名なので、長さは秘密ではない。
 */
export const timingSafeEqual = (left: string, right: string): boolean => {
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  if (leftBytes.length !== rightBytes.length) return false
  let difference = 0
  for (const [index, byte] of leftBytes.entries()) difference |= byte ^ (rightBytes[index] ?? 0)
  return difference === 0
}
