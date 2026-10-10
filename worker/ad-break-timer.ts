/**
 * 広告の終了のタイマー（Durable Object）
 *
 * Twitchには広告の開始の通知（channel.ad_break.begin）しかなく、終了に相当する通知は届かない。
 * 一方で開始の通知には広告の長さ（duration_seconds）が入っているので、終わる時刻は開始の時点で決まる。
 * そこで Worker は開始を受けた時点でここへ「いつ終わるか」を預け、時刻が来たらアラームで起こしてもらい、
 * 擬似イベント（channel.ad_break.end）として同じ照合へ回す。
 *
 * この Durable Object は「時計」であって「判定者」ではない。どのトリガーに当てはまるかは Worker（alert-event.ts）が決め、
 * 実行も Worker のコード（alert-actions.ts）を通す。設定はアラームが鳴るたびにKVから読み直すので、
 * 管理画面での変更がOBSの再読み込みなしで反映される性質は保たれる（alert-channel.ts が「配送者」に徹しているのと同じ考え方）。
 *
 * Worker が接続を保持できないのと同じ理由で、Worker はタイマーも持てない。cron（5分おき）では広告（30〜180秒）に間に合わず、
 * 応答を返したあとに待つ手（Context.waitUntil）ではどれだけ待てるかが保証されないため、アラームを持てるここに預ける。
 *
 * 注意: 予約は1件だけ持つ（アラームも1つしか仕掛けられない）。広告中にもう1本の広告が始まることはないため、
 * 新しい予約が来たら古いものは上書きする。
 * 注意: アラームは1回しか鳴らないので、鳴ったら予約を消す。消してから実行するのは、実行が失敗したときに
 * アラームの再試行で同じ告知を二度送らないためである（送信そのものの二重防止は alert-actions.ts の鍵が受け持つ）。
 *
 * ポモドーロのタイマー（issue #208）の区切りも、このクラスの別のインスタンス（名前 pomodoro）が預かる。アラームはインスタンスごとに
 * 1つなので、広告の予約とは取り合わない。新しい Durable Object のクラスを足さないのは、足したPRではプレビューのビルドが失敗するためで、
 * クラス名は広告のまま残す（名前を変えるには Durable Object のマイグレーションが要る）。パス /pomodoro/ と区切りのアラームの中身は
 * worker/pomodoro-timer.ts が持ち、ここは振り分けるだけである。
 *
 * 漢字クイズの時間切れの判定と配信の停止の時刻（issue #302）も、別のインスタンス（名前 kanji-quiz）が預かる。
 * パス /kanji-quiz/ と鳴ったときの中身は worker/kanji-quiz-timer.ts が持つ。
 */
import { runAlarmActions, type AlarmDependencies } from './alarm-actions'
import { handleKanjiQuizTimerRequest, runKanjiQuizAlarm } from './kanji-quiz-timer'
import { handlePomodoroRequest, runPomodoroAlarm } from './pomodoro-timer'
import { AD_BREAK_END } from './trigger-menu'
import { STATUS, type Env } from './http'

/** Durable Object の名前。預け先は1つだけなので、決め打ちの名前で同じものを指す */
const TIMER_NAME = 'ad-break'

/** Worker が予約に使うパス。外には出ない（Twitchの署名の確認はWorkerが済ませている） */
const SCHEDULE_PATH = '/schedule'

/** 予約を storage に持つときの鍵。1件しか持たないので決め打ちにする */
const PENDING_KEY = 'pending'

/** 広告の終了の予約 */
export interface AdBreakEnd {
  /**
   * 広告の開始の通知の中身（event）。
   *
   * 擬似イベントの照合でそのまま読む（alert-event.ts の extract は広告の開始と終了を同じ形で読む）ので、
   * 読み替えずに預かったまま返す。
   */
  event: Record<string, unknown>
  /** 広告の開始の通知のメッセージID。二重送信を防ぐ鍵の素にする */
  messageId: string
  /** 広告が終わる時刻（ミリ秒）。開始の時刻 + 長さ */
  endsAt: number
}

/**
 * Durable Object から使う保管の仕組み。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectState はこの形を満たす。
 */
export interface AdBreakTimerState {
  storage: {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<boolean>
    setAlarm(scheduledTime: number): Promise<void>
    /** 仕掛けたアラームを外す（ポモドーロのタイマーを一時停止したとき・止めたとき） */
    deleteAlarm(): Promise<void>
  }
}

/**
 * Worker が Durable Object を呼ぶための入口。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectNamespace はこの形を満たす。
 */
export interface AdBreakTimerNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

/**
 * アラームが鳴ったときに要る依存（worker/alarm-actions.ts の AlarmDependencies）。ポモドーロのタイマーも同じものを使う。
 */
export type AdBreakDependencies = AlarmDependencies

