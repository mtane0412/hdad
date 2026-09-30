/**
 * 画面から読み取った文字の篩
 *
 * Gyazo が配信画面から読み取った文字（screen_captures.ocr_text）は、そのままではあらすじにもサイドスーパーにも
 * 渡せない。画面には HDAD 自身が出している文字（サイドスーパー・チャットボックス・字幕）が映り込むうえ、
 * 同じ画面を撮り続けるあいだ同じ文字が毎回丸ごと返るためである。ここは、その中から
 * 「**まだ材料にしていない、画面にしかない文字**」だけを取り出す（issue #122 Phase 3）。
 *
 * LLM もデータベースも触らない純粋な関数だけを置く（buildStreamSummaryPrompt を分けているのと同じ形）。
 * 材料そのもの（自前の文字・既に渡した行）は呼び出し側が読んで渡す。
 *
 * 注意: 比べ方は完全一致ではなく、文字2連の重なり（Dice係数）である。OCRは同じ画面でも毎回違う文字を返す
 * （実測で「電承」→「電」、「2008」→「2006」）ので、完全一致では同じ画面を畳めない。実測では、完全一致だと
 * 2枚目の削減率が15%に留まり、2連の重なりにすると99%になった。**この判定方法を外すと、高頻度で撮る意味がなくなる。**
 */

/**
 * 行として残すのに要る、正規化したあとの最短の長さ。
 *
 * これより短い行は、読み取りのかけらか記号の飾りで、材料としての中身を持たない。
 */
export const SCREEN_LINE_MIN_LENGTH = 3

/**
 * 「同じ行」とみなす文字2連の重なりのしきい値。
 *
 * issue #122 の実測（配信画面3枚）で確かめた値である。これより下げると別の内容まで同じ行として畳み、
 * 上げるとOCRの揺れを吸収できず同じ画面が毎回そのまま残る。
 */
export const SCREEN_LINE_SIMILARITY = 0.7

/** 記号（約物と記号）。正規化で落とす */
const SYMBOLS = /[\p{P}\p{S}]/gu

/** 空白（全角・半角・改行を含む） */
const SPACES = /\s/gu

/** 数字だけの行（時計・順位・残り時間など、それだけでは材料にならないもの） */
const DIGITS_ONLY = /^\d+$/u

/**
 * 比べるために文字を揃える。
 *
 * 全角と半角の違い（NFKC）・大文字小文字・空白・記号だけを落とし、**文字そのものは落とさない**。
 * これ以上畳むと、本当に変わった行まで同じに見えてしまう。
 *
 * @param line 読み取った1行
 * @returns 比べるための形（材料として渡すのは元の行のままで、これではない）
 */
export const normalizeScreenLine = (line: string): string =>
  line.normalize('NFKC').toLowerCase().replace(SPACES, '').replace(SYMBOLS, '')

/** 文字2連の並び。1文字しかないときは、その1文字を1つの要素として扱う */
const bigramsOf = (text: string): string[] => {
  const characters = [...text]
  if (characters.length < 2) return characters
  return characters.slice(0, -1).map((character, index) => character + characters[index + 1])
}

/**
 * 文字2連の重なり（Dice係数）で、2つの行がどれだけ似ているかを測る。
 *
 * 同じ2連が両方に何度も現れるときは、少ないほうの回数だけ数える（「ああああ」と「ああ」を1と見ないため）。
 *
 * @returns 0（まったく重ならない）から1（同じ）までの値
 */
export const bigramSimilarity = (a: string, b: string): number => {
  const left = bigramsOf(a)
  const right = bigramsOf(b)
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 1 : 0

  const rest = new Map<string, number>()
  for (const bigram of left) rest.set(bigram, (rest.get(bigram) ?? 0) + 1)

  let overlap = 0
  for (const bigram of right) {
    const attempts = rest.get(bigram) ?? 0
    if (attempts === 0) continue
    rest.set(bigram, attempts - 1)
    overlap += 1
  }
  return (2 * overlap) / (left.length + right.length)
}

/** 「よく似ている」と判定する */
const resembles = (a: string, b: string): boolean => bigramSimilarity(a, b) >= SCREEN_LINE_SIMILARITY

/**
 * 自前の文字（HDAD 自身が画面に出しているもの）かどうか。
 *
 * 3通りで落とす。丸ごと含む（飾りや吹き出しの記号が付いて読み取られたとき）、一部でしかない
 * （チャットボックスの端で見切れたとき）、よく似ている（OCRの揺れ）。
 *
 * 注意: 短すぎる自前の文字では照合しない。1文字の表示名で画面の本文まで落としてしまうためである。
 */
const isOwnText = (line: string, ownTexts: readonly string[]): boolean =>
  ownTexts.some((own) => own.length >= SCREEN_LINE_MIN_LENGTH && (own.includes(line) || line.includes(own) || resembles(line, own)))

/**
 * 読み取った文字から、まだ材料にしていない行だけを取り出す。
 *
 * 篩は3段である。
 * 1. 自前の文字の除去（サイドスーパー・視聴者の発言と表示名・字幕）
 * 2. 中身のない行の除去（3文字未満、数字だけ）
 * 3. 既出の除去（その配信で既に渡した行に近いもの。**初出は必ず残す**）
 *
 * 「恒常表示の除去」を独立した段として持たず既出に統合しているのは、分けて持つと初出の本文まで落ち、
 * 一度も LLM に届かなかったためである（issue #122 の実測）。
 *
 * 注意: 同じ画面の中で繰り返された行も、2つ目以降は既出として落とす（残した行をその場で既出に足していく）。
 *
 * @param ocrText Gyazo が読み取った文字（行の区切りは改行）
 * @param ownTexts HDAD 自身が画面に出している文字
 * @param seenLines その配信で既に材料として渡した行
 * @returns 残った行（元の文字のまま、読み取った順）
 */
export const extractNewScreenLines = (ocrText: string, ownTexts: readonly string[], seenLines: readonly string[]): string[] => {
  const ownLines = ownTexts.map(normalizeScreenLine).filter((text) => text.length > 0)
  const seenSoFar = seenLines.map(normalizeScreenLine).filter((text) => text.length > 0)

  const remainingLines: string[] = []
  for (const originalLines of ocrText.split('\n')) {
    const line = normalizeScreenLine(originalLines)
    if (line.length < SCREEN_LINE_MIN_LENGTH || DIGITS_ONLY.test(line)) continue
    if (isOwnText(line, ownLines)) continue
    if (seenSoFar.some((seen) => resembles(line, seen))) continue
    seenSoFar.push(line)
    remainingLines.push(originalLines.trim())
  }
  return remainingLines
}
