/**
 * ポモドーロの表示
 *
 * 合成ページの素材「ポモドーロ」の DOM を扱うのはここだけにして、区間の計算（phase.ts）・読み出し（api.ts）・
 * 起動（src/overlay/stage.ts）から切り離す。
 *
 * 札は「区間の名前（作業中・休憩中・一時停止中）・何本目か・残り時間・進み具合の棒」の4つで、区間の種類を data-phase（work・break）に、
 * 一時停止を data-paused に持たせ、色分けは見た目（pomodoro.css）が決める。止めているときは札ごと隠す。
 *
 * 描画は渡されたタイマーと現在時刻だけから決める（フレームをまたぐ状態として持つのは「いま映している文字」だけで、
 * これは書き換えを省くためのもの）。合成ページの描画のループから毎フレーム呼ばれるので、文字が変わらないときは要素に触れない。
 */
import { formatRemaining, phaseAt, type PomodoroTimer } from './phase'

/** 進み具合の棒の割合の桁（小数第3位まで）。毎フレームの書き換えを、目に見える変化があるときだけにする */
const PROGRESS_DIGITS = 3

export interface PomodoroView {
  /**
   * 札を描き直す。
   *
   * @param timer いまのタイマー。止めていれば null（札を隠す）
   * @param now 現在時刻（ミリ秒）
   */
  render(timer: PomodoroTimer | null, now: number): void
}

/** 文字が変わったときだけ書き換える */
const setText = (element: HTMLElement, text: string): void => {
  if (element.textContent !== text) element.textContent = text
}

/**
 * ポモドーロの表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-pomodoro] の要素）
 */
export const createPomodoroView = (root: HTMLElement): PomodoroView => {
  const phaseLabel = document.createElement('span')
  phaseLabel.className = 'pomodoro-phase'
  const round = document.createElement('span')
  round.className = 'pomodoro-round'
  const remaining = document.createElement('span')
  remaining.className = 'pomodoro-remaining'
  const progress = document.createElement('div')
  progress.className = 'pomodoro-progress'
  // 棒は飾りで、残り時間は文字で読めるので、読み上げからは外す
  progress.setAttribute('aria-hidden', 'true')
  const heading = document.createElement('div')
  heading.className = 'pomodoro-heading'
  heading.append(phaseLabel, round)
  root.append(heading, remaining, progress)
  root.hidden = true

  return {
    render(timer, now) {
      if (timer === null) {
        root.hidden = true
        return
      }
      const phase = phaseAt(timer, now)
      const paused = timer.pausedAt !== null
      root.hidden = false
      if (root.dataset.phase !== phase.kind) root.dataset.phase = phase.kind
      if (paused) root.dataset.paused = ''
      else delete root.dataset.paused

      setText(phaseLabel, paused ? '一時停止中' : phase.kind === 'work' ? '作業中' : '休憩中')
      setText(round, `${phase.round}本目`)
      setText(remaining, formatRemaining(phase.remainingMs))
      const ratio = String(Number((1 - phase.remainingMs / phase.durationMs).toFixed(PROGRESS_DIGITS)))
      if (progress.style.getPropertyValue('--pomodoro-progress') !== ratio) progress.style.setProperty('--pomodoro-progress', ratio)
    },
  }
}
