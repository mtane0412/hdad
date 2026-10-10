/**
 * 漢字クイズの経路（issue #300）
 *
 * - GET /api/overlay/kanji-quiz/socket?key=: 合成ページの素材「漢字クイズ」の WebSocket の接続を配送先（AlertChannel）へ引き渡す
 * - POST /api/admin/kanji-quiz/demo: 管理画面の試し再生。本文の grade の級の問題を1問選んで素材へ押し出す（トリガーと同じ配送の経路を通す）
 * - GET・PUT /api/admin/kanji-quiz/sound: 演出で鳴らす音の設定を読み書きする（検証と保存は kanji-quiz-sound.ts）
 * - POST /api/overlay/kanji-quiz/open?key=: 合成ページが出題を流しはじめたときに、出題を開く（回答を受け付けはじめる。issue #301）。
 *   あわせて、受付の締め切りに時間切れの判定を予約する（issue #302）
 * - POST /api/admin/kanji-quiz/stop/cancel: 下部バーの取り消しボタン。猶予のあいだの配信の停止を取り消す（issue #302）
 * - GET /api/overlay/kanji-quiz/stop/socket?key=: 裏方のページの「配信の停止」の WebSocket の接続を、配信を止める命令の配送先へ引き渡す
 * - POST /api/overlay/kanji-quiz/stop/result?key=: 裏方のページが、配信を止める命令を受けて止められたかを知らせる。止められなかったら記録する
 *
 * チャンネルポイントの交換での押し出しは alert-actions.ts が行う。どちらも問題は問題集から選び、記録してから押し出す（worker/kanji-quiz-issue.ts）。
 *
 * 注意: 級の指定の誤りは、ほかの級に差し替えずに 400 で返す。配送先の失敗は黙って成功にせず 502 で返す
 * （管理画面に理由を出す）。
 */
import { KANKEN_GRADES, isKankenGrade, singleGradeWeights } from '../src/kanji-quiz/grade'
import { connectKanjiQuizSocket, connectStreamStopSocket } from './alert-channel'
import { HttpError, STATUS, requireAdmin, requireOverlayKey, type Context } from './http'
import { issueKanjiQuiz } from './kanji-quiz-issue'
import { loadKanjiQuizSound, parseKanjiQuizSound, playbackKanjiQuizSoundOf, saveKanjiQuizSound } from './kanji-quiz-sound'
import { cancelKanjiQuizStopsAndNotify } from './kanji-quiz-stop'
import { openKanjiQuiz } from './kanji-quiz-store'
import { scheduleKanjiQuizJudge } from './kanji-quiz-timer'
import { listMedia } from './media'
import { loadOverlayKey, overlayKeyTag } from './overlay-key'
import { recordFailure } from './stats-store'

/** 本文を JSON として読み、オブジェクトでなければ空のオブジェクトとして返す（項目の確かめは呼び出し側） */
const readBody = async (context: Context): Promise<Record<string, unknown>> => {
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  return typeof body === 'object' && body !== null ? { ...body } : {}
}

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
 * 見栄えを確かめるためのものなので、トリガーの重みではなく、その級だけを出す重みで選ぶ（出しきったら一巡する）。
 *
 * トリガーと同じ配送の経路（AlertChannel）を通すので、合成ページを開いていれば OBS の画面にもそのまま流れる。
 * 何を押し出したかを画面に出せるよう、押し出したものを返す。音は交換と同じく保存済みの設定で鳴らし、
 * 音を選んでいるのにオーバーレイ用キーが未発行なら押し出さずに409で返す。
 */
export const postKanjiQuizDemo = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env } = context
  const { grade } = await readBody(context)
  if (!isKankenGrade(grade)) throw new HttpError(STATUS.badRequest, 'invalid-grade', `級は ${KANKEN_GRADES.join(' / ')} のいずれかで指定してください`)
  const [sound, overlayKey] = await Promise.all([loadKanjiQuizSound(env.STORE), loadOverlayKey(env.STORE)])
  const playbackSound = ((): ReturnType<typeof playbackKanjiQuizSoundOf> => {
    try {
      return playbackKanjiQuizSoundOf(sound, overlayKey)
    } catch (error) {
      throw new HttpError(STATUS.conflict, 'overlay-key-missing', error instanceof Error ? error.message : String(error))
    }
  })()
  try {
    // 試し再生は交換した人がいないので、出題させた人を持たない。時間切れでも配信を止めないよう、試し再生として記録する
    const call = await issueKanjiQuiz(
      { db: env.DB, alerts: env.ALERTS, now: context.now, random: Math.random, id: crypto.randomUUID() },
      { weights: singleGradeWeights(grade), requesterName: null, rehearsal: true, sound: playbackSound },
    )
    return Response.json(call)
  } catch (error) {
    throw new HttpError(STATUS.badGateway, 'kanji-quiz-push-failed', error instanceof Error ? error.message : String(error))
  }
}

/** GET /api/admin/kanji-quiz/sound: 演出で鳴らす音の設定。未保存ならどの枠も鳴らさない設定が返る */
export const getKanjiQuizSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  return Response.json(await loadKanjiQuizSound(context.env.STORE))
}

/**
 * PUT /api/admin/kanji-quiz/sound: 音の設定を検証して保存し、保存したものを返す。
 *
 * @throws ConfigError 設定に問題がある場合（index.ts が問題点付きの400にする）
 */
