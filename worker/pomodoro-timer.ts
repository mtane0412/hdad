/**
 * ポモドーロのタイマー（Durable Object の中で状態と区切りのアラームを持つ）
 *
 * 作業配信で「みんなで同じリズムで作業している」感覚を出すため、25分の作業と5分の休憩を繰り返すタイマーを持ち、
 * 区切り（作業の開始・休憩の開始）でトリガーを動かし、休憩中は BGM を休憩の曲へ切り替える（issue #208）。
 *
 * 状態（始めた時刻・一時停止の時刻・次の区切り・休憩の前に流していた曲）は、広告の終了のタイマーと同じクラス
 * （worker/ad-break-timer.ts の AdBreakTimer）の別のインスタンス（名前 pomodoro）の storage に持つ。KV に置かないのは、
 * KV は書いた場所と別の場所で読むと古い値が返りうるため、アラームの中で「一時停止したのに区切りが鳴る」を起こさないためである。
 * 操作（始める・一時停止・再開・止める）もすべてこのインスタンスを通すので、操作とアラームは Durable Object の中で1つずつ順に処理される。
 *
 * Durable Object は時計であって判定者ではない（.claude/rules/implementation.md）。区間の計算は src/pomodoro/phase.ts、
 * どのトリガーに当てはまるかは worker/alert-event.ts、休憩の曲は KV の設定（worker/pomodoro-config.ts）を区切りのたびに読み直して決める。
 *
 * 配信していないときに区切りを迎えたら、トリガーを動かさずにタイマーを止める（休憩の前の曲へは戻す）。
 * 配信のあとに止め忘れたタイマーが、次の配信で「37本目」として出てこないようにするためである。始めるのは配信の前でもよい
 * （その場合は始めたときのトリガーだけ動かさない）。
 *
 * 注意: 合成ページへの押し出しと BGM の切り替えの失敗は投げずに記録する（pomodoro-push-failed・pomodoro-bgm-failed）。
 *   どちらも失敗したからといって区切りを止める理由にはならず、合成ページは開き直し・5分おきの読み直しで追いつく。
 *   トリガーの失敗も同じく記録する（pomodoro-trigger-failed。worker/alarm-actions.ts）。
 */
import { runAlarmActions, type AlarmDependencies } from './alarm-actions'
import { pushPomodoro } from './alert-channel'
import { HttpError, STATUS, errorResponse, type Env } from './http'
import { loadPomodoroSettings } from './pomodoro-config'
import { restoreBgmAfterBreak, switchToBreakBgm, type BgmBeforeBreak } from './pomodoro-bgm'
import { isStreaming } from './screen-store'
import { recordFailure } from './stats-store'
import { POMODORO_BREAK_BEGIN, POMODORO_WORK_BEGIN } from './trigger-menu'
import {
  nextBoundaryAt,
  pauseTimer,
  phaseAt,
  readPomodoroSnapshot,
  resumeTimer,
  startTimer,
  type PomodoroPhase,
  type PomodoroTimer,
} from '../src/pomodoro/phase'

/** Durable Object の名前。広告の終了のタイマー（ad-break）とアラームを取り合わないよう、別のインスタンスを指す */
const TIMER_NAME = 'pomodoro'
/** Worker が操作に使うパスの頭。外には出ない */
const PATH_PREFIX = '/pomodoro/'
/** 読み出しのパス（/pomodoro/read） */
const READ_COMMAND = 'read'
/** 状態を storage に持つときの鍵 */
const STATE_KEY = 'pomodoro'
const MILLISECONDS_PER_MINUTE = 60 * 1000

/** Worker から頼める操作 */
export const POMODORO_COMMANDS = ['start', 'pause', 'resume', 'stop'] as const
export type PomodoroCommand = (typeof POMODORO_COMMANDS)[number]

/** 合成ページへ押し出す・返すタイマー。止めているときは timer が null */
export interface PomodoroSnapshot {
  readonly timer: PomodoroTimer | null
}

/** storage に持つ状態。止めているときは持たない */
interface PomodoroState {
  readonly timer: PomodoroTimer
  /** 次の区切りの時刻（仕掛けたアラームの時刻）。一時停止しているあいだは null */
  readonly nextBoundaryAt: number | null
  /** 休憩の曲へ切り替えたときの、休憩の前の曲。休憩の曲へ切り替えていなければ null */
  readonly bgmBeforeBreak: BgmBeforeBreak | null
}

/**
 * Durable Object から使う保管の仕組み。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectStorage はこの形を満たす（worker/ad-break-timer.ts の AdBreakTimerState と同じもの）。
 */
export interface PomodoroStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  setAlarm(scheduledTime: number): Promise<void>
  deleteAlarm(): Promise<void>
}

/** Worker が Durable Object を呼ぶための入口（worker/ad-break-timer.ts の AdBreakTimerNamespace と同じ形） */
interface PomodoroNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

const timerOf = (namespace: PomodoroNamespace): { fetch(request: Request): Promise<Response> } => namespace.get(namespace.idFromName(TIMER_NAME))

