/**
 * ペロペロの、Worker とのつなぎ方
 *
 * 合成ページの素材「ペロペロ」は、Worker から呼び出し（種と舐める相手）を WebSocket（LICK_SOCKET_PATH）で押し出してもらうだけで、
 * 自分から Worker を呼ぶものを持たない（舐め方は種から合成ページが計算する）。
 */

/** 呼び出しを受け取る WebSocket の経路（worker/lick-routes.ts） */
export const LICK_SOCKET_PATH = '/api/overlay/lick/socket'

/** つながらないときに素材の箱に出す、直し方の手がかり */
export const LICK_SOCKET_HINT = 'ペロペロの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'
