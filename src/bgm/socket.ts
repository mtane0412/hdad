/**
 * BGMの管理画面の受け取り（WebSocket）
 *
 * BGMのページ（/bgm/）は、裏方のページと同じ押し出しの経路（/api/overlay/bgm/socket）につなぎ、
 * 曲の終わりで次の曲へ進んだ・Jev が切り替えたときの「いま流している曲」を受け取ってプレーヤーに映す。
 * この経路はオーバーレイ用キーで守られているので、ログイン中の配信者のキー（/api/me で受け取ったもの）を付ける。
 *
 * つなぎ直し・生存確認は src/core/socket.ts が受け持ち、ここは経路を決めるだけにする。
 * 届いた文字列の読み取りはページ（api.ts の parseBgmNowPlaying）が行う。
 */
import { connectSocket, socketUrl } from '../core/socket'
import { BGM_SOCKET_HINT, BGM_SOCKET_PATH } from './api'
import type { BgmWatchHandlers } from './player-context'

/**
 * 押し出しの配送先へつなぎ、切れてもつなぎ直し続ける。
 *
 * @param overlayKey ログイン中の配信者のオーバーレイ用キー
 * @param handlers 届いた文字列・接続の状態・失敗の受け口
 */
export const connectBgmWatch = (overlayKey: string, handlers: BgmWatchHandlers): { close(): void } =>
  connectSocket(socketUrl(BGM_SOCKET_PATH, { key: overlayKey }), handlers, BGM_SOCKET_HINT)