export const putKanjiQuizSound = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const body: unknown = await context.request.json().catch(() => {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文はJSONにしてください')
  })
  const { env } = context
  const kinds = new Map((await listMedia(env.MEDIA)).map((item) => [item.id, item.kind]))
  const sound = parseKanjiQuizSound(body, (mediaId) => kinds.get(mediaId) ?? null)
  await saveKanjiQuizSound(env.STORE, sound)
  return Response.json(sound)
}

/**
 * POST /api/overlay/kanji-quiz/open?key=: 合成ページが出題を流しはじめたときに、出題を開く。本文は { quizId }。
 *
 * 熟語は合成ページから受け取らず、Worker が選んだときに入れた行を開く（kanji-quiz-store.ts）。開いてから級を出し終えた（熟語が出た）ときから、
 * 制限時間と遅れの余裕のあいだ、Webhook が受けたチャットの発言を回答として照らす（webhook-routes.ts）。
 * 合成ページを2つ開いていて同じ出題が2回届いても、受け付ける長さは最初に開いたときから数える。
 *
 * 開いたら、受付の締め切りに時間切れの判定を Durable Object へ予約する（issue #302。同じ出題を2回予約しても判定は1回）。
 * 予約できなければ502で返す（判定されないので配信は止まらないが、合成ページの素材の箱に理由を出させる）。
 */
export const postKanjiQuizOpen = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const { quizId } = await readBody(context)
  if (typeof quizId !== 'string' || quizId === '') throw new HttpError(STATUS.badRequest, 'invalid-body', '本文に出題の識別子（quizId）を入れてください')
  const closesAt = await openKanjiQuiz(context.env.DB, quizId, context.now)
  if (closesAt === null) throw new HttpError(STATUS.notFound, 'unknown-kanji-quiz', `選んでいない漢字クイズの出題です: ${quizId}`)
  await scheduleKanjiQuizJudge(context.env.AD_BREAKS, { quizId, closesAt }).catch((error: unknown) => {
    throw new HttpError(STATUS.badGateway, 'kanji-quiz-timer-failed', error instanceof Error ? error.message : String(error))
  })
  return new Response(null, { status: STATUS.noContent })
}

/**
 * POST /api/admin/kanji-quiz/stop/cancel: 下部バーの取り消しボタン。猶予のあいだの配信の停止をすべて取り消し、
 * 取り消したことを合成ページと下部バーへ知らせる。取り消した出題の識別子を { quizIds } で返す。
 *
 * どの出題かは受け取らない（下部バーを開き直しても押せるように、猶予のあいだのものをすべて取り消す）。
 * 取り消すものが無ければ（もう止める命令を送った・猶予に入っていない）409で返す。知らせられなければ、取り消しは済んだことを添えて502で返す。
 */
export const postKanjiQuizStopCancel = async (context: Context): Promise<Response> => {
  await requireAdmin(context)
  const { env, now } = context
  let quizIds: string[]
  try {
    quizIds = await cancelKanjiQuizStopsAndNotify({ db: env.DB, alerts: env.ALERTS, now })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new HttpError(STATUS.badGateway, 'kanji-quiz-push-failed', `配信の停止は取り消しましたが、合成ページへ知らせられませんでした: ${reason}`)
  }
  if (quizIds.length === 0) {
    throw new HttpError(STATUS.conflict, 'kanji-quiz-stop-not-pending', '取り消せる配信の停止がありません（もう止める命令を送ったか、猶予に入っていません）')
  }
  return Response.json({ quizIds })
}

/** GET /api/overlay/kanji-quiz/stop/socket?key=: 裏方のページの「配信の停止」からの WebSocket の接続を、配信を止める命令を受け取る接続として配送先へ引き渡す */
export const kanjiQuizStopSocket = async (context: Context): Promise<Response> => {
  const key = await requireOverlayKey(context)
  if (context.request.headers.get('Upgrade') !== 'websocket') {
    throw new HttpError(STATUS.badRequest, 'expected-websocket', 'この経路はWebSocketの接続にだけ使えます')
  }
  return connectStreamStopSocket(context.env.ALERTS, context.request, await overlayKeyTag(key))
}

/**
 * POST /api/overlay/kanji-quiz/stop/result?key=: 裏方のページが、配信を止める命令を受けて止められたかを知らせる。本文は { quizId, error }。
 *
 * error が null なら止められたので記録しない。文字列なら（OBS につながらない・StopStream を断られたなど）黙らず
 * kanji-quiz-stop-failed として記録する（方針4。止まらなかったことにダッシュボードで気づけるようにする）。
 */
export const postKanjiQuizStopResult = async (context: Context): Promise<Response> => {
  await requireOverlayKey(context)
  const { quizId, error } = await readBody(context)
  if (typeof quizId !== 'string' || quizId === '' || (error !== null && typeof error !== 'string')) {
    throw new HttpError(STATUS.badRequest, 'invalid-body', '本文は { quizId: 出題の識別子, error: 止められなかった理由（止められたら null） } にしてください')
  }
  if (error !== null) {
    await recordFailure(context.env.DB, 'kanji-quiz-stop-failed', `漢字クイズ（${quizId}）で配信を止められませんでした: ${error}`, context.now)
  }
  return new Response(null, { status: STATUS.noContent })
}
