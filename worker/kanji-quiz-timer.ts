/**
 * 漢字クイズの時間切れの判定と配信の停止の時刻（Durable Object の中でアラームを持つ。issue #302）
 *
 * Worker はタイマーを持てないので、合成ページが出題を開いたら受付の締め切りの時刻を Durable Object へ預け（scheduleKanjiQuizJudge）、
 * 時刻が来たらアラームで起こしてもらう。締め切りでは時間切れを確かめ、猶予が尽きる時刻をもう一度預ける（中身は kanji-quiz-stop.ts）。
 *
 * 預け先は広告の終了のタイマーと同じクラス（worker/ad-break-timer.ts の AdBreakTimer）の別のインスタンス（名前 kanji-quiz）である。
 * 新しい Durable Object のクラスを足すと PR のプレビューのビルドが失敗するためで、ポモドーロ（名前 pomodoro）と同じ形にする。
 * アラームはインスタンスごとに1つなので、預かった時刻（判定と停止）を一覧で持ち、いちばん早い時刻にアラームを仕掛ける。
 *
 * Durable Object は時計であって判定者ではない（.claude/rules/implementation.md）。正解者がいたか・取り消されたかは、鳴るたびに D1 を読んで決める。
 *
 * 注意: 鳴ったら、来た時刻の分を一覧から消してから実行する。実行が失敗したときにアラームの再試行で同じ停止を二度試みないためである
 *   （二度止めないこと自体は D1 の鍵が受け持つ）。失敗は投げずに kanji-quiz-stop-failed として記録する。
 * 注意: 判定から停止を預けるときは、自分自身へ fetch せず storage に直接書く（アラームの中から自分を呼ぶと、その要求は待たされる）。
 */
import type { AlarmDependencies } from './alarm-actions'
import { STATUS, type Env } from './http'
import { judgeKanjiQuizTimeout, sendKanjiQuizStop } from './kanji-quiz-stop'
import { recordFailure } from './stats-store'

/** Durable Object の名前。広告の終了（ad-break）・ポモドーロ（pomodoro）とアラームを取り合わないよう、別のインスタンスを指す */
const TIMER_NAME = 'kanji-quiz'
/** Worker が判定を預けるパス。外には出ない */
const SCHEDULE_PATH = '/kanji-quiz/schedule'
/** 預かった時刻の一覧を storage に持つときの鍵 */
const STEPS_KEY = 'kanji-quiz-steps'
/** 失敗を記録するときの種類 */
const FAILURE_CODE = 'kanji-quiz-stop-failed'

/** 預かった時刻1つ。judge は受付の締め切り（時間切れの判定）、stop は猶予の終わり（配信の停止） */
interface KanjiQuizStep {
  readonly kind: 'judge' | 'stop'
  readonly quizId: string
  readonly at: number
}

/** Durable Object から使う保管の仕組み（worker/ad-break-timer.ts の AdBreakTimerState の storage と同じもの） */
export interface KanjiQuizTimerStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  setAlarm(scheduledTime: number): Promise<void>
}

/** Worker が Durable Object を呼ぶための入口（worker/ad-break-timer.ts の AdBreakTimerNamespace と同じ形） */
interface KanjiQuizTimerNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

/** いちばん早い時刻にアラームを仕掛け直す。一覧が空なら鍵ごと消す（ほかのインスタンスと同じく、状態が無ければ自分のアラームではない） */
const saveSteps = async (storage: KanjiQuizTimerStorage, steps: readonly KanjiQuizStep[]): Promise<void> => {
  if (steps.length === 0) {
    await storage.delete(STEPS_KEY)
    return
  }
  await storage.put(STEPS_KEY, steps)
  await storage.setAlarm(Math.min(...steps.map(({ at }) => at)))
}

/** 時刻を1つ足す。同じ出題の同じ種類は1つにまとめる（合成ページを2つ開いていて2回預けられても、1回だけ鳴らす） */
const addStep = async (storage: KanjiQuizTimerStorage, step: KanjiQuizStep): Promise<void> => {
  const steps = (await storage.get<KanjiQuizStep[]>(STEPS_KEY)) ?? []
  await saveSteps(storage, [...steps.filter(({ kind, quizId }) => !(kind === step.kind && quizId === step.quizId)), step])
}

/**
 * 受付の締め切りに時間切れの判定をするよう、Durable Object へ預ける。合成ページが出題を開いたときに呼ぶ。
 *
 * @throws 預けられなかった場合（呼び出し側が合成ページへ失敗を返す。判定されないので配信は止まらない）
 */
export const scheduleKanjiQuizJudge = async (namespace: KanjiQuizTimerNamespace, judge: { readonly quizId: string; readonly closesAt: number }): Promise<void> => {
  const step: KanjiQuizStep = { kind: 'judge', quizId: judge.quizId, at: judge.closesAt }
  const response = await namespace
    .get(namespace.idFromName(TIMER_NAME))
    .fetch(new Request(`https://ad-break-timer${SCHEDULE_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(step) }))
  if (!response.ok) throw new Error(`漢字クイズの時間切れの判定を予約できませんでした（${response.status}）`)
}

/**
 * Durable Object に届いた要求のうち、漢字クイズの判定の予約を受け付ける。
 *
 * @returns 漢字クイズの要求でなければ null（ほかの振り分けへ回す）
 */
export const handleKanjiQuizTimerRequest = async (storage: KanjiQuizTimerStorage, request: Request): Promise<Response | null> => {
  if (new URL(request.url).pathname !== SCHEDULE_PATH) return null
  const body: unknown = await request.json()
  const { quizId, at }: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}
  if (typeof quizId !== 'string' || typeof at !== 'number') return new Response(null, { status: STATUS.badRequest })
  await addStep(storage, { kind: 'judge', quizId, at })
  return new Response(null, { status: STATUS.noContent })
}

/**
 * アラームが鳴ったときに、来た時刻の判定と停止を実行する。
 *
 * @returns このインスタンスが漢字クイズの時刻を預かっていたか（預かっていなければほかの振り分けへ回す）
 */
export const runKanjiQuizAlarm = async (storage: KanjiQuizTimerStorage, env: Env, dependencies: Pick<AlarmDependencies, 'now'>): Promise<boolean> => {
  const steps = await storage.get<KanjiQuizStep[]>(STEPS_KEY)
  if (steps === undefined) return false

  const now = dependencies.now()
  // 来た時刻の分を消してから実行する。失敗しても再試行で同じものを試みないため
  await saveSteps(
    storage,
    steps.filter(({ at }) => at > now),
  )
  for (const step of steps.filter(({ at }) => at <= now)) {
    const deps = { db: env.DB, alerts: env.ALERTS, now }
    try {
      if (step.kind === 'judge') await judgeKanjiQuizTimeout(deps, step.quizId, ({ quizId, at }) => addStep(storage, { kind: 'stop', quizId, at }))
      else await sendKanjiQuizStop(deps, step.quizId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await recordFailure(env.DB, FAILURE_CODE, `漢字クイズ（${step.quizId}）で配信を止める流れが失敗しました: ${reason}`, now)
    }
  }
  return true
}