const snapshotOf = (state: PomodoroState | undefined): PomodoroSnapshot => ({ timer: state?.timer ?? null })

/**
 * Durable Object の応答を読む。失敗なら、Durable Object が付けた code と文面のまま HttpError にして投げる
 * （409 の「もう動いています」などを、管理画面へそのまま返すため）。
 */
const readResponse = async (response: Response): Promise<PomodoroSnapshot> => {
  // Durable Object の中で投げたときの500は本文がJSONでないので、読めなければ状態コードだけを伝える
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body ? (body.error as { code?: unknown; message?: unknown } | null) : null
    throw new HttpError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'pomodoro-failed',
      typeof error?.message === 'string' ? error.message : `ポモドーロのタイマーを操作できませんでした（${response.status}）`,
    )
  }
  return { timer: readPomodoroSnapshot(body) }
}

/** いまのタイマーを読む（管理画面・合成ページの読み出し） */
export const readPomodoroTimer = async (namespace: PomodoroNamespace): Promise<PomodoroSnapshot> =>
  readResponse(await timerOf(namespace).fetch(new Request(`https://ad-break-timer${PATH_PREFIX}${READ_COMMAND}`)))

/**
 * タイマーを操作する。
 *
 * @returns 操作したあとのタイマー
 * @throws HttpError 今の状態ではできない操作（動いているのに始める・止めているのに一時停止する など）なら409
 */
export const controlPomodoro = async (namespace: PomodoroNamespace, command: PomodoroCommand): Promise<PomodoroSnapshot> =>
  readResponse(await timerOf(namespace).fetch(new Request(`https://ad-break-timer${PATH_PREFIX}${command}`, { method: 'POST' })))

/** 今の状態ではできない操作を断る */
const conflict = (code: string, message: string): Response => errorResponse(STATUS.conflict, code, message)

/** 失敗を記録する。記録そのものが失敗したら、もう打つ手がないのでログに残すだけにする（alert-actions.ts の recordLateFailure と同じ） */
const recordQuietly = async (env: Env, code: string, error: unknown, now: number): Promise<void> => {
  try {
    await recordFailure(env.DB, code, error instanceof Error ? error.message : String(error), now)
  } catch (failure) {
    console.error(failure)
  }
}

/** 合成ページへいまのタイマーを押し出す。失敗は記録だけにする */
const push = async (env: Env, snapshot: PomodoroSnapshot, now: number): Promise<void> => {
  try {
    await pushPomodoro(env.ALERTS, snapshot)
  } catch (error) {
    await recordQuietly(env, 'pomodoro-push-failed', error, now)
  }
}

/**
 * 区切りのトリガーを動かす。
 *
 * 鍵は「始めた時刻・何本目か・区間の種類」から作る。同じ区切りのアラームが再試行で二度鳴っても、同じ文言を二度送らない。
 */
const runBoundaryTriggers = (env: Env, dependencies: AlarmDependencies, timer: PomodoroTimer, phase: PomodoroPhase): Promise<void> =>
  runAlarmActions(
    env,
    dependencies,
    'pomodoro-trigger-failed',
    phase.kind === 'work' ? POMODORO_WORK_BEGIN : POMODORO_BREAK_BEGIN,
    { event: { round: phase.round, minutes: phase.durationMs / MILLISECONDS_PER_MINUTE } },
    `pomodoro:${timer.startedAt}:${phase.round}:${phase.kind}`,
  )

/**
 * 休憩の曲へ切り替える。休憩の曲を選んでいなければ何もしない。
 *
 * @returns 休憩の前の曲。切り替えなかった・切り替えに失敗したら null（失敗は記録する）
 */
const trySwitchToBreak = async (env: Env, now: number): Promise<BgmBeforeBreak | null> => {
  try {
    const { breakMediaId } = await loadPomodoroSettings(env.STORE)
    if (breakMediaId === null) return null
    return await switchToBreakBgm(env.STORE, env.ALERTS, breakMediaId, now)
  } catch (error) {
    await recordQuietly(env, 'pomodoro-bgm-failed', error, now)
    return null
  }
}

/** 休憩の前の曲へ戻す。休憩の曲へ切り替えていなければ何もしない。失敗は記録する */
const tryRestore = async (env: Env, before: BgmBeforeBreak | null, now: number): Promise<void> => {
  if (before === null) return
  try {
    await restoreBgmAfterBreak(env.STORE, env.ALERTS, before, now)
  } catch (error) {
    await recordQuietly(env, 'pomodoro-bgm-failed', error, now)
  }
}

/** タイマーを消し、休憩の前の曲へ戻し、止めたことを押し出す */
const stop = async (storage: PomodoroStorage, env: Env, state: PomodoroState, now: number): Promise<PomodoroSnapshot> => {
  await storage.delete(STATE_KEY)
  await storage.deleteAlarm()
  await tryRestore(env, state.bgmBeforeBreak, now)
  const snapshot = snapshotOf(undefined)
  await push(env, snapshot, now)
  return snapshot
}

