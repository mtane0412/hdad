/**
 * 漢字クイズの経路（issue #300）
 *
 * - GET /api/overlay/kanji-quiz/socket?key=: 合成ページの素材「漢字クイズ」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/kanji-quiz/demo: 管理画面の試し再生。本文の grade の級の問題を1問選んで素材へ押し出す（トリガーと同じ配送の経路を通す）
 *
 * チャンネルポイントの交換での押し出しは alert-actions.ts が行う。どちらも問題は問題集から選ぶ（worker/kanji-quiz-call.ts）。
 *
 * 注意: 級の指定の誤りは、ほかの級に差し替えずに 400 で返す。配送先の失敗は、黙って成功にせず 502 で返す（管理画面に理由を出す）。
 */
import { KANKEN_GRADES, isKankenGrade } from '../src/kanji-quiz/grade'
import { connectKanjiQuizSocket, pushKanjiQuiz } from './alert-channel'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { demoKanjiQuizCallOf, pickKanjiQuizProblem } from './kanji-quiz-call'
import { overlayKeyTag } from './overlay-key'

/** GET /api/overlay/kanji-quiz/socket?key=: 合成ページからのWebSocketの接続を、漢字クイズの出題を受け取る接続として配送先へ引き渡す */
export const kanjiQuizSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectKanjiQuizSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}

/**
 * POST /api/admin/kanji-quiz/demo: 管理画面の試し再生。本文 { grade } の級の問題を1問選んで素材へ押し出す。
 *
 * トリガーと同じ配送の経路（AlertChannel）を通すので、合成ページを開いていれば OBS の画面にもそのまま流れる。
 * 何を押し出したかを画面に出せるよう、押し出したものを返す。
 */
export const postKanjiQuizDemo = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { request, env } = context
  const body: unknown = await request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const { grade }: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}
  if (!isKankenGrade(grade)) throw new HttpError(STATUS.badRequest, 'invalid-grade', `級は ${KANKEN_GRADES.join(' / ')} のいずれかで指定してください`)
  const call = demoKanjiQuizCallOf(pickKanjiQuizProblem(grade, Math.random), crypto.randomUUID())
  try {
    await pushKanjiQuiz(env.ALERTS, call)
  } catch (error) {
    throw new HttpError(STATUS.badGateway, 'kanji-quiz-push-failed', error instanceof Error ? error.message : String(error))
  }
  return Response.json(call)
}
