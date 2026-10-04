/**
 * 紹介の文の折り返し
 *
 * Canvas 2D は文を折り返さないので、幅を測りながら1文字ずつ行へ詰める。紹介は日本語で単語の区切りが無いため、
 * どの文字の間でも折り返してよいものとし、句読点と閉じかっこだけは行の頭に置かない（前の行の末尾にぶら下げる）。
 */

/** 行の頭に置かない文字（句読点・閉じかっこ・長音） */
const NO_LINE_START = new Set([...'。、．，」』）〕】〉》！？ー'])

/**
 * 文を、幅に収まる行の列にする。
 *
 * @param maxWidth 1行の幅の上限（measure と同じ単位）
 * @param measure 文字列の幅を測る（合成ページでは ctx.measureText の幅。テストでは文字数）
 */
export const wrapText = (text: string, maxWidth: number, measure: (text: string) => number): string[] =>
  [...text].reduce<string[]>((lines, char) => {
    const last = lines.at(-1)
    if (last === undefined) return [char]
    // 幅に収まるか、行の頭に置けない文字なら、いまの行に足す（ぶら下げた分だけ幅を少し超えてよい）
    if (measure(last + char) <= maxWidth || NO_LINE_START.has(char)) return [...lines.slice(0, -1), last + char]
    return [...lines, char]
  }, [])
