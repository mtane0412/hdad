/**
 * チャットで推理の問題集の読み取り
 *
 * 問題集（problems.json）は配信者が目で確かめた問題だけを持つ（issue #375）。problems.json は問題集の一覧で、
 * 問題集は ID（英小文字・数字・ハイフン）・名前（選ぶ欄に出す。例: 古代史の人物）・問題の一覧を持ち、時代などの括り（例: 古代史）を持てる。
 * 括りは合成ページのお題に区分と合わせて出す（例: お題: 古代史の人物）。時代の混ざる問題集（いろいろ）は持たない。
 * 配信者は問題集だけを選び、どの問題を出すかは Worker が決める（worker/chat-deduction-pick.ts）。1問は次の項目を持つ。
 * - ID: D1 のゲームの行に載せる識別子（英小文字・数字・ハイフン）
 * - 区分: 人物・場所・出来事・もの（category.ts）
 * - 正解: 画面に出す表記
 * - 別名: 解答の照合に使う表記の一覧。照合は別名との完全一致だけで決め、LLM には判定させない
 * - 事実メモ: 質問に答える LLM へ渡す材料。メモから導けないことは「分からない」と答えさせ、作り話で答えさせない
 * - 解説: ゲームを終えたあとに合成ページで出す、正解についての短い説明（視聴者の知識にするため）。LLM にその場で作らせず、
 *   配信者が確かめた文だけを出す。板に収まるよう MAX_EXPLANATION_LENGTH 文字までにする
 *
 * 注意: Worker（質問への答え・解答の照合）からも読み込むので、DOM や src/core/ のブラウザ向けの部品に頼らない。
 * 注意: 形の誤りは黙って飛ばさずに投げる（Fail-Fast）。問題集の形はテスト（problems.test.ts）でも確かめる。
 * 注意: 問題のIDは問題集をまたいで重ねない（D1 のゲームの行は問題のIDだけを持ち、そこから問題を引くため）。
 */
import { isChatDeductionCategory, type ChatDeductionCategory } from './category'

/** 問題1問 */
export interface ChatDeductionProblem {
  readonly id: string
  readonly category: ChatDeductionCategory
  /** 画面に出す正解の表記 */
  readonly answer: string
  /** 解答の照合に使う表記の一覧（1つ以上） */
  readonly aliases: readonly string[]
  /** 質問に答える LLM へ渡す材料（1つ以上） */
  readonly facts: readonly string[]
  /** ゲームを終えたあとに合成ページで出す解説（MAX_EXPLANATION_LENGTH 文字まで） */
  readonly explanation: string
}

/** 問題集1つ */
export interface ChatDeductionProblemSet {
  readonly id: string
  /** 選ぶ欄に出す名前（例: 古代史の人物） */
  readonly name: string
  /** 時代などの括り（例: 古代史）。合成ページのお題に「古代史の人物」と区分の前に添える。無い問題集は区分だけを出す */
  readonly topic?: string
  /** 出題する候補（1問以上） */
  readonly problems: readonly ChatDeductionProblem[]
}

/** 問題と問題集のIDに使える文字（D1 の行と経路にそのまま載せるため、英小文字・数字・ハイフンに限る） */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 解説の文字数の上限（合成ページで、カードの格子の代わりに出す板へ収まる長さ。chat-deduction.css の解説の文字の大きさと合わせる） */
export const MAX_EXPLANATION_LENGTH = 150

/** 空でない文字列だけの配列なら、その配列を返す。そうでなければ null */
const nonEmptyStrings = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null
  const strings = value.filter((item: unknown): item is string => typeof item === 'string' && item !== '')
  return strings.length === value.length ? strings : null
}

/**
 * 問題1問を読む。
 *
 * @param at 問題点に添える位置（例: 問題集「misc」の3番目）
 * @throws 問題の形が違う場合
 */
