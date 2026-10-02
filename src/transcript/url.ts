/**
 * 文字起こしの中継がつなぐ ゆかコネNEO のポート番号の既定値と検証
 *
 * OBSに貼るURLは裏方をまとめたページ（src/backstage/url.ts）が組み立て、ポートの検証だけをここから使う。
 *
 * 注意: ポートが読めない値なら、既定へ黙って戻さずエラーにする（Fail-Fast）。黙って戻すと、
 * 配信者が入れたポートと違う先へつなぐURLを、そうと分からないまま渡してしまう。
 */

/** ゆかコネNEO の WebSocket の既定のポート（レジストリ HKCU\Software\YukarinetteConnectorNeo\WebSocket の既定値） */
export const DEFAULT_TRANSCRIPT_PORT = 11901

const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * ゆかコネNEO のポート番号が使える値かどうかを確かめる。
 *
 * 裏方をまとめたページのURLの組み立て（src/backstage/url.ts）が使う。
 *
 * @throws ポートが整数でない、または範囲の外のとき
 */
export const assertTranscriptPort = (port: number): void => {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`ポート番号は${MIN_PORT}〜${MAX_PORT}の整数で入力してください`)
  }
}
