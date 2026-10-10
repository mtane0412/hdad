/**
 * 漢字クイズの、Worker とのつなぎ方
 *
 * 合成ページの素材「漢字クイズ」は、Worker から出題（問題1問と交換した人）と知らせ（最初の正解者・出題できなかった理由）を
 * WebSocket（KANJI_QUIZ_SOCKET_PATH）で押し出してもらう。出題を流しはじめたら、オーバーレイ用キーを付けて出題を開かせる
 * （POST /api/overlay/kanji-quiz/open。issue #301）。開いてから熟語が出て制限時間のあいだ、Worker はチャットの発言を回答として照らす。
 * 裏方のページの「配信の停止」は、配信を止める命令を STOP_SOCKET_PATH で受け取り、止められたかを知らせる（reportStop。issue #302）。
 * 下部バーは同じ出題の経路で猶予を受け取り、配信者のセッションで停止を取り消す（createKanjiQuizAdminApi の cancelStop）。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 開けなかったときは Worker の理由ごと投げる（合成ページが素材の箱に出す）。
 */
import { createCaller, isRecord } from '../core/api'

/** 出題を受け取る WebSocket の経路（worker/kanji-quiz-routes.ts） */
export const KANJI_QUIZ_SOCKET_PATH = '/api/overlay/kanji-quiz/socket'

/** 出題を開かせる経路（worker/kanji-quiz-routes.ts） */
const OPEN_PATH = '/api/overlay/kanji-quiz/open'

/** 停止の結果を知らせる経路（worker/kanji-quiz-routes.ts） */
const STOP_RESULT_PATH = '/api/overlay/kanji-quiz/stop/result'
/** 停止を取り消す経路（worker/kanji-quiz-routes.ts） */
const STOP_CANCEL_PATH = '/api/admin/kanji-quiz/stop/cancel'
/** 配信を止める命令を受け取る WebSocket の経路（裏方のページ。worker/kanji-quiz-routes.ts） */
export const STOP_SOCKET_PATH = '/api/overlay/kanji-quiz/stop/socket'
/** 裏方のページが命令の経路につながらないときに出す、直し方の手がかり */
export const STOP_SOCKET_HINT = '配信を止める命令の配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

/** つながらないときに素材の箱に出す、直し方の手がかり */
export const KANJI_QUIZ_SOCKET_HINT = '漢字クイズの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

export interface KanjiQuizApi {
  /**
   * 流しはじめた出題を開かせる。熟語は Worker が選んだときに記録したものを使う。
   *
   * @throws ApiError 選んでいない出題（404）など。Worker の理由を持つ
   */
  openQuiz(quizId: string): Promise<void>
  /**
   * 配信を止める命令を受けて、止められたかを知らせる（裏方のページ）。
   *
   * @param error 止められなかった理由。止められたら null（Worker は理由があるときだけ失敗として記録する）
   */
  reportStop(quizId: string, error: string | null): Promise<void>
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
    reportStop: async (quizId, error) => {
      await call(`${STOP_RESULT_PATH}?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId, error }),
      })
    },
  }
}

/** 配信者のセッションでの呼び出し（下部バー） */
export interface KanjiQuizAdminApi {
  /**
   * 猶予のあいだの配信の停止をすべて取り消す。
   *
   * @returns 取り消した出題の識別子
   * @throws ApiError 取り消すものが無い（409）など。Worker の理由を持つ
   */
  cancelStop(): Promise<string[]>
}

/**
 * 配信者のセッションでの呼び出しを組み立てる。セッションのクッキーと Origin ヘッダーはブラウザが付ける。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createKanjiQuizAdminApi = (fetchImpl: typeof fetch): KanjiQuizAdminApi => {
  const call = createCaller(fetchImpl)
  return {
    cancelStop: async () => {
      const body = await call(STOP_CANCEL_PATH, { method: 'POST' })
      const quizIds = isRecord(body) ? body.quizIds : undefined
      if (!Array.isArray(quizIds) || !quizIds.every((quizId) => typeof quizId === 'string')) throw new Error('Workerの応答に quizIds がありません')
      return quizIds
    },
  }
}
