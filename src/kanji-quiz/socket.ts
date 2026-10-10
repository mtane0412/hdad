/**
 * 漢字クイズの押し出しの受け取り（WebSocket。アプリの枠の下部バーから使う。issue #302）
 *
 * 下部バーの取り消しボタン（stop-bar.tsx）は、合成ページと同じ押し出しの経路（/api/overlay/kanji-quiz/socket）につなぎ、
 * 時間切れで配信を止めるまでの猶予と、停止の取り消しを受け取る。この経路はオーバーレイ用キーで守られているので、
 * ログイン中の配信者のキー（/api/me で受け取ったもの）を付ける（ポモドーロの src/pomodoro/socket.ts と同じ形）。
 *
 * つなぎ直し・生存確認は src/core/socket.ts が受け持ち、ここは経路を決めるだけにする。
 */
import { connectSocket, socketUrl } from '../core/socket'
import { KANJI_QUIZ_SOCKET_HINT, KANJI_QUIZ_SOCKET_PATH } from './api'
import type { KanjiQuizStopWatchHandlers } from './stop-bar'

/**
 * 押し出しの配送先へつなぎ、切れてもつなぎ直し続ける。
 *
 * @param overlayKey ログイン中の配信者のオーバーレイ用キー
 * @param handlers 届いた文字列・接続の状態・失敗の受け口
 */
export const connectKanjiQuizWatch = (overlayKey: string, handlers: KanjiQuizStopWatchHandlers): { close(): void } =>
  connectSocket(socketUrl(KANJI_QUIZ_SOCKET_PATH, { key: overlayKey }), handlers, KANJI_QUIZ_SOCKET_HINT)
