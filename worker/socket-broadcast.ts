/**
 * 開いているWebSocketへ配る共通の部分
 *
 * Workerは接続を保持できないため、オーバーレイへ自分から知らせる手だては Durable Object に置いている
 * （アラートの配送は worker/alert-channel.ts、手書きの線の中継は worker/draw-channel.ts）。
 * どちらも「開いている接続へ同じ文字列を送る」ところは同じなので、ここにまとめる。
 */

/**
 * 配る先の接続。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の WebSocket はこの形を満たす。
 */
export interface SocketLike {
  send(message: string): void
  close(code?: number, reason?: string): void
}

/**
 * オーバーレイ用キーを発行し直したときに、古いキーで開かれた接続を閉じる番号（4000番台はアプリが自由に使える）。
 * 接続はつないだときに一度だけキーを確かめるので、閉じないと古いキーのまま受け取り続けてしまう。
 */
export const KEY_REVOKED = 4001
const KEY_REVOKED_REASON = 'オーバーレイ用キーが発行し直されました'

/** 渡された接続をすべて閉じる。1本が閉じられなくても残りは閉じる（閉じられない接続は Cloudflare 側で片付けられる） */
export const closeForRevokedKey = (sockets: readonly SocketLike[]): void => {
  for (const socket of sockets) {
    try {
      socket.close(KEY_REVOKED, KEY_REVOKED_REASON)
    } catch (error) {
      console.error('古いキーで開かれた接続を閉じられませんでした', error)
    }
  }
}

/** 接続が壊れていたときに閉じる理由（WebSocketの「予期しない状況」を表す番号） */
const INTERNAL_ERROR = 1011

/**
 * 渡された接続すべてへ同じ文字列を送る。
 *
 * 1本が壊れていても残りへは送る（1人の視聴環境の都合で配信全体を止めない）。
 * 送れなかった接続は閉じる。閉じないと、次に送るときも同じ失敗を繰り返す。
 *
 * @param subject 記録に残す呼び名（「アラート」「手書きの線」など）
 * @returns 送れた接続の数
 */
export const broadcast = (sockets: readonly SocketLike[], payload: string, subject: string): number => {
  let delivered = 0
  for (const socket of sockets) {
    try {
      socket.send(payload)
      delivered += 1
    } catch (error) {
      console.error(`${subject}を配れませんでした`, error)
      try {
        socket.close(INTERNAL_ERROR, `${subject}を配れませんでした`)
      } catch {
        // 閉じることもできない接続は、Cloudflare側で片付けられるのを待つほかない
      }
    }
  }
  return delivered
}
