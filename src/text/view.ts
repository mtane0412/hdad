/**
 * テキストの表示
 *
 * 配信画面に出しっぱなしにする素材なので、DOMを扱うのはここだけにして、読み出し（api.ts）・形の確かめと選び方（entry.ts）・
 * 起動（src/overlay/stage.ts）から切り離す。
 *
 * 札は「名前（小さな見出し）・本文」の2つで、本文の改行はそのまま出す（text.css の white-space）。本文が空のあいだは札ごと隠す
 * （書くことが無いあいだに空の板を映さない）。
 *
 * 注意: 名前も本文も変わらなければ要素に触らない。合成ページは開いたとき・つながるたび・5分おきに読み直すので、
 *   そのたびに書き換えると出現のアニメーションが走ってしまう。本文が変わったときだけ本文の要素を作り直し、新しい本文を浮かび上がらせる。
 */
import type { TextEntry } from './entry'

export interface TextView {
  /** 映すテキストを渡す。中身が変わったときだけ書き換える */
  show(text: TextEntry): void
}

/**
 * 札を root の中に作る。
 *
 * @param root 札を入れる要素（素材の箱の中に置いたもの）
 */
export const createTextView = (root: HTMLElement): TextView => {
  const board = document.createElement('div')
  board.className = 'text-board'
  board.hidden = true
  const name = document.createElement('p')
  name.className = 'text-board-name'
  let body = document.createElement('p')
  body.className = 'text-board-body'
  board.append(name, body)
  root.append(board)

  /** 映している名前と本文。初めは何も映していない */
  let shown: { name: string; body: string } | null = null

  return {
    show: (text) => {
      if (shown !== null && shown.name === text.name && shown.body === text.body) return
      name.textContent = text.name
      if (shown === null || shown.body !== text.body) {
        // 本文の要素を作り直して、出現のアニメーションを本文が変わったときにだけ走らせる
        const next = document.createElement('p')
        next.className = 'text-board-body'
        next.textContent = text.body
        body.replaceWith(next)
        body = next
      }
      board.hidden = text.body === ''
      shown = { name: text.name, body: text.body }
    },
  }
}
