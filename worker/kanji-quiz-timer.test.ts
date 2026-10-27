/**
 * 漢字クイズの時間切れの判定と配信の停止（kanji-quiz-timer.ts・kanji-quiz-stop.ts）のテスト
 *
 * 判定と停止の時刻は Durable Object（AdBreakTimer の別のインスタンス。名前は kanji-quiz）に預け、アラームで起こしてもらう。
 * ここでは本物の AdBreakTimer に storage の代役を渡し、次の流れを確かめる（issue #302）。
 * - 受付の締め切りに正解者がいなければ、合成ページと下部バーへ猶予を知らせ、猶予が尽きたら裏方へ停止の命令を送る
 * - 正解者がいれば何もしない。試し再生は猶予を知らせるが止めない。猶予のあいだに取り消したら止めない
 * - 配信を止める回数を2回以上にしていれば、同じ配信の時間切れがその回数に届くまでは止めず、残りの回数を知らせる
 * - 裏方がつながっていないなど、止められなかったときは黙らず失敗として記録する
 *
 * D1・アラートの配送先は代役にする。
 */
import { describe, expect, it } from 'vitest'
import type { AdBreakTimerNamespace } from './ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { createTimerInstances } from './fake-timer-instances'
import { createFakeTokenVault } from './fake-token-vault'
import type { Env } from './http'
import { KANJI_QUIZ_STOP_GRACE_MS, cancelKanjiQuizStopsAndNotify } from './kanji-quiz-stop'
import { answerKanjiQuiz, missKanjiQuiz, openKanjiQuiz, readKanjiQuizMissCount, recordKanjiQuiz } from './kanji-quiz-store'
import { scheduleKanjiQuizJudge } from './kanji-quiz-timer'
import { listFailures, recordStreamOnline } from './stats-store'

/** 合成ページが出題を開いた時刻 */
const openedAt = Date.parse('2026-10-10T12:00:00Z')
/** 漢字クイズの Durable Object のインスタンスの名前 */
const TIMER_NAME = 'kanji-quiz'

/** 時刻を自由に進められる時計 */
const createClock = () => {
  let current = openedAt
  return {
    now: () => current,
    set: (at: number) => {
      current = at
    },
  }
}

/**
 * 「境内」の出題を選んで開いた環境を作り、開いたときに返る締め切りに時間切れの判定を仕掛ける。
 *
 * @param options.rehearsal 試し再生の出題にする
 * @param options.noStreamStopReceiver 配信を止める命令を受け取る裏方がつながっていない
 * @param options.missLimit 配信を止めるまでの時間切れの回数の設定。null なら未保存（1回）
 * @param options.earlierMisses 同じ配信で、この出題の前に時間切れになった出題の数
 */
