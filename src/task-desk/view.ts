/**
 * 作業机の表示
 *
 * 配信画面に出しっぱなしにする素材なので、DOMを扱うのはここだけにして、読み出し（api.ts）・形の確かめ（entry.ts）・
 * 起動（src/overlay/stage.ts）から切り離す。
 *
 * 1行は「チェックの印・名前・作業」の3つで、完了した行には data-done を付ける。映しているあいだに完了した行には
 * data-celebrate を付け、見た目（task-desk.css）で小さく祝う。行の下には参加のしかた（!task・!done）をいつも出しておく
 * （作業配信に来たばかりの人が、見ているだけでなく参加できると分かるように）。
 * 行と参加のしかたのあいだには、配信でみんなが作業した時間の合計を出す（issue #209）。記録が無いあいだは隠す（0分と出さない）。
 *
 * 注意: 変わっていない行の要素は作り直さない（userId ごとに使い回す）。作り直すと、出現と祝いのアニメーションが
 * 変わった行だけでなく全行で走ってしまう。
 */
import { justCompleted, workTimeText, type TaskDeskEntry, type TaskDeskWorkTime } from './entry'

/** 参加のしかた。worker/task-desk.ts の組み込みのコマンドと合わせる */
const HINT = '!task 作業の内容 で宣言・!done で完了'

/** 作業した時間の合計に添える見出し。ダッシュボードの配信の詳細と同じ呼び方にする */
const TOTAL_LABEL = 'みんなの作業時間'

export interface TaskDeskView {
  /** 映す行を書き換える。渡した順（未完了が上）に並べる */
  setEntries(entries: readonly TaskDeskEntry[]): void
  /**
   * 作業した時間の合計を、いまの時刻まで進めて映す。毎フレーム呼ばれるので、文が変わったときだけ書き換える。
   *
   * @param workTime 合計。記録が無ければ null で、そのあいだは隠す
   */
  renderWorkTime(workTime: TaskDeskWorkTime | null, now: number): void
}

/** 行の中身が同じか。同じなら要素を使い回す */
const sameEntry = (left: TaskDeskEntry, right: TaskDeskEntry): boolean =>
  left.name === right.name && left.task === right.task && left.declaredAt === right.declaredAt && left.doneAt === right.doneAt

/** 1行の要素を作る */
const createRow = (entry: TaskDeskEntry, celebrate: boolean): HTMLLIElement => {
  const row = document.createElement('li')
  row.className = 'task-desk-entry'
  if (entry.doneAt !== null) row.dataset.done = ''
  if (celebrate) row.dataset.celebrate = ''

  // 印は形（チェック）で見せ、読み上げには言葉で伝える
  const check = document.createElement('span')
  check.className = 'task-desk-check'
  check.setAttribute('role', 'img')
  check.setAttribute('aria-label', entry.doneAt === null ? '作業中' : '完了')
  const name = document.createElement('span')
  name.className = 'task-desk-name'
  name.textContent = entry.name
  const task = document.createElement('span')
  task.className = 'task-desk-task'
  task.textContent = entry.task

  row.append(check, name, task)
  return row
}

/**
 * 作業机の表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-task-desk] の要素）
 */
export const createTaskDeskView = (root: HTMLElement): TaskDeskView => {
  const list = document.createElement('ol')
  list.className = 'task-desk-list'
  const total = document.createElement('p')
  total.className = 'task-desk-total'
  total.hidden = true
  const totalLabel = document.createElement('span')
  totalLabel.className = 'task-desk-total-label'
  totalLabel.textContent = TOTAL_LABEL
  const totalValue = document.createElement('span')
  totalValue.className = 'task-desk-total-value'
  // 見出しと値のあいだの空白は、読み上げでも区切れるように文字として入れる
  total.append(totalLabel, ' ', totalValue)
  const hint = document.createElement('p')
  hint.className = 'task-desk-hint'
  hint.textContent = HINT
  root.append(list, total, hint)
  /** 映している行と、その要素（userId ごと）。変わっていない行の要素を使い回す */
  let shown = new Map<string, { entry: TaskDeskEntry; row: HTMLLIElement }>()

  return {
    setEntries(entries) {
      const next = new Map(
        entries.map((entry) => {
          const previous = shown.get(entry.userId)
          if (previous !== undefined && sameEntry(previous.entry, entry)) return [entry.userId, previous]
          return [entry.userId, { entry, row: createRow(entry, justCompleted(previous?.entry, entry)) }]
        }),
      )
      list.replaceChildren(...[...next.values()].map(({ row }) => row))
      shown = next
    },
    renderWorkTime(workTime, now) {
      total.hidden = workTime === null
      if (workTime === null) return
      const text = workTimeText(workTime, now)
      if (totalValue.textContent !== text) totalValue.textContent = text
    },
  }
}
