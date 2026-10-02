/**
 * 字幕の表示（合成ページの素材「字幕」）
 *
 * 映す行（captions.ts の visibleCaptions）をDOMへ出す。DOMを扱うのはここだけにして、字幕の受け取り
 * （src/overlay/stage.ts の mountCaption）から切り離す。
 *
 * 注意: 合成ページは毎フレーム映す行を渡してくるので、前と同じなら要素に触れない。毎フレーム作り直すと、
 * 何も変わっていないあいだも配信画面の描き直しが走る。
 */
import type { CaptionLine } from './captions'

export interface CaptionView {
  /** 映す行を渡す（上から下へ。空なら何も映さない） */
  render(lines: readonly CaptionLine[]): void
}

/** 映している行と同じか */
const sameLines = (a: readonly CaptionLine[], b: readonly CaptionLine[]): boolean =>
  a.length === b.length && a.every((line, index) => line.text === b[index]?.text && line.final === b[index]?.final)

/**
 * 字幕の表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-caption] の要素）
 */
export const createCaptionView = (root: HTMLElement): CaptionView => {
  let displayed: readonly CaptionLine[] = []

  return {
    render(lines) {
      if (sameLines(displayed, lines)) return
      displayed = lines
      root.replaceChildren(
        ...lines.map((line) => {
          const element = document.createElement('p')
          element.className = 'caption-line'
          element.dataset.final = String(line.final)
          element.textContent = line.text
          return element
        }),
      )
    },
  }
}