const setUp = async ({
  rehearsal = false,
  noStreamStopReceiver = false,
  missLimit = null,
  earlierMisses = 0,
}: { rehearsal?: boolean; noStreamStopReceiver?: boolean; missLimit?: number | null; earlierMisses?: number } = {}) => {
  const clock = createClock()
  const alerts = createFakeAlertChannel({ noStreamStopReceiver })
  const env = {
    STORE: createFakeStore({
      'overlay-key': 'issued-overlay-key-0123456789abcdefghij',
      ...(missLimit === null ? {} : { 'kanji-quiz-miss-limit': JSON.stringify({ missLimit }) }),
    }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: '12345',
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: alerts.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: undefined as unknown as AdBreakTimerNamespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    throw new Error(`テストで想定していない通信です: ${String(input)}`)
  }
  const timers = createTimerInstances(() => env, { fetch: fetchImpl, now: clock.now, wait: async () => {} }, clock.set)
  env.AD_BREAKS = timers.namespace

  // 配信中にして、この出題の前に earlierMisses 問を時間切れにしておく
  await recordStreamOnline(env.DB, { id: 'stream-1', startedAt: openedAt - 60 * 60 * 1000 })
  for (let index = 0; index < earlierMisses; index++) {
    const earlierAt = openedAt - (index + 1) * 10 * 60 * 1000
    await recordKanjiQuiz(env.DB, { id: `quiz-earlier-${index}`, word: `前の熟語${index}`, rehearsal: false }, earlierAt)
    const earlierClosesAt = await openKanjiQuiz(env.DB, `quiz-earlier-${index}`, earlierAt)
    if (earlierClosesAt === null) throw new Error('前の出題を開けませんでした')
    await missKanjiQuiz(env.DB, `quiz-earlier-${index}`, earlierClosesAt)
  }
  await recordKanjiQuiz(env.DB, { id: 'quiz-keidai', word: '境内', rehearsal }, openedAt - 1000)
  const closesAt = await openKanjiQuiz(env.DB, 'quiz-keidai', openedAt)
  if (closesAt === null) throw new Error('出題を開けませんでした')
  await scheduleKanjiQuizJudge(env.AD_BREAKS, { quizId: 'quiz-keidai', closesAt })

  return { env, clock, alerts, timers, closesAt }
}

describe('時間切れの判定', () => {
  it('受付の締め切りにアラームを仕掛ける', async () => {
    const { timers, closesAt } = await setUp()

    expect(timers.alarmOf(TIMER_NAME)).toBe(closesAt)
  })

  it('締め切りに正解者がいなければ、猶予を知らせ、猶予が尽きる時刻に停止のアラームを仕掛ける', async () => {
    const { timers, alerts, closesAt } = await setUp()

    await timers.ring(TIMER_NAME)

    expect(alerts.pushedKanjiQuizNotices).toEqual([{ type: 'stopping', quizId: 'quiz-keidai', graceMs: KANJI_QUIZ_STOP_GRACE_MS, rehearsal: false }])
    expect(timers.alarmOf(TIMER_NAME)).toBe(closesAt + KANJI_QUIZ_STOP_GRACE_MS)
    // 猶予のあいだはまだ止めない
    expect(alerts.pushedStreamStops).toEqual([])
  })

  it('猶予が尽きたら、裏方へ配信を止める命令を送る', async () => {
    const { timers, alerts } = await setUp()

    await timers.ring(TIMER_NAME)
    await timers.ring(TIMER_NAME)

    expect(alerts.pushedStreamStops).toEqual([{ quizId: 'quiz-keidai' }])
    // 次のアラームは仕掛けない
    expect(timers.alarmOf(TIMER_NAME)).toBeNull()
  })

  it('締め切りまでに正解者がいれば、猶予も知らせず止めもしない', async () => {
    const { env, timers, alerts, closesAt } = await setUp()
    await answerKanjiQuiz(env.DB, { words: ['境内'], userName: '山田花子' }, closesAt - 5000)

    await timers.ring(TIMER_NAME)

    expect(alerts.pushedKanjiQuizNotices).toEqual([])
    expect(alerts.pushedStreamStops).toEqual([])
    expect(timers.alarmOf(TIMER_NAME)).toBeNull()
  })

  it('試し再生の出題は、猶予を知らせるが止めない（停止のアラームを仕掛けない）', async () => {
    const { timers, alerts } = await setUp({ rehearsal: true })

    await timers.ring(TIMER_NAME)

    expect(alerts.pushedKanjiQuizNotices).toEqual([{ type: 'stopping', quizId: 'quiz-keidai', graceMs: KANJI_QUIZ_STOP_GRACE_MS, rehearsal: true }])
    expect(timers.alarmOf(TIMER_NAME)).toBeNull()
    expect(alerts.pushedStreamStops).toEqual([])
  })

  it('猶予のあいだに取り消したら、取り消したことを知らせ、猶予が尽きても止めない', async () => {
    const { env, clock, timers, alerts, closesAt } = await setUp()
    await timers.ring(TIMER_NAME)
    clock.set(closesAt + 3000)

    // 配信者が下部バーの取り消しボタンを押した
    expect(await cancelKanjiQuizStopsAndNotify({ db: env.DB, alerts: env.ALERTS, now: clock.now() })).toEqual(['quiz-keidai'])
    await timers.ring(TIMER_NAME)

    expect(alerts.pushedKanjiQuizNotices.at(-1)).toEqual({ type: 'stopCancelled', quizId: 'quiz-keidai' })
    expect(alerts.pushedStreamStops).toEqual([])
  })

  it('同じ出題の判定を2回仕掛けても（合成ページを2つ開いていても）、知らせと停止は1回だけ', async () => {
    const { env, timers, alerts, closesAt } = await setUp()
    await scheduleKanjiQuizJudge(env.AD_BREAKS, { quizId: 'quiz-keidai', closesAt })

    await timers.ring(TIMER_NAME)
    await timers.ring(TIMER_NAME)

    expect(alerts.pushedKanjiQuizNotices).toHaveLength(1)
    expect(alerts.pushedStreamStops).toHaveLength(1)
  })

  it('配信を止める命令を受け取る裏方がつながっていなければ、失敗として記録する', async () => {
    const { env, timers } = await setUp({ noStreamStopReceiver: true })

    await timers.ring(TIMER_NAME)
    await timers.ring(TIMER_NAME)

    const failures = await listFailures(env.DB)
    expect(failures.map(({ code }) => code)).toEqual(['kanji-quiz-stop-failed'])
    expect(failures[0]?.message).toContain('裏方のページ')
  })

  it('猶予を知らせられなかったら止めずに（止めると配信者が取り消せないため）、失敗として記録する', async () => {
    const { env, timers, alerts } = await setUp()
    // 配送先が落ちている
    env.ALERTS = createFakeAlertChannel({ shouldFail: true }).namespace

    await timers.ring(TIMER_NAME)

    expect(timers.alarmOf(TIMER_NAME)).toBeNull()
    expect(alerts.pushedStreamStops).toEqual([])
    expect((await listFailures(env.DB)).map(({ code }) => code)).toEqual(['kanji-quiz-stop-failed'])
    // 停止を始めたことも取り消す（あとで下部バーから「取り消せた」ことにならないように）
    expect(await cancelKanjiQuizStopsAndNotify({ db: env.DB, alerts: env.ALERTS, now: Date.parse('2026-10-10T12:01:00Z') })).toEqual([])
  })
})

describe('配信を止めるまでの時間切れの回数', () => {
  it('3回で止める設定なら、同じ配信で1回目の時間切れでは止めず、残りの回数を知らせる', async () => {
    const { timers, alerts } = await setUp({ missLimit: 3 })

    await timers.ring(TIMER_NAME)

    // 次の出題から数えて、あと2回時間切れになると配信が終わる
    expect(alerts.pushedKanjiQuizNotices).toEqual([{ type: 'missed', quizId: 'quiz-keidai', remainingMisses: 2 }])
    expect(timers.alarmOf(TIMER_NAME)).toBeNull()
    expect(alerts.pushedStreamStops).toEqual([])
  })

  it('3回で止める設定で、同じ配信で前に2回時間切れになっていたら、3回目の時間切れで猶予を知らせて止める', async () => {
    const { timers, alerts } = await setUp({ missLimit: 3, earlierMisses: 2 })

    await timers.ring(TIMER_NAME)
    await timers.ring(TIMER_NAME)

    expect(alerts.pushedKanjiQuizNotices).toEqual([{ type: 'stopping', quizId: 'quiz-keidai', graceMs: KANJI_QUIZ_STOP_GRACE_MS, rehearsal: false }])
    expect(alerts.pushedStreamStops).toEqual([{ quizId: 'quiz-keidai' }])
  })

  it('未保存なら、これまでどおり1回目の時間切れで止める', async () => {
    const { timers, alerts } = await setUp({ earlierMisses: 0 })

    await timers.ring(TIMER_NAME)

    expect(alerts.pushedKanjiQuizNotices.map(({ type }) => type)).toEqual(['stopping'])
  })

  it('試し再生の時間切れは、本番の時間切れの回数に1回足したときと同じ知らせを出し、本番の回数には数えない', async () => {
    const { env, timers, alerts } = await setUp({ missLimit: 3, earlierMisses: 1, rehearsal: true })

    await timers.ring(TIMER_NAME)

    // 本番で1回時間切れになっているので、試し再生を本番とみなすと2回目。あと1回で終わる
    expect(alerts.pushedKanjiQuizNotices).toEqual([{ type: 'missed', quizId: 'quiz-keidai', remainingMisses: 1 }])
    expect(await readKanjiQuizMissCount(env.DB, Date.parse('2026-10-10T12:05:00Z'), null)).toBe(1)
  })

  it('止めない時間切れを知らせられなかったら、失敗として記録する', async () => {
    const { env, timers } = await setUp({ missLimit: 3 })
    // 配送先が落ちている
    env.ALERTS = createFakeAlertChannel({ shouldFail: true }).namespace

    await timers.ring(TIMER_NAME)

    expect((await listFailures(env.DB)).map(({ code }) => code)).toEqual(['kanji-quiz-stop-failed'])
  })
})
