/**
 * 本文を固定の大きさの枠に収める計算
 *
 * テキストの札は素材の箱いっぱいの固定の大きさで描くので、本文が収まらないときの扱い（パラメータ overflow）が要る。
 * 要素の大きさを測るのは表示（view.ts）に任せ、ここには測った結果からの計算だけを置く（jsdom では大きさを測れないため）。
 * - 縮める（shrink）: 収まるいちばん大きな文字の倍率を二分探索で選ぶ
 * - 流す（marquee）: 本文を1行にまとめ、あふれたときだけ枠の右端から左へ一定の速さで流す
 */

/** 二分探索の回数。倍率の誤差は (1 - 下限) / 2^回数 で、8回なら下限0.4でも0.003に収まる */
const SEARCH_STEPS = 8

/**
 * 本文が収まるいちばん大きな文字の倍率を選ぶ。
 *
 * @param fits その倍率で本文が枠に収まるか（呼ぶたびに倍率を当てて測る）
 * @param min 倍率の下限。ここまで縮めても収まらなければ下限を返す（読めないほど小さくしない。あふれた分は隠れる）
 * @returns 1（縮めない）〜 min の倍率
 */
export const largestFittingScale = (fits: (scale: number) => boolean, min: number): number => {
  if (fits(1)) return 1
  let fitting = min
  let tooLarge = 1
  for (let step = 0; step < SEARCH_STEPS; step += 1) {
    const middle = (fitting + tooLarge) / 2
    if (fits(middle)) fitting = middle
    else tooLarge = middle
  }
  return fitting
}

/** 流す動き。横方向の位置（px）を from から to まで durationMs かけて動かす */
export interface MarqueeMotion {
  readonly from: number
  readonly to: number
  readonly durationMs: number
}

/**
 * 本文を流す動きを決める。
 *
 * 枠の右端から入り、本文の右端が枠の左端を抜けるまで流す（流れている途中で一部が欠けて見えないように、毎回まるごと通す）。
 *
 * @param viewWidth 本文を流す枠の幅（px）
 * @param contentWidth 1行にまとめた本文の幅（px）
 * @param pxPerSecond 流す速さ
 * @returns 収まっていれば null（流さない）
 */
export const marqueeMotion = (viewWidth: number, contentWidth: number, pxPerSecond: number): MarqueeMotion | null => {
  if (contentWidth <= viewWidth) return null
  return { from: viewWidth, to: -contentWidth, durationMs: ((viewWidth + contentWidth) / pxPerSecond) * 1000 }
}

/** 流す本文を1行にまとめる。改行は全角の空白に置き換え、空行は詰める */
export const marqueeLine = (body: string): string =>
  body
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('　')
