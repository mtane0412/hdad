/**
 * 漢字クイズの、Worker とのつなぎ方
 *
 * 合成ページの素材「漢字クイズ」は、Worker から出題（問題1問と交換した人）を WebSocket（KANJI_QUIZ_SOCKET_PATH）で押し出してもらうだけで、
 * 自分から Worker を呼ぶものを持たない（段階1。回答の判定は段階2の issue #301 で足す）。
 */

/** 出題を受け取る WebSocket の経路（worker/kanji-quiz-routes.ts） */
export const KANJI_QUIZ_SOCKET_PATH = '/api/overlay/kanji-quiz/socket'

/** つながらないときに素材の箱に出す、直し方の手がかり */
export const KANJI_QUIZ_SOCKET_HINT = '漢字クイズの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'
