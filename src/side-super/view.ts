/**
 * サイドスーパーの表示
 *
 * 配信画面の隅に出しっぱなしにするテロップなので、DOMを扱うのはここだけにして、
 * 読み出し（api.ts）と起動（stage.ts）から切り離す。
 *
 * 注意: 同じ文言を読み直したときは、行の要素を作り直さない。オーバーレイは5分おきに読みに行くので、
 * 毎回作り直すと文言が変わっていなくても出現のアニメーション（side-super.css）が走ってしまう。
 * 注意: 文言が無いあいだは行を消して何も映さない。配信の前後にOBSを開いたままにするのが普通の
 * 使い方なので、その間は透過の枠だけが残るようにする。ボックス（.side-super-box）ごと消すのは、
 * 白い地だけが残ると「文言の無いテロップ」が配信画面に居座ってしまうためである。
 */

export interface SideSuperView {
  /** 出す行を書き換える。空の一覧を渡すと何も映さない */
  setLines(lines: readonly string[]): void
}

/**
 * サイドスーパーの表示を組み立てる。
 *
 * @param root 表示を入れる要素（side-super/index.html の [data-side-super]）
 */
export const createSideSuperView = (root: HTMLElement): SideSuperView => {
  /** いま映している行。読み直したときに作り直すかどうかの判定に使う */
  let 映している行: readonly string[] = []

  return {
    setLines(lines) {
      const 同じ = lines.length === 映している行.length && lines.every((line, index) => line === 映している行[index])
      if (同じ) return
      映している行 = [...lines]

      if (lines.length === 0) {
        root.replaceChildren()
        return
      }

      // バラエティ番組のテロップのように、行をひとつの白いボックスにまとめて出す
      const box = document.createElement('div')
      box.className = 'side-super-box'
      box.append(
        ...lines.map((line) => {
          const item = document.createElement('p')
          item.className = 'side-super-line'
          item.textContent = line
          return item
        }),
      )
      root.replaceChildren(box)
    },
  }
}
