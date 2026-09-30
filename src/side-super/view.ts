/**
 * サイドスーパーの表示
 *
 * 配信画面の隅に出しっぱなしにするテロップなので、DOMを扱うのはここだけにして、
 * 読み出し（api.ts）と起動（stage.ts）から切り離す。
 *
 * テレビのサイドスーパーと同じく、上段（見出し＝コーナー名）と下段（本文＝いまの話題）を
 * 別々の要素として出す。ひとつの箱にまとめると、テロップではなくWebの通知カードに見えてしまうためである。
 * 行の役割は worker/side-super.ts が決めており、ここは受け取った順（1行目が見出し、2行目が本文）に置くだけである。
 *
 * 注意: 同じ文言を読み直したときは、行の要素を作り直さない。オーバーレイは30秒おきに読みに行くので、
 * 毎回作り直すと文言が変わっていなくても出現のアニメーション（side-super.css）が走ってしまう。
 * 注意: 文言が無いあいだは行を消して何も映さない。配信の前後にOBSを開いたままにするのが普通の
 * 使い方なので、その間は透過の枠だけが残るようにする。
 * 注意: 2行でも0行でもない行数を渡されたら投げる（Fail-Fast）。黙って見出しだけ・本文だけを映すと、
 * Workerの作りが変わって片方が届かなくなっていることに配信中は気付けない。
 */

/** サイドスーパーの行数（見出しと本文）。worker/side-super.ts の SIDE_SUPER_LINES と揃える */
const SIDE_SUPER_LINES = 2

export interface SideSuperView {
  /** 出す行を書き換える。渡せるのは2行（見出し・本文）か、何も映さないための空の一覧だけ */
  setLines(lines: readonly string[]): void
}

/**
 * サイドスーパーの表示を組み立てる。
 *
 * @param root 表示を入れる要素（合成ページが作る [data-side-super] の要素）
 */
export const createSideSuperView = (root: HTMLElement): SideSuperView => {
  /** いま映している行。読み直したときに作り直すかどうかの判定に使う */
  let shownLines: readonly string[] = []

  return {
    setLines(lines) {
      if (lines.length !== 0 && lines.length !== SIDE_SUPER_LINES) {
        throw new Error(`サイドスーパーは${SIDE_SUPER_LINES}行で届くはずですが、${lines.length}行でした`)
      }

      const isUnchanged = lines.length === shownLines.length && lines.every((line, index) => line === shownLines[index])
      if (isUnchanged) return
      shownLines = [...lines]

      if (lines.length === 0) {
        root.replaceChildren()
        return
      }

      const [head, body] = lines
      const headElement = document.createElement('p')
      headElement.className = 'side-super-head'
      headElement.textContent = head ?? ''
      const bodyElement = document.createElement('p')
      bodyElement.className = 'side-super-body'
      bodyElement.textContent = body ?? ''
      root.replaceChildren(headElement, bodyElement)
    },
  }
}
