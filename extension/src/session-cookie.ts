/**
 * 配信者のセッションのクッキーの名前
 *
 * 拡張の offscreen document からの WebSocket には配信者のクッキーが付かないので、サービスワーカーが chrome.cookies で
 * この名前のクッキーを読み、中継先への接続で渡す（background.ts）。chrome.cookies は HttpOnly のクッキーも読める。
 *
 * 注意: Worker の worker/http.ts の SESSION_COOKIE と同じ値にする（worker/tab-routes.test.ts が一致を確かめる）。
 * 拡張から worker/ を読み込まないのは、Worker 用のコードを拡張のビルドに持ち込まないためである。
 */
export const SESSION_COOKIE_NAME = '__Host-session'
