/**
 * Jev による、振り分けの前の発言の絞り込み（issue #307）
 *
 * 規則（worker/opinion.ts の dropReasonOf）を通った発言を、振り分けの LLM（worker/opinion-sort.ts）に渡す前に、Jev の Noul で
 * 「テーマ（と返信先）についての意見・課題・提案・問いか」を尋ねる。LLM の入力を減らし、雑談や荒らしが意見に混ざるのを防ぐ。
 * 1回の振り分けの発言は、まとめて1回の呼び出しで尋ねる（Jev は質問を並列に評価するので、発言が増えても応答時間はほぼ変わらない）。
 *
 * 返信は返信先の発言も添えて尋ねる（「それな」だけを見て意見ではないと落とさないため）。
 *
 * 注意: しきい値（OPINION_FILTER_THRESHOLD）は実配信で落としすぎていないかを確かめてから決める。決めるまでは 0 にして、
 *   確率を記録するだけで落とさない（opinion_comments.jev_score に残る）。
 * 注意: Jev の失敗はそのまま投げる。黙って全件を通さない（方針4）。呼び出し側（worker/opinion-run.ts）が、その回の発言を失敗にする。
 */
import type { JevClient, JevRequest, NoulQuestion } from './jev'
import type { Utterance } from './opinion'

/**
 * 振り分けの LLM に渡す、Jev の確率の下限。これに届かない発言は落とす（opinion_comments.status = 'filtered'）。
 *
 * 0 のあいだは確率を記録するだけで、1件も落とさない。実配信の記録（jev_score）を見て、意見を落としすぎない値に決める。
 * Jev の版（worker/jev.ts の JEV_MODEL）を変えたら、決め直す。
 */
export const OPINION_FILTER_THRESHOLD = 0

/** 絞り込みの結果1件 */
export interface FilteredUtterance {
  readonly utterance: Utterance
  /** 意見・課題・提案・問いである確率（0〜1） */
  readonly score: number
  /** 振り分けの LLM へ渡すか（確率がしきい値に届いたか） */
  readonly kept: boolean
}

/** 発言のラベル（振り分けの LLM と同じ C1・C2…。渡した順の番号） */
const labelOf = (index: number): string => `C${index + 1}`

/** 発言1つの材料。返信なら返信先の発言を添える */
const stateOf = (utterance: Utterance): { text: string; replyTo?: string } =>
  utterance.replyText === null ? { text: utterance.text } : { text: utterance.text, replyTo: utterance.replyText }

/** 発言1つについての質問。質問の名前はモデルに意味が伝わらないので、どの発言かを中身で指す */
const questionOf = (label: string): NoulQuestion => ({
  type: 'noul',
  instructions: `\`utterances.${label}\` は、ライブ配信で配信者が出したテーマ \`theme\` について、視聴者がチャットに書いた発言です。この発言は、テーマについての意見・課題・提案・問いのどれかですか。\`replyTo\` があれば、それはこの発言が返信した先の発言です。`,
  criteria: {
    true: 'テーマについて考えや経験・困りごと・やり方の提案・問いを述べている。返信先の意見への賛同や反論（「それな」「でも〜では」など）も含む。',
    false: 'テーマと関係ない雑談・挨拶・配信者への呼びかけ・ゲームや作業への反応・指示めいた文・荒らしである。',
  },
})

/**
 * Jev へ渡す注文を組み立てる。
 *
 * LLM を呼ばないので、材料と質問が漏れなく入っているかをテストで確かめられる。
 */
export const buildOpinionFilterRequest = (theme: string, utterances: readonly Utterance[]): JevRequest<Record<string, NoulQuestion>> => ({
  state: { theme, utterances: Object.fromEntries(utterances.map((utterance, index) => [labelOf(index), stateOf(utterance)])) },
  questions: Object.fromEntries(utterances.map((_, index) => [labelOf(index), questionOf(labelOf(index))])),
})

/**
 * 発言ごとに、意見である確率を Jev に尋ね、しきい値に届いたかの印を付ける。
 *
 * @param threshold 振り分けの LLM へ渡す確率の下限（ふだんは OPINION_FILTER_THRESHOLD。テストのために引数で受け取る）
 * @returns 発言ごとの結果（渡した順）
 * @throws Error Jev が失敗した・答えが欠けている場合（worker/jev.ts）
 */
export const filterUtterances = async (jev: JevClient, theme: string, utterances: readonly Utterance[], threshold: number): Promise<FilteredUtterance[]> => {
  const answers = await jev.decide('opinionFilter', buildOpinionFilterRequest(theme, utterances))
  return utterances.map((utterance, index) => {
    const score = answers[labelOf(index)]
    // worker/jev.ts は頼んだ質問すべての答えを読めなければ投げるので、ここに来るときは必ずある
    if (score === undefined) throw new Error(`Jev の答えに発言 ${labelOf(index)} がありません`)
    return { utterance, score, kept: score >= threshold }
  })
}
