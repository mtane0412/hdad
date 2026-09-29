/**
 * コメントビューアーの受け取り（WebSocket）
 *
 * コメントビューアー（/comments/）は、Workerの経路（配信者のセッションで守られた /api/admin/comments/socket）を
 * 通して配送先（worker/comment-channel.ts の Durable Object）へつなぎ、つないだ直後の履歴と、そのあとの1件ずつを受け取る。
 *
 * つなぎ直し・生存確認は src/core/socket.ts が受け持ち、ここは経路を足すだけにする。
 * 届いた文字列の読み取りはページ（feed.ts の parseFeedMessage）が行う。
 */
import { connectSocket, socketUrl } from '../core/socket'

const PATH = '/api/admin/comments/socket'
const HINT = 'コメントの配送先につながりません。ログインが切れていないか確かめてください'

export interface CommentFeedHandlers {
  /** 生存確認の返事でない文字列が届いた */
  onMessage(text: string): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

/** つないでいる接続。画面を離れるときに閉じる */
export interface CommentFeedConnection {
  close(): void
}

/** 配送先へつなぎ、切れてもつなぎ直し続ける */
export const connectCommentFeed = (handlers: CommentFeedHandlers): CommentFeedConnection => connectSocket(socketUrl(PATH), handlers, HINT)
