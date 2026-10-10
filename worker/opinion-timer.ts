/**
 * 意見の振り分けの間隔を刻むアラーム（Durable Object の中でアラームを持つ。issue #306）
 *
 * テーマを出しているあいだ、新しい発言を一定の間隔（OPINION_SORT_INTERVAL_MS）で LLM に振り分けさせる。cron（5分おき）では
 * 配信中の議論に付いていけず、Worker はタイマーを持てないので、テーマを開いたら Durable Object へ預け（startOpinionTimer）、
 * アラームで起こしてもらう。鳴るたびに振り分けの1回分（worker/opinion-run.ts）を進め、テーマが開いているあいだは次を仕掛ける。
 *
 * 預け先は広告の終了のタイマーと同じクラス（worker/ad-break-timer.ts の AdBreakTimer）の別のインスタンス（名前 opinions）である。
 * 新しい Durable Object のクラスを足すと PR のプレビューのビルドが失敗するためで、ポモドーロ・漢字クイズと同じ形にする。
 *
 * Durable Object は時計であって判定者ではない（.claude/rules/implementation.md）。テーマが開いているかは鳴るたびに D1 を読んで決める。
 *
 * 注意: 振り分けの失敗は投げずに記録して、次のアラームを仕掛ける（1回の失敗でテーマを出しているあいだの振り分けを止めない）。
 *   振り分けそのものの失敗（LLM・照合）は worker/opinion-run.ts が記録するので、ここで受け止めるのはその手前の失敗（D1 など）である。
 */
import type { AlarmDependencies } from './alarm-actions'
import { STATUS, type Env } from './http'
import { createLlm } from './llm'
import { runOpinionSorting } from './opinion-run'
import { recordFailure } from './stats-store'

/** Durable Object の名前。広告の終了・ポモドーロ・漢字クイズとアラームを取り合わないよう、別のインスタンスを指す */
const TIMER_NAME = 'opinions'
/** Worker が振り分けを始めるパス。外には出ない */
const START_PATH = '/opinions/start'
/** Worker が振り分けを止めるパス。外には出ない */
const STOP_PATH = '/opinions/stop'
/** 振り分けを刻んでいることを storage に持つときの鍵（この鍵があるインスタンスだけが、意見ボードのアラームを持つ） */
const RUNNING_KEY = 'opinion-sorting'

/**
 * 振り分けの間隔（ミリ秒）。
 *
 * 配信中の議論で、書いた意見が1分以内に画面へ出るようにする。続きを待つ間隔（worker/opinion.ts の MERGE_GAP_MS。20秒）より長くとり、
 * LLM の応答（大きいモデルで十数秒）を待っても次の回と重ならない長さにする。
 */
export const OPINION_SORT_INTERVAL_MS = 45_000

/** Durable Object から使う保管の仕組み（worker/ad-break-timer.ts の AdBreakTimerState の storage と同じもの） */
export interface OpinionTimerStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
}

/** Worker が Durable Object を呼ぶための入口（worker/ad-break-timer.ts の AdBreakTimerNamespace と同じ形） */
interface OpinionTimerNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

/** 振り分けのインスタンスへ要求を送る。失敗を返されたら投げる */
const send = async (namespace: OpinionTimerNamespace, path: string, subject: string): Promise<void> => {
  const response = await namespace.get(namespace.idFromName(TIMER_NAME)).fetch(new Request(`https://ad-break-timer${path}`, { method: 'POST' }))
  if (!response.ok) throw new Error(`意見の振り分けを${subject}られませんでした（${response.status}）`)
}

/**
 * 振り分けを始める（テーマを開いたときに呼ぶ）。
 *
 * @throws 預けられなかった場合（呼び出し側が管理画面へ失敗を返す。テーマは開いたまま）
 */
export const startOpinionTimer = (namespace: OpinionTimerNamespace): Promise<void> => send(namespace, START_PATH, '始め')

/**
 * 振り分けを止める（テーマを締め切ったときに呼ぶ）。
 *
 * @throws 止められなかった場合（次のアラームでテーマが締め切られていることを読んで止まるので、振り分けが続くことはない）
 */
export const stopOpinionTimer = (namespace: OpinionTimerNamespace): Promise<void> => send(namespace, STOP_PATH, '止め')

/**
 * Durable Object に届いた要求のうち、意見の振り分けの開始と停止を受け付ける。
 *
 * @returns 意見ボードの要求でなければ null（ほかの振り分けへ回す）
 */
export const handleOpinionTimerRequest = async (
  storage: OpinionTimerStorage,
  dependencies: Pick<AlarmDependencies, 'now'>,
  request: Request,
): Promise<Response | null> => {
  const { pathname } = new URL(request.url)
  if (pathname === START_PATH) {
    await storage.put(RUNNING_KEY, true)
    await storage.setAlarm(dependencies.now() + OPINION_SORT_INTERVAL_MS)
    return new Response(null, { status: STATUS.noContent })
  }
  if (pathname === STOP_PATH) {
    await storage.delete(RUNNING_KEY)
    await storage.deleteAlarm()
    return new Response(null, { status: STATUS.noContent })
  }
  return null
}

/**
 * アラームが鳴ったときに、振り分けの1回分を進め、テーマが開いていれば次のアラームを仕掛ける。
 *
 * @returns このインスタンスが意見ボードのアラームを持っていたか（持っていなければほかの振り分けへ回す）
 */
export const runOpinionAlarm = async (storage: OpinionTimerStorage, env: Env, dependencies: AlarmDependencies): Promise<boolean> => {
  if ((await storage.get<boolean>(RUNNING_KEY)) === undefined) return false

  const now = dependencies.now()
  const llm = createLlm({ ai: env.AI, store: env.STORE, fetch: dependencies.fetch, apiKey: env.OPENROUTER_API_KEY, db: env.DB, now: dependencies.now })
  let open = true
  try {
    open = await runOpinionSorting({ db: env.DB, alerts: env.ALERTS, llm, now })
  } catch (error) {
    await recordFailure(env.DB, 'opinion-sort-failed', `意見の振り分けが失敗しました: ${error instanceof Error ? error.message : String(error)}`, now)
  }
  if (open) {
    await storage.setAlarm(dependencies.now() + OPINION_SORT_INTERVAL_MS)
    return true
  }
  await storage.delete(RUNNING_KEY)
  return true
}