/** 状態を保存し、次の区切りにアラームを仕掛ける（一時停止中なら外す） */
const save = async (storage: PomodoroStorage, state: PomodoroState): Promise<void> => {
  await storage.put(STATE_KEY, state)
  if (state.nextBoundaryAt === null) await storage.deleteAlarm()
  else await storage.setAlarm(state.nextBoundaryAt)
}

/** 操作を1つ実行する */
const runCommand = async (
  storage: PomodoroStorage,
  env: Env,
  dependencies: AlarmDependencies,
  command: PomodoroCommand,
  state: PomodoroState | undefined,
): Promise<Response> => {
  const now = dependencies.now()
  if (command === 'start') {
    if (state !== undefined) return conflict('pomodoro-running', 'ポモドーロのタイマーはもう動いています。始め直すときは、先に止めてください')
    // 配信中かは先に調べる。調べられずに投げたとき、始めたことにだけなってトリガーが動かない状態を残さないため
    const streaming = await isStreaming(env.DB, now)
    const timer = startTimer(now)
    await save(storage, { timer, nextBoundaryAt: nextBoundaryAt(timer, now), bgmBeforeBreak: null })
    const snapshot = { timer }
    await push(env, snapshot, now)
    if (streaming) await runBoundaryTriggers(env, dependencies, timer, phaseAt(timer, now))
    return Response.json(snapshot)
  }

  if (state === undefined) return conflict('pomodoro-stopped', 'ポモドーロのタイマーは動いていません')
  if (command === 'stop') return Response.json(await stop(storage, env, state, now))

  const { timer } = state
  if (command === 'pause' && timer.pausedAt !== null) return conflict('pomodoro-paused', 'ポモドーロのタイマーはもう一時停止しています')
  if (command === 'resume' && timer.pausedAt === null) return conflict('pomodoro-not-paused', 'ポモドーロのタイマーは一時停止していません')

  const next = command === 'pause' ? pauseTimer(timer, now) : resumeTimer(timer, now)
  await save(storage, { ...state, timer: next, nextBoundaryAt: nextBoundaryAt(next, now) })
  const snapshot = { timer: next }
  await push(env, snapshot, now)
  return Response.json(snapshot)
}

const isCommand = (value: string): value is PomodoroCommand => POMODORO_COMMANDS.some((command) => command === value)

/**
 * Durable Object に届いたリクエストのうち、ポモドーロのタイマーのもの（/pomodoro/ で始まるパス）を処理する。
 *
 * - GET /pomodoro/read: いまのタイマーを返す
 * - POST /pomodoro/start・pause・resume・stop: 操作して、操作したあとのタイマーを返す。今の状態でできない操作は409
 *
 * @returns ポモドーロのパスでなければ null（呼び出し側が広告の終了の予約として扱う）
 */
export const handlePomodoroRequest = async (
  storage: PomodoroStorage,
  env: Env,
  dependencies: AlarmDependencies,
  request: Request,
): Promise<Response | null> => {
  const { pathname } = new URL(request.url)
  if (!pathname.startsWith(PATH_PREFIX)) return null

  const command = pathname.slice(PATH_PREFIX.length)
  const state = await storage.get<PomodoroState>(STATE_KEY)
  if (command === READ_COMMAND) return Response.json(snapshotOf(state))
  if (!isCommand(command) || request.method !== 'POST') return new Response(null, { status: STATUS.notFound })
  return runCommand(storage, env, dependencies, command, state)
}

/**
 * 区切りのアラームを処理する。
 *
 * 区間は「アラームを仕掛けた時刻」と現在時刻の遅いほうで計算する（アラームがわずかに早く鳴っても、終わりかけの区間を
 * もう一度始めたことにしないため）。区切りの BGM を切り替えてから、次の区切りのアラームを仕掛け、トリガーを動かす。
 *
 * @returns ポモドーロの状態を持っていれば true（このインスタンスはポモドーロのもの）。持っていなければ false
 *   （呼び出し側が広告の終了のアラームとして扱う）
 */
export const runPomodoroAlarm = async (storage: PomodoroStorage, env: Env, dependencies: AlarmDependencies): Promise<boolean> => {
  const state = await storage.get<PomodoroState>(STATE_KEY)
  if (state === undefined) return false
  // 一時停止のあとに鳴ることはない（外しているため）が、鳴っても区切りは進めない
  if (state.nextBoundaryAt === null) return true

  const now = dependencies.now()
  if (!(await isStreaming(env.DB, now))) {
    await stop(storage, env, state, now)
    return true
  }

  const { timer } = state
  const at = Math.max(now, state.nextBoundaryAt)
  const phase = phaseAt(timer, at)
  let { bgmBeforeBreak } = state
  if (phase.kind === 'break' && bgmBeforeBreak === null) bgmBeforeBreak = await trySwitchToBreak(env, now)
  if (phase.kind === 'work' && bgmBeforeBreak !== null) {
    await tryRestore(env, bgmBeforeBreak, now)
    bgmBeforeBreak = null
  }
  await save(storage, { timer, nextBoundaryAt: nextBoundaryAt(timer, at), bgmBeforeBreak })
  await runBoundaryTriggers(env, dependencies, timer, phase)
  return true
}
