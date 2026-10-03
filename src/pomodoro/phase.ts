/**
 * ポモドーロのタイマーの形と、区間（作業か休憩か・何本目か・残り時間）の計算
 *
 * 作業配信で「みんなで同じリズムで作業している」感覚を出すため、25分の作業と5分の休憩を繰り返すタイマーを配信画面に出す（issue #208）。
 * タイマーは「始めた時刻」「経過の起点（一時停止していたぶんだけ後ろへずらした時刻）」「一時停止した時刻」だけを持ち、
 * いまが作業か休憩か・何本目か・残り何秒かは、現在時刻を渡してその都度ここで計算する。残り時間をフレームごとに数え下げる状態は持たない
 * （描画を現在時刻だけから決める約束のため。時計の素材と同じ）。
 *
 * 計算の持ち主はこのファイルだけである。合成ページの素材・アプリのページ（/pomodoro/）・Worker のアラーム（worker/pomodoro-timer.ts）が
 * すべてこれを呼ぶ（区切りの時刻を2か所で計算すると、画面の0:00とトリガーの鳴る時刻が食い違うため）。
 * そのため Worker から src/ を読み込む例外になっており（src/draw/strokes.ts に続く2例目）、DOMにも通信にも触れず、ほかのファイルも読み込まない。
 *
 * 注意: 長さは25分・5分に決め切っており、長い休憩（4本ごと など）は持たない（設定項目を増やさないため。docs/decisions/pomodoro.md）。
 * 注意: 想定した形でなければ投げる（Fail-Fast）。
 */

const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MILLISECONDS_PER_MINUTE = SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND
/** 作業の長さ（分） */
const WORK_MINUTES = 25
/** 休憩の長さ（分） */
const BREAK_MINUTES = 5
/** 作業の長さ（ミリ秒） */
export const WORK_MS = WORK_MINUTES * MILLISECONDS_PER_MINUTE
/** 休憩の長さ（ミリ秒） */
export const BREAK_MS = BREAK_MINUTES * MILLISECONDS_PER_MINUTE
/** 作業と休憩の1周の長さ（ミリ秒） */
const CYCLE_MS = WORK_MS + BREAK_MS
/** 分と秒を2桁で出すための桁数 */
const TIME_DIGITS = 2

/** 動いている（一時停止を含む）タイマー。止めているときはタイマーそのものを持たない（null） */
export interface PomodoroTimer {
  /**
   * 始めた時刻（ミリ秒）。一時停止しても変えない。
   *
   * 区切りごとのトリガーの鍵の素にする（同じタイマーの同じ区切りで二重に鳴らさないため）。
   */
  readonly startedAt: number
  /** 経過の起点（ミリ秒）。一時停止していた時間だけ後ろへずらすので、(現在時刻 - これ) がタイマーの経過時間になる */
  readonly anchorAt: number
  /** 一時停止した時刻（ミリ秒）。動いていれば null */
  readonly pausedAt: number | null
}

/** 区間の種類。作業（work）か休憩（break）か */
export type PomodoroPhaseKind = 'work' | 'break'

/** いまの区間 */
export interface PomodoroPhase {
  readonly kind: PomodoroPhaseKind
  /** 何本目か（1から数える）。休憩は直前の作業と同じ番号にする */
  readonly round: number
  /** 区間の残り（ミリ秒） */
  readonly remainingMs: number
  /** 区間の長さ（ミリ秒）。進み具合の棒を描くのに使う */
  readonly durationMs: number
}

/** いま始めたタイマー */
export const startTimer = (now: number): PomodoroTimer => ({ startedAt: now, anchorAt: now, pausedAt: null })

/**
 * タイマーの経過時間（ミリ秒）。
 *
 * 一時停止しているあいだは止めた時刻で数える。現在時刻が起点より前（合成ページを映すPCの時計が Worker より遅れている）なら
 * 0 とみなす（負の経過で残り時間が25分を超えて見えないようにするため）。
 */
