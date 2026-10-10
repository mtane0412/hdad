/**
 * 漢字クイズの経路（issue #300）
 *
 * - GET /api/overlay/kanji-quiz/socket?key=: 合成ページの素材「漢字クイズ」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/kanji-quiz/demo: 管理画面の試し再生。本文の grade の級の問題を1問選んで素材へ押し出す（トリガーと同じ配送の経路を通す）
 * - POST /api/overlay/kanji-quiz/open?key=: 合成ページが出題を流しはじめたときに、出題を開く（回答を受け付けはじめる。issue #301）
 *
 * チャンネルポイントの交換での押し出しは alert-actions.ts が行う。どちらも問題は問題集から選び、記録してから押し出す（worker/kanji-quiz-issue.ts）。
 *
 * 注意: 級の指定の誤りは、ほかの級に差し替えずに 400 で返す。同じ配信で出しきったら重複させずに 409、配送先の失敗は黙って成功にせず 502 で返す
 * （管理画面に理由を出す）。
 */
import { KANKEN_GRADES, isKankenGrade } from '../src/kanji-quiz/grade'
import { connectKanjiQuizSocket } from './alert-channel'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { KanjiQuizExhaustedError } from './kanji-quiz-call'
import { issueKanjiQuiz } from './kanji-quiz-issue'
import { openKanjiQuiz } from './kanji-quiz-store'
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
  try {
    // 試し再生は交換した人がいないので、出題させた人を持たない
    const call = await issueKanjiQuiz({ db: env.DB, alerts: env.ALERTS, now: context.now, random: Math.random, id: crypto.randomUUID() }, { grade, requesterName: null })
    return Response.json(call)
  } catch (error) {
    if (error instanceof KanjiQuizExhaustedError) throw new HttpError(STATUS.conflict, 'kanji-quiz-exhausted', error.message)
    throw new HttpError(STATUS.badGateway, 'kanji-quiz-push-failed', error instanceof Error ? error.message : String(error))
  }
}

/**
 * POST /api/overlay/kanji-quiz/open?key=: 合成ページが出題を流しはじめたときに、出題を開く。本文は { quizId }。
 *
 * 熟語は合成ページから受け取らず、Worker が選んだときに入れた行を開く（kanji-quiz-store.ts）。開いてから級を出し終えた（熟語が出た）ときから、
 * 制限時間と遅れの余裕のあいだ、Webhook が受けたチャットの発言を回答として照らす（webhook-routes.ts）。
 * 合成ページを2つ開いていて同じ出題が2回届いても、受け付ける長さは最初に開いたときから数える。
 */
export const postKanjiQuizOpen = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const { quizId }: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}
  if (typeof quizId !== 'string' || quizId === '') throw new HttpError(STATUS.badRequest, 'invalid-body', '本文に出題の識別子（quizId）を入れてください')
  if (!(await openKanjiQuiz(context.env.DB, quizId, context.now))) {
    throw new HttpError(STATUS.notFound, 'unknown-kanji-quiz', `選んでいない漢字クイズの出題です: ${quizId}`)
  }
  return new Response(null, { status: STATUS.noContent })
}