const PRODUCTION_DEPENDENCIES: AdBreakDependencies = {
  fetch: (input, init) => fetch(input, init),
  now: Date.now,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

/** 預け先（1つだけ）を指す */
const timerOf = (namespace: AdBreakTimerNamespace): { fetch(request: Request): Promise<Response> } => namespace.get(namespace.idFromName(TIMER_NAME))

/**
 * 広告が終わる時刻を Durable Object へ預ける。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側（webhook-routes.ts）が収集の失敗として記録し、
 * 管理画面から気づけるようにする。
 */
export const scheduleAdBreakEnd = async (namespace: AdBreakTimerNamespace, end: AdBreakEnd): Promise<void> => {
  const response = await timerOf(namespace).fetch(
    new Request(`https://ad-break-timer${SCHEDULE_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(end) }),
  )
  if (!response.ok) throw new Error(`広告の終了の予約を入れられませんでした（${response.status}）`)
}

/**
 * 広告が終わったものとして、当てはまるトリガーの動作を実行する。
 *
 * 通知の中身は開始のときのものをそのまま使う（Twitchから終了の通知は届かないので、ほかに材料がない）。
 * 鍵に使うメッセージIDには開始のものを使い回すが、実行のたびに動作の種類を混ぜるので（alert-actions.ts）、
 * 開始のときの送信と取り合いにはならない。
 *
 * 注意: LLMに文面を作らせる動作（aiChat）は応答を待つと遅いため、ふだんはTwitchへの応答後に回している。
 * アラームには待たせる相手がいないので、ここでは後回しにされた処理も最後まで待つ（待たずに終えると取りこぼす）。
 *
 * 注意: 失敗は投げずに収集の失敗（ad-break-end-failed）として記録する。呼び出し側は予約を消したあとなので、
 * 投げてアラームを再試行させても予約が無く空振りするだけで、失敗が誰にも届かないまま消えてしまう
 * （送信そのものの失敗は runAlertActions の中で動作ごとに記録される。ここで受け止めるのはその手前の失敗である）。
 */
const runAdBreakEnd = (env: Env, end: AdBreakEnd, dependencies: AdBreakDependencies): Promise<void> =>
  // 状態を持つ条件（初めての発言かなど）は発言ではないので使わない
  runAlarmActions(env, dependencies, 'ad-break-end-failed', AD_BREAK_END, { event: end.event }, `${end.messageId}:ad-end`)

/**
 * 広告の終了の時刻を預かり、そのときに動作を実行する Durable Object。
 *
 * 呼ぶのは Worker だけで、POST /schedule（広告の終了の予約）と、/pomodoro/ で始まるパス（ポモドーロのタイマーの操作。
 * worker/pomodoro-timer.ts の handlePomodoroRequest）と、POST /kanji-quiz/schedule（漢字クイズの時間切れの判定の予約。
 * worker/kanji-quiz-timer.ts の handleKanjiQuizTimerRequest）を受け付ける。
 */
export class AdBreakTimer {
  /**
   * @param dependencies アラームが鳴ったときに使う依存。Cloudflare は (state, env) の2つしか渡さないので、
   *   本番では既定のものが使われ、テストでは差し替えたものを渡す
   */
  constructor(
    private readonly ctx: AdBreakTimerState,
    private readonly env: Env,
    private readonly dependencies: AdBreakDependencies = PRODUCTION_DEPENDENCIES,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const pomodoroResponse = await handlePomodoroRequest(this.ctx.storage, this.env, this.dependencies, request)
    if (pomodoroResponse !== null) return pomodoroResponse
    const kanjiQuizResponse = await handleKanjiQuizTimerRequest(this.ctx.storage, request)
    if (kanjiQuizResponse !== null) return kanjiQuizResponse
    if (new URL(request.url).pathname !== SCHEDULE_PATH) return new Response(null, { status: STATUS.notFound })

    const end = (await request.json()) as AdBreakEnd
    // 予約は1件だけ持つ。広告中にもう1本の広告は始まらないので、残っていた予約は上書きしてよい
    await this.ctx.storage.put(PENDING_KEY, end)
    await this.ctx.storage.setAlarm(end.endsAt)
    return new Response(null, { status: STATUS.noContent })
  }

  /**
   * 広告が終わる時刻か、ポモドーロの区切りの時刻か、漢字クイズの判定・停止の時刻に呼ばれる。
   *
   * どのアラームかはインスタンスで決まる（storage はインスタンスごとに別なので、ポモドーロの状態があるのは pomodoro のインスタンスだけ、
   * 漢字クイズの時刻があるのは kanji-quiz のインスタンスだけ）。
   */
  async alarm(): Promise<void> {
    if (await runPomodoroAlarm(this.ctx.storage, this.env, this.dependencies)) return
    if (await runKanjiQuizAlarm(this.ctx.storage, this.env, this.dependencies)) return

    const end = await this.ctx.storage.get<AdBreakEnd>(PENDING_KEY)
    // 予約を消したあとにアラームが鳴ることはないが、鳴っても何もしないでおく（空振りを失敗にしない）
    if (end === undefined) return

    // 消してから実行する。実行が失敗したときにアラームの再試行で同じ告知を二度送らないため
    await this.ctx.storage.delete(PENDING_KEY)
    await runAdBreakEnd(this.env, end, this.dependencies)
  }
}