const elapsedOf = (timer: PomodoroTimer, now: number): number => Math.max(0, (timer.pausedAt ?? now) - timer.anchorAt)

/** 現在時刻での区間を計算する */
export const phaseAt = (timer: PomodoroTimer, now: number): PomodoroPhase => {
  const elapsed = elapsedOf(timer, now)
  const cycleIndex = Math.floor(elapsed / CYCLE_MS)
  const inCycle = elapsed - cycleIndex * CYCLE_MS
  const round = cycleIndex + 1
  if (inCycle < WORK_MS) return { kind: 'work', round, remainingMs: WORK_MS - inCycle, durationMs: WORK_MS }
  return { kind: 'break', round, remainingMs: CYCLE_MS - inCycle, durationMs: BREAK_MS }
}

/**
 * 次の区切り（作業から休憩、休憩から作業へ変わる時刻。ミリ秒）。
 *
 * 区切りちょうどの時刻を渡したら、その次の区切りを返す（アラームが鳴った時刻から次を仕掛けるときに、同じ区切りへ仕掛け直さないため）。
 *
 * @returns 一時停止しているあいだは区切りが来ないので null
 */
export const nextBoundaryAt = (timer: PomodoroTimer, now: number): number | null => {
  if (timer.pausedAt !== null) return null
  return now + phaseAt(timer, now).remainingMs
}

/**
 * 一時停止する。
 *
 * @throws もう一時停止している場合（止めた時刻を後ろへずらすと、止めていた時間が経過に混ざるため）
 */
export const pauseTimer = (timer: PomodoroTimer, now: number): PomodoroTimer => {
  if (timer.pausedAt !== null) throw new Error('ポモドーロのタイマーはもう一時停止しています')
  return { ...timer, pausedAt: now }
}

/**
 * 一時停止から再開する。止めていた時間だけ起点を後ろへずらし、続きから進める。
 *
 * @throws 一時停止していない場合
 */
export const resumeTimer = (timer: PomodoroTimer, now: number): PomodoroTimer => {
  if (timer.pausedAt === null) throw new Error('ポモドーロのタイマーは一時停止していません')
  return { ...timer, anchorAt: timer.anchorAt + (now - timer.pausedAt), pausedAt: null }
}

/** 残り時間を「分:秒」（どちらも2桁）で出す。1秒に満たない端数は切り上げ、0:00 になるのは区切りの瞬間だけにする */
export const formatRemaining = (remainingMs: number): string => {
  const totalSeconds = Math.ceil(remainingMs / MILLISECONDS_PER_SECOND)
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds - minutes * SECONDS_PER_MINUTE
  return `${String(minutes).padStart(TIME_DIGITS, '0')}:${String(seconds).padStart(TIME_DIGITS, '0')}`
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** タイマーとして読めるか */
export const isPomodoroTimer = (value: unknown): value is PomodoroTimer =>
  isRecord(value) &&
  typeof value.startedAt === 'number' &&
  typeof value.anchorAt === 'number' &&
  (typeof value.pausedAt === 'number' || value.pausedAt === null)

/**
 * Worker が返す・押し出すタイマー（{ timer: タイマーか null }）を読む。
 *
 * @returns 止めているときは null
 * @throws 想定した形でない場合（黙って「止めている」として扱うと、Workerの作りが変わってタイマーが届かなくなっても気づけない）
 */
export const readPomodoroSnapshot = (body: unknown): PomodoroTimer | null => {
  if (!isRecord(body) || !('timer' in body)) throw new Error('ポモドーロのタイマーの応答に timer がありません')
  const { timer } = body
  if (timer === null) return null
  if (!isPomodoroTimer(timer)) throw new Error('ポモドーロのタイマーの形が想定と違います')
  return timer
}

/**
 * WebSocket で押し出された文字列を、タイマーとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parsePomodoroSnapshot = (payload: string): PomodoroTimer | null => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出されたポモドーロのタイマーをJSONとして読めません')
  }
  return readPomodoroSnapshot(body)
}