const readChatDeductionProblem = (candidate: unknown, at: string): ChatDeductionProblem => {
  const { id, category, answer, aliases, facts, explanation }: Record<string, unknown> = typeof candidate === 'object' && candidate !== null ? { ...candidate } : {}
  const where = `${at}（${typeof id === 'string' && id !== '' ? id : '?'}）`
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`${where}: IDを英小文字・数字・ハイフンだけの文字列にしてください`)
  if (!isChatDeductionCategory(category)) throw new Error(`${where}: 区分を既知の値（person・place・event・thing）にしてください`)
  if (typeof answer !== 'string' || answer === '') throw new Error(`${where}: 正解を空でない文字列にしてください`)
  const aliasStrings = nonEmptyStrings(aliases)
  if (aliasStrings === null) throw new Error(`${where}: 別名を空でない文字列の1つ以上の配列にしてください`)
  if (new Set(aliasStrings).size !== aliasStrings.length) throw new Error(`${where}: 同じ別名が2回あります`)
  const factStrings = nonEmptyStrings(facts)
  if (factStrings === null) throw new Error(`${where}: 事実メモを空でない文字列の1つ以上の配列にしてください`)
  if (typeof explanation !== 'string' || explanation.trim() === '') throw new Error(`${where}: 解説を空白だけでない文字列にしてください`)
  if ([...explanation].length > MAX_EXPLANATION_LENGTH) throw new Error(`${where}: 解説を${MAX_EXPLANATION_LENGTH}文字までにしてください（いまは${[...explanation].length}文字）`)
  return { id, category, answer, aliases: aliasStrings, facts: factStrings, explanation }
}

/**
 * 問題の一覧を読む。
 *
 * @param at 問題点に添える、一覧の位置（例: 問題集「misc」）
 * @throws 配列でない・問題の形が違う・同じIDが2問ある場合（何番目のどの問題かを添える）
 */
export const readChatDeductionProblems = (value: unknown, at = 'チャットで推理の問題集'): readonly ChatDeductionProblem[] => {
  if (!Array.isArray(value)) throw new Error(`${at}は配列にしてください`)
  const seen = new Set<string>()
  return value.map((candidate: unknown, index): ChatDeductionProblem => {
    const problem = readChatDeductionProblem(candidate, `${at}の${index}番目`)
    if (seen.has(problem.id)) throw new Error(`${at}の${index}番目（${problem.id}）: IDが重複しています`)
    seen.add(problem.id)
    return problem
  })
}

/**
 * 問題集1つを読む。
 *
 * @param at 問題点に添える位置（例: チャットで推理の問題集の一覧の1番目）
 * @throws 問題集の形・中の問題の形が違う場合
 */
const readChatDeductionProblemSet = (candidate: unknown, at: string): ChatDeductionProblemSet => {
  const { id, name, topic, problems }: Record<string, unknown> = typeof candidate === 'object' && candidate !== null ? { ...candidate } : {}
  const where = `${at}（${typeof id === 'string' && id !== '' ? id : '?'}）`
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error(`${where}: 問題集のIDを英小文字・数字・ハイフンだけの文字列にしてください`)
  if (typeof name !== 'string' || name === '') throw new Error(`${where}: 問題集の名前を空でない文字列にしてください`)
  if (topic !== undefined && (typeof topic !== 'string' || topic.trim() === '')) throw new Error(`${where}: 問題集の括りは空白だけでない文字列にするか、項目ごと省いてください`)
  // 選ぶ欄の名前と合成ページのお題が食い違わないよう、括りは名前の一部であることを求める
  if (typeof topic === 'string' && !name.includes(topic)) throw new Error(`${where}: 問題集の括り「${topic}」を名前「${name}」に含めてください`)
  if (!Array.isArray(problems) || problems.length === 0) throw new Error(`${where}: 問題集には1問以上の問題を入れてください`)
  const read = { id, name, problems: readChatDeductionProblems(problems, `問題集「${id}」`) }
  return topic === undefined ? read : { ...read, topic }
}

/**
 * 問題集の一覧（problems.json の中身）を読む。
 *
 * @throws 配列でない・問題集や問題の形が違う・問題集のIDが重複する・問題集をまたいで問題のIDが重複する場合
 */
export const readChatDeductionProblemSets = (value: unknown): readonly ChatDeductionProblemSet[] => {
  if (!Array.isArray(value)) throw new Error('チャットで推理の問題集の一覧は配列にしてください')
  const seenSets = new Set<string>()
  const seenProblems = new Set<string>()
  return value.map((candidate: unknown, index): ChatDeductionProblemSet => {
    const set = readChatDeductionProblemSet(candidate, `チャットで推理の問題集の一覧の${index}番目`)
    if (seenSets.has(set.id)) throw new Error(`チャットで推理の問題集の一覧の${index}番目（${set.id}）: 問題集のIDが重複しています`)
    seenSets.add(set.id)
    for (const problem of set.problems) {
      if (seenProblems.has(problem.id)) throw new Error(`問題集「${set.id}」の問題（${problem.id}）: ほかの問題集とIDが重複しています`)
      seenProblems.add(problem.id)
    }
    return set
  })
}
