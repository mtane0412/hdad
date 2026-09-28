/**
 * 文字起こしの中継ページの、OBSに貼るURLの組み立て
 *
 * 画面（transcript-page.tsx）から分けてテストする（admin/form.ts の overlayUrl と同じ扱い）。
 *
 * 注意: ポートが読めない値なら、既定へ黙って戻さずエラーにする（Fail-Fast）。黙って戻すと、
 * 配信者が入れたポートと違う先へつなぐURLを、そうと分からないまま渡してしまう。
 */

/** 中継ページのパス（transcript/relay/index.html として配信される） */
const RELAY_PATH = '/transcript/relay/'

/** ゆかコネNEO の WebSocket の既定のポート（レジストリ HKCU\Software\YukarinetteConnectorNeo\WebSocket の既定値） */
export const DEFAULT_TRANSCRIPT_PORT = 11901

const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * ゆかコネNEO のポート番号が使える値かどうかを確かめる。
 *
 * 中継の単独ページ（relayUrl）と、裏方をまとめたページ（src/backstage/url.ts）の両方から使う。
 * 2か所で書き分けると、同じ入力欄に対して片方だけが通るURLを出してしまう。
 *
 * @throws ポートが整数でない、または範囲の外のとき
 */
export const assertTranscriptPort = (port: number): void => {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`ポート番号は${MIN_PORT}〜${MAX_PORT}の整数で入力してください`)
  }
}

/**
 * OBSのブラウザソースに貼るURLを組み立てる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param overlayKey オーバーレイ用キー
 * @param port ゆかコネNEO の WebSocket のポート番号。既定と同じならURLに書き足さない
 * @throws ポートが整数でない、または範囲の外のとき
 */
export const relayUrl = (origin: string, overlayKey: string, port: number): string => {
  assertTranscriptPort(port)
  const base = `${origin}${RELAY_PATH}?key=${encodeURIComponent(overlayKey)}`
  return port === DEFAULT_TRANSCRIPT_PORT ? base : `${base}&port=${port}`
}
