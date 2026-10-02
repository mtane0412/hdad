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

/** 文字2連ごとの出現回数を数える */
const countBigrams = (bigrams: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const bigram of bigrams) counts.set(bigram, (counts.get(bigram) ?? 0) + 1)
  return counts
}

/** 似た行を探すための索引 */
interface LineIndex {
  /** 行を索引に加える */
  add(line: string): void
  /** 索引にある行のどれかと「よく似ている」（bigramSimilarity がしきい値以上）か */
  resemblesAny(line: string): boolean
}

/**
 * 文字2連から、それを含む行を引ける索引を作る。
 *
 * 1行ずつ全部と bigramSimilarity で比べると、行のたびに両方の2連を作り直すうえ、比べる回数が
 * 「読み取った行の数 × 既出の行の数」になる。Workers の Free プランの CPU 時間（1回10ms）では、
 * 配信の終盤（既出が上限の300行に達し、1枚の行数も多い画面）に1枚ぶんすら収まらず、cron ごと
 * 強制終了されていた（2026-10-02 の配信で実測）。索引では、2連を1つでも共有する行だけを数えるので、
 * 共有しない大半の行には触れずに済む。
 *
 * 注意: 判定の結果は、全部と bigramSimilarity で比べたときと同じでなければならない
 * （worker/screen-ocr.test.ts で確かめている）。重なりは bigramSimilarity と同じく、同じ2連の
 * 少ないほうの回数だけ数える。
 */
const createLineIndex = (lines: readonly string[]): LineIndex => {
  /** 行ごとの2連の総数（行の番号で引く） */
  const bigramTotals: number[] = []
  /** 2連ごとの、それを含む行の番号と、その行での出現回数 */
  const postings = new Map<string, { lineId: number; count: number }[]>()
  /** 空の行を持っているか（空どうしは bigramSimilarity が1を返すので、索引の外で覚えておく） */
  let hasEmptyLine = false

  const add = (line: string): void => {
    const bigrams = bigramsOf(line)
    if (bigrams.length === 0) {
      hasEmptyLine = true
      return
    }
    const lineId = bigramTotals.push(bigrams.length) - 1
    for (const [bigram, count] of countBigrams(bigrams)) {
      const entries = postings.get(bigram)
      if (entries) entries.push({ lineId, count })
      else postings.set(bigram, [{ lineId, count }])
    }
  }

  const resemblesAny = (line: string): boolean => {
    const bigrams = bigramsOf(line)
    if (bigrams.length === 0) return hasEmptyLine

    // 2連を共有する行ごとに、重なりの数を足し上げる
    const overlaps = new Map<number, number>()
    for (const [bigram, count] of countBigrams(bigrams)) {
      for (const entry of postings.get(bigram) ?? []) {
        overlaps.set(entry.lineId, (overlaps.get(entry.lineId) ?? 0) + Math.min(count, entry.count))
      }
    }
    for (const [lineId, overlap] of overlaps) {
      // bigramSimilarity と同じ Dice 係数
      if ((2 * overlap) / (bigrams.length + (bigramTotals[lineId] ?? 0)) >= SCREEN_LINE_SIMILARITY) return true
    }
    return false
  }

  for (const line of lines) add(line)
  return { add, resemblesAny }
}

/** 読み取った文字を1枚ずつ通す篩 */
export interface ScreenSieve {
  /**
   * 1枚ぶんの読み取った文字から、まだ材料にしていない行だけを取り出す。
   *
   * 残した行はその場で既出に加わるので、同じ篩に続けて通した次の1枚では既出として落ちる。
   *
   * @param ocrText Gyazo が読み取った文字（行の区切りは改行）
   * @returns 残った行（元の文字のまま、読み取った順）
   */
  extract(ocrText: string): string[]
}

/**
 * 読み取った文字の篩を作る。
 *
 * 篩は3段である。
 * 1. 自前の文字の除去（サイドスーパー・視聴者の発言と表示名・字幕）。丸ごと含む（飾りや吹き出しの記号が
 *    付いて読み取られたとき）、一部でしかない（チャットボックスの端で見切れたとき）、よく似ている（OCRの揺れ）の
 *    3通りで落とす
 * 2. 中身のない行の除去（3文字未満、数字だけ）
 * 3. 既出の除去（その配信で既に渡した行に近いもの。**初出は必ず残す**）
 *
 * 「恒常表示の除去」を独立した段として持たず既出に統合しているのは、分けて持つと初出の本文まで落ち、
 * 一度も LLM に届かなかったためである（issue #122 の実測）。
 *
 * 注意: 材料の正規化と索引づくりは、ここで1度だけ行う。1回の収集で同じ配信の何枚もを通すときは、
 * 1枚ごとに作り直さず同じ篩を使う（作り直すと、その手間が枚数ぶん積み上がる）。
 * 注意: 短すぎる自前の文字では照合しない。1文字の表示名で画面の本文まで落としてしまうためである。
 * 注意: 同じ画面の中で繰り返された行も、2つ目以降は既出として落とす（残した行をその場で既出に追加していく）。
 *
 * @param ownTexts HDAD 自身が画面に出している文字
 * @param seenLines その配信で既に材料として渡した行
 */
export const createScreenSieve = (ownTexts: readonly string[], seenLines: readonly string[]): ScreenSieve => {
  const ownLines = ownTexts.map(normalizeScreenLine).filter((text) => text.length >= SCREEN_LINE_MIN_LENGTH)
  const ownIndex = createLineIndex(ownLines)
  const seenIndex = createLineIndex(seenLines.map(normalizeScreenLine).filter((text) => text.length > 0))

  const isOwnText = (line: string): boolean =>
    ownLines.some((own) => own.includes(line) || line.includes(own)) || ownIndex.resemblesAny(line)

  const extract = (ocrText: string): string[] => {
    const remainingLines: string[] = []
    for (const originalLine of ocrText.split('\n')) {
      const line = normalizeScreenLine(originalLine)
      if (line.length < SCREEN_LINE_MIN_LENGTH || DIGITS_ONLY.test(line)) continue
      if (isOwnText(line)) continue
      if (seenIndex.resemblesAny(line)) continue
      seenIndex.add(line)
      remainingLines.push(originalLine.trim())
    }
    return remainingLines
  }

  return { extract }
}

/**
 * 読み取った文字から、まだ材料にしていない行だけを取り出す（1枚だけを通すときの形）。
 *
 * 篩の中身は createScreenSieve を参照。何枚も通すときは createScreenSieve で篩を1つ作って使い回す。
 *
 * @param ocrText Gyazo が読み取った文字（行の区切りは改行）
 * @param ownTexts HDAD 自身が画面に出している文字
 * @param seenLines その配信で既に材料として渡した行
 * @returns 残った行（元の文字のまま、読み取った順）
 */
export const extractNewScreenLines = (ocrText: string, ownTexts: readonly string[], seenLines: readonly string[]): string[] =>
  createScreenSieve(ownTexts, seenLines).extract(ocrText)
