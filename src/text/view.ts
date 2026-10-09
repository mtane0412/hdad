/**
 * テキストの表示
 *
 * 配信画面に出しっぱなしにする素材なので、DOMを扱うのはここだけにして、読み出し（api.ts）・形の確かめと選び方（entry.ts）・
 * 起動（src/overlay/stage.ts）から切り離す。
 *
 * 札は「名前（小さな見出し）・本文」の2つで、素材の箱いっぱいの固定の大きさで描く（本文の長さで枠の大きさを変えない）。
 * 枠の見た目はパラメータ frame（text.css の text-board--<値>）、本文が収まらないときの扱いはパラメータ overflow で決める。
 * - 固定（clip）: 本文の改行はそのまま出し、あふれた分は隠す
 * - 縮める（shrink）: 収まるまで本文の文字を縮める（CSS変数 --text-scale）
 * - 流す（marquee）: 本文を1行にまとめて帯（.text-board-track）に入れ、あふれたときだけ横に流す
 * 本文が空のあいだは札ごと隠す（書くことが無いあいだに空の板を映さない）。
 *
 * 注意: 名前も本文も変わらなければ要素に触らない。合成ページは開いたとき・つながるたび・5分おきに読み直すので、
 *   そのたびに書き換えると出現のアニメーションが走ってしまう。本文が変わったときだけ本文の要素を作り直し、新しい本文を浮かび上がらせる。
 * 注意: 縮める・流すは要素の大きさを測って決めるので、箱の大きさやフォントが変わったら起動側が refit を呼ぶ。
 */
import type { TextEntry } from './entry'
import { largestFittingScale, marqueeLine, marqueeMotion } from './fit'
import type { TextFrame, TextOverflow } from './params'

/** 縮めるときの文字の倍率の下限。これより小さいと配信画面で読めない */
const MIN_TEXT_SCALE = 0.4
/** 流す速さ（毎秒のピクセル数）。1文字（22px）を5〜6文字ぶん/秒で、読みながら追える速さにする */
const MARQUEE_PX_PER_SECOND = 120

/** 札の見た目の選び方（素材のパラメータから渡す） */
export interface TextLayout {
  readonly frame: TextFrame
  readonly overflow: TextOverflow
}

export interface TextView {
  /** 映すテキストを渡す。中身が変わったときだけ書き換える */
  show(text: TextEntry): void
  /** 本文を枠に収め直す（縮める・流すの大きさを測り直す）。箱の大きさやフォントが変わったときに呼ぶ */
  refit(): void
}

/**
 * 札を root の中に作る。
 *
 * @param root 札を入れる要素（素材の箱の中に置いたもの）
 * @param layout 枠の種類と、本文が収まらないときの扱い
 */
export const createTextView = (root: HTMLElement, layout: TextLayout): TextView => {
  const board = document.createElement('div')
  board.className = `text-board text-board--${layout.frame}`
  board.dataset.overflow = layout.overflow
  board.hidden = true
  const name = document.createElement('p')
  name.className = 'text-board-name'
  let body = document.createElement('p')
  body.className = 'text-board-body'
  board.append(name, body)
  root.append(board)

  /** 映している名前と本文。初めは何も映していない */
  let shown: { name: string; body: string } | null = null

  /** 本文の要素を作る。流すときは1行にまとめて帯に入れる（帯の幅が本文の幅になり、それを動かす） */
  const createBody = (text: string): HTMLParagraphElement => {
    const next = document.createElement('p')
    next.className = 'text-board-body'
    if (layout.overflow === 'marquee') {
      const track = document.createElement('span')
      track.className = 'text-board-track'
      track.textContent = marqueeLine(text)
      next.append(track)
    } else {
      next.textContent = text
    }
    return next
  }

  const refit = (): void => {
    if (board.hidden) return
    if (layout.overflow === 'shrink') {
      const scale = largestFittingScale((candidate) => {
        body.style.setProperty('--text-scale', String(candidate))
        return body.scrollHeight <= body.clientHeight && body.scrollWidth <= body.clientWidth
      }, MIN_TEXT_SCALE)
      body.style.setProperty('--text-scale', String(scale))
    }
    if (layout.overflow === 'marquee') {
      const track = body.querySelector<HTMLElement>('.text-board-track')
      if (track === null) return
      // 帯は本文の余白（padding）の内側から始まるので、余白を除いた幅を枠の幅として比べ、動きも同じ座標で決める
      const style = getComputedStyle(body)
      const viewWidth = body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const motion = marqueeMotion(viewWidth, track.scrollWidth, MARQUEE_PX_PER_SECOND)
      track.classList.toggle('is-moving', motion !== null)
      if (motion === null) return
      track.style.setProperty('--marquee-from', `${motion.from}px`)
      track.style.setProperty('--marquee-to', `${motion.to}px`)
      track.style.setProperty('--marquee-duration', `${motion.durationMs}ms`)
    }
  }

  return {
    show: (text) => {
      if (shown !== null && shown.name === text.name && shown.body === text.body) return
      name.textContent = text.name
      if (shown === null || shown.body !== text.body) {
        // 本文の要素を作り直して、出現のアニメーションを本文が変わったときにだけ走らせる
        const next = createBody(text.body)
        body.replaceWith(next)
        body = next
      }
      board.hidden = text.body === ''
      shown = { name: text.name, body: text.body }
      refit()
    },
    refit,
  }
}
