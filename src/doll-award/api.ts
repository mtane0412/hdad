/**
 * 人形の獲得の、Worker とのつなぎ方
 *
 * 合成ページの素材「人形の獲得」は、Worker から獲得を WebSocket（DOLL_AWARD_SOCKET_PATH）で押し出してもらうだけで、
 * 自分から Worker を呼ぶものを持たない（人形の画像は押し出された URL から読む）。
 */

/** 獲得を受け取る WebSocket の経路（worker/doll-routes.ts） */
export const DOLL_AWARD_SOCKET_PATH = '/api/overlay/doll-award/socket'

/** つながらないときに素材の箱に出す、直し方の手がかり */
export const DOLL_AWARD_SOCKET_HINT = '人形の獲得の配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'
