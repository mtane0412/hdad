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
 */
import { runAlertActions } from './alert-actions'
import { AD_BREAK_END } from './alert-config'
import { STATUS, type Env } from './http'
import { loadToken } from './token'
import { createTwitchClient } from './twitch'

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
 * アラームが鳴ったときに要る依存。Cloudflare のランタイムから受け取れないものをテストで差し替えるために分ける
 * （Workerの入口が fetch・現在時刻を引数で受け取るのと同じ作り）。
 */
export interface AdBreakDependencies {
  fetch: typeof fetch
  /** 現在時刻（ミリ秒） */
  now(): number
  /** 指定した時間だけ待つ。アナウンスの送信間隔を空けるのに使う */
  wait(milliseconds: number): Promise<void>
}

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
 */
const runAdBreakEnd = async (env: Env, end: AdBreakEnd, dependencies: AdBreakDependencies): Promise<void> => {
  const 後回しの処理: Promise<unknown>[] = []
  const twitch = createTwitchClient({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, fetch: dependencies.fetch })
  const context = {
    env,
    twitch,
    now: dependencies.now(),
    wait: dependencies.wait,
    waitUntil: (promise: Promise<unknown>): void => void 後回しの処理.push(promise),
  }

  // botの接続はここで調べる（チャット・アナウンスの動作は送り主のアカウントが要る）。
  // 通知の中身は預かったものをそのまま渡し、状態を持つ条件（初めての発言かなど）は発言ではないので使わない
  await runAlertActions(context, AD_BREAK_END, { event: end.event }, `${end.messageId}:ad-end`, async () => (await loadToken(env.STORE, 'bot')) !== null, null)
  await Promise.all(後回しの処理)
}

/**
 * 広告の終了の時刻を預かり、そのときに動作を実行する Durable Object。
 *
 * 呼ぶのは Worker だけで、POST /schedule（予約）だけを受け付ける。
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
    if (new URL(request.url).pathname !== SCHEDULE_PATH) return new Response(null, { status: STATUS.notFound })

    const end = (await request.json()) as AdBreakEnd
    // 予約は1件だけ持つ。広告中にもう1本の広告は始まらないので、残っていた予約は上書きしてよい
    await this.ctx.storage.put(PENDING_KEY, end)
    await this.ctx.storage.setAlarm(end.endsAt)
    return new Response(null, { status: STATUS.noContent })
  }

  /** 広告が終わる時刻に呼ばれる。預かった中身を擬似イベントとして照合へ回す */
  async alarm(): Promise<void> {
    const end = await this.ctx.storage.get<AdBreakEnd>(PENDING_KEY)
    // 予約を消したあとにアラームが鳴ることはないが、鳴っても何もしないでおく（空振りを失敗にしない）
    if (end === undefined) return

    // 消してから実行する。実行が失敗したときにアラームの再試行で同じ告知を二度送らないため
    await this.ctx.storage.delete(PENDING_KEY)
    await runAdBreakEnd(this.env, end, this.dependencies)
  }
}
