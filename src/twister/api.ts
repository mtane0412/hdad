/**
 * ツイスターの、Worker とのつなぎ方
 *
 * 合成ページの素材「ツイスター」は、Worker から呼び出し（種と2人）を WebSocket（TWISTER_SOCKET_PATH）で押し出してもらうだけで、
 * 自分から Worker を呼ぶものを持たない（対戦の中身は種から合成ページが計算する）。
 */

/** 呼び出しを受け取る WebSocket の経路（worker/twister-routes.ts） */
export const TWISTER_SOCKET_PATH = '/api/overlay/twister/socket'

/** つながらないときに素材の箱に出す、直し方の手がかり */
export const TWISTER_SOCKET_HINT = 'ツイスターの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'
