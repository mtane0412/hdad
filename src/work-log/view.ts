/**
 * 作業ログの表示
 *
 * 配信画面に出しっぱなしにするログなので、DOMを扱うのはここだけにして、読み出し（api.ts）・行の重ね方（entry.ts）・
 * 起動（src/overlay/stage.ts）から切り離す。
 *
 * 1行は「時刻・種類の印・本文」の3つで、種類ごとに data-kind を付ける。機械（LLM）が作った章の見出しには
 * 「AIのまとめ」の印を付け、見た目（work-log.css）も実際に起きた出来事（コミット・マージ）と変える（方針11。
 * 機械が作った文を、実際に起きたことと同じ顔で並べない）。
 *
 * 注意: 行が増えたときに、すでに映している行の要素は作り直さない（id ごとに使い回す）。作り直すと、出現のアニメーションが
 * 増えた1行だけでなく全行で走ってしまう。
 */
import { clockOf, type WorkLogEntry, type WorkLogKind } from './entry'

/** 種類の印。章だけが機械のまとめであることを、印の言葉でも分かるようにする */
const MARKS: Readonly<Record<WorkLogKind, string>> = {
  commit: 'コミット',
  merge: 'マージ',
  chapter: 'AIのまとめ',
}

export interface WorkLogView {
  /** 映す行を書き換える。渡した順（新しい順）に上から並べる */
  setEntries(entries: readonly WorkLogEntry[]): void
}

/** 1行の要素を作る */
const createLine = (entry: WorkLogEntry): HTMLLIElement => {
  const line = document.createElement('li')
  line.className = 'work-log-entry'
  line.dataset.kind = entry.kind

  const time = document.createElement('time')
  time.className = 'work-log-time'
  time.dateTime = entry.at
  time.textContent = clockOf(entry.at)
  const mark = document.createElement('span')
  mark.className = 'work-log-mark'
  mark.textContent = MARKS[entry.kind]
  const text = document.createElement('span')
  text.className = 'work-log-text'
  text.textContent = entry.text

  line.append(time, mark, text)
  return line
}

/**
 * 作業ログの表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-work-log] の要素）
 */
export const createWorkLogView = (root: HTMLElement): WorkLogView => {
  const list = document.createElement('ol')
  list.className = 'work-log-list'
  root.append(list)
  /** 映している行と、その要素（id ごと）。行が増えたときに使い回す */
  let shown = new Map<string, { entry: WorkLogEntry; line: HTMLLIElement }>()

  return {
    setEntries(entries) {
      const next = new Map(
        entries.map((entry) => {
          const previous = shown.get(entry.id)
          // 同じ id でも中身が変わっていれば作り直す（変わる道は無いはずだが、古い中身を映したままにしない）
          const unchanged = previous !== undefined && previous.entry.kind === entry.kind && previous.entry.at === entry.at && previous.entry.text === entry.text
          return [entry.id, { entry, line: unchanged ? previous.line : createLine(entry) }]
        }),
      )
      list.replaceChildren(...[...next.values()].map(({ line }) => line))
      shown = next
    },
  }
}
