/**
 * ポモドーロのタイマーの受け取り（WebSocket。アプリの枠から使う）
 *
 * アプリの枠（timer-context.tsx）は、合成ページと同じ押し出しの経路（/api/overlay/pomodoro/socket）につなぎ、
 * 別の窓での操作や、配信していないときの区切りで Worker が止めたときのタイマーを受け取って、下部バーとポモドーロのページに映す。
 * この経路はオーバーレイ用キーで守られているので、ログイン中の配信者のキー（/api/me で受け取ったもの）を付ける。
 *
 * つなぎ直し・生存確認は src/core/socket.ts が受け持ち、ここは経路を決めるだけにする。
 * 届いた文字列の読み取りは枠（phase.ts の parsePomodoroSnapshot）が行う。
 */
import { connectSocket, socketUrl } from '../core/socket'
import { POMODORO_SOCKET_HINT, POMODORO_SOCKET_PATH } from './api'
import type { PomodoroWatchHandlers } from './timer-context'

/**
 * 押し出しの配送先へつなぎ、切れてもつなぎ直し続ける。
 *
 * @param overlayKey ログイン中の配信者のオーバーレイ用キー
 * @param handlers 届いた文字列・接続の状態・失敗の受け口
 */
export const connectPomodoroWatch = (overlayKey: string, handlers: PomodoroWatchHandlers): { close(): void } =>
  connectSocket(socketUrl(POMODORO_SOCKET_PATH, { key: overlayKey }), handlers, POMODORO_SOCKET_HINT)
