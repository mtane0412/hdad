/**
 * 漢字クイズの、Worker とのつなぎ方
 *
 * 合成ページの素材「漢字クイズ」は、Worker から出題（問題1問と交換した人）と知らせ（最初の正解者・出題できなかった理由）を
 * WebSocket（KANJI_QUIZ_SOCKET_PATH）で押し出してもらう。出題を流しはじめたら、オーバーレイ用キーを付けて出題を開かせる
 * （POST /api/overlay/kanji-quiz/open。issue #301）。開いてから熟語が出て制限時間のあいだ、Worker はチャットの発言を回答として照らす。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 開けなかったときは Worker の理由ごと投げる（合成ページが素材の箱に出す）。
 */
import { createCaller } from '../core/api'

/** 出題を受け取る WebSocket の経路（worker/kanji-quiz-routes.ts） */
export const KANJI_QUIZ_SOCKET_PATH = '/api/overlay/kanji-quiz/socket'

/** 出題を開かせる経路（worker/kanji-quiz-routes.ts） */
const OPEN_PATH = '/api/overlay/kanji-quiz/open'

/** つながらないときに素材の箱に出す、直し方の手がかり */
export const KANJI_QUIZ_SOCKET_HINT = '漢字クイズの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

export interface KanjiQuizApi {
  /**
   * 流しはじめた出題を開かせる。熟語は Worker が選んだときに記録したものを使う。
   *
   * @throws ApiError 選んでいない出題（404）など。Worker の理由を持つ
   */
  openQuiz(quizId: string): Promise<void>
}

/**
 * 漢字クイズの呼び出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createKanjiQuizApi = (fetchImpl: typeof fetch, key: string): KanjiQuizApi => {
  const call = createCaller(fetchImpl)
  return {
    openQuiz: async (quizId) => {
      await call(`${OPEN_PATH}?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId }),
      })
    },
  }
}
