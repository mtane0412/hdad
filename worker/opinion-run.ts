/**
 * 意見の振り分けの1回分（issue #306・#307）
 *
 * テーマを出しているあいだ、Durable Object のアラーム（worker/opinion-timer.ts）が一定の間隔でここを呼ぶ。
 * 1回分は次の順に進める。
 * 1. 開いているテーマを読む。開いていなければ何もせず false を返す（呼び出し側はアラームを止める）
 * 2. 振り分け待ちのコメントを読み、渡せる発言にまとめる（worker/opinion.ts の readyUtterances）。渡せる発言が無ければ LLM を呼ばない
 * 3. Jev で発言を絞り込み、確率を残す（worker/opinion-filter.ts）。しきい値に届かない発言は振り分けの LLM に渡さない
 * 4. いまの論点と意見と問いかけを材料に LLM に振り分けさせ、照合する（worker/opinion-sort.ts）
 * 5. 振り分けを書き（worker/opinion-store.ts）、いまの意見ボードを合成ページへ押し出す
 * 6. 問いかけが無いあいだに新しい意見ができた・問いかけに答える発言が届いたときだけ、問いかけを作り直して押し出す
 *    （worker/opinion-prompt.ts。新しい意見が無いあいだは作り直さない）
 *
 * 注意: Jev・LLM が失敗した・応答が照合を通らなかったときは、その回の発言を「失敗」にして失敗を記録する（opinion-filter-failed・
 *   opinion-sort-failed）。振り分け待ちに残すと、同じ発言で毎回失敗し続けて無料枠を食い続けるためである。失敗にした発言は、
 *   配信者が管理画面から救い出せる（issue #308）。黙って無関係にも、黙って全件を通しもしない（方針4）。
 * 注意: Jev は OpenRouter の鍵が無ければ呼べない。鍵が無い配信者では jev を null にして、絞り込みを飛ばす（配信者が決めたこと。
 *   鍵の有無で決まる分岐で、Jev の失敗を飛ばすのとは違う）。
 * 注意: 問いかけを作れなかったときは前の問いかけを残し、失敗を記録する（opinion-prompt-failed）。振り分けは取り消さない。
 * 注意: 押し出しに失敗しても書いた振り分けは取り消さず、失敗を記録する（opinion-push-failed）。合成ページは定期的に読み直すので、
 *   いずれ映る。
 */
import { pushOpinions, type AlertChannelNamespace } from './alert-channel'
import type { Database } from './database'
import type { JevClient } from './jev'
import type { TextGenerator } from './llm'
import { readyUtterances, type OpinionTheme, type Utterance } from './opinion'
import { filterUtterances } from './opinion-filter'
import { proposeOpinionPrompt } from './opinion-prompt'
import { sortOpinions } from './opinion-sort'
import {
  applySorting,
  markCommentsFailed,
  readOpenTheme,
  readOverlayBoard,
  readPendingComments,
  readSortingBoard,
  readVisibleBoard,
  recordFilterResults,
  saveThemePrompt,
} from './opinion-store'
import { recordFailure } from './stats-store'

/** 振り分けの1回分に要るもの。テストで差し替えられるよう引数で受け取る */
export interface OpinionSortingDependencies {
  readonly db: Database
  readonly alerts: AlertChannelNamespace
  readonly llm: TextGenerator
  /** 絞り込みに使う Jev。OpenRouter の鍵が無ければ null で、絞り込まない */
  readonly jev: JevClient | null
  /** 振り分けの LLM へ渡す Jev の確率の下限（ふだんは worker/opinion-filter.ts の OPINION_FILTER_THRESHOLD） */
  readonly filterThreshold: number
  /** 現在時刻（ミリ秒） */
  readonly now: number
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * いまの意見ボードを合成ページへ押し出す。失敗は投げずに記録する（書いたものは取り消さないため）。
 */
export const pushCurrentOpinions = async ({ db, alerts, now }: Pick<OpinionSortingDependencies, 'db' | 'alerts' | 'now'>): Promise<void> => {
  try {
    await pushOpinions(alerts, await readOverlayBoard(db))
  } catch (error) {
    await recordFailure(db, 'opinion-push-failed', `意見ボードを合成ページへ送れませんでした: ${reasonOf(error)}`, now)
  }
}

/**
 * 開いているテーマの問いかけを作り直して書く。いまの問いかけとは違う切り口にさせる。
 *
 * @returns 書いたテーマ。LLM を待つあいだに締め切られていたら null（何も書かない）
 * @throws Error LLM が失敗した・問いかけが照合を通らなかった場合（前の問いかけは残る）
 */
export const replaceOpinionPrompt = async (db: Database, llm: TextGenerator, theme: OpinionTheme): Promise<OpinionTheme | null> => {
  const prompt = await proposeOpinionPrompt(llm, { theme: theme.title, board: await readVisibleBoard(db, theme.id), previous: theme.prompt })
  return saveThemePrompt(db, theme.id, prompt)
}

/**
 * Jev で発言を絞り込み、確率を残す。
 *
 * @returns 振り分けの LLM へ渡す発言。jev が null なら絞り込まずにそのまま返す
 * @throws Error Jev が失敗した・確率を書けなかった場合
 */
const keepOpinionUtterances = async (
  { db, jev, filterThreshold }: OpinionSortingDependencies,
  theme: OpinionTheme,
  utterances: readonly Utterance[],
): Promise<readonly Utterance[]> => {
  if (jev === null) return utterances
  const results = await filterUtterances(jev, theme.title, utterances, filterThreshold)
  await recordFilterResults(
    db,
    theme.id,
    results.map(({ utterance, score, kept }) => ({ commentIds: utterance.commentIds, score, kept })),
  )
  return results.filter(({ kept }) => kept).map(({ utterance }) => utterance)
}

/**
 * 振り分けの1回分を進める。
 *
 * @returns テーマが開いているか（開いていなければ、呼び出し側は次の回を予約しない）
 */
export const runOpinionSorting = async (dependencies: OpinionSortingDependencies): Promise<boolean> => {
  const { db, llm, now } = dependencies
  const theme = await readOpenTheme(db)
  if (theme === null) return false

  const utterances = readyUtterances(await readPendingComments(db, theme.id), now)
  if (utterances.length === 0) return true

  let kept: readonly Utterance[]
  try {
    kept = await keepOpinionUtterances(dependencies, theme, utterances)
  } catch (error) {
    const commentIds = utterances.flatMap(({ commentIds }) => commentIds)
    await markCommentsFailed(db, theme.id, commentIds)
    await recordFailure(db, 'opinion-filter-failed', `意見ボードのコメント${commentIds.length}件を Jev で絞り込めませんでした: ${reasonOf(error)}`, now)
    return true
  }
  if (kept.length === 0) return true

  const commentIds = kept.flatMap(({ commentIds }) => commentIds)
  let promptDue: boolean
  try {
    const { actions, promptAnswered } = await sortOpinions(llm, {
      theme: theme.title,
      board: await readSortingBoard(db, theme.id),
      utterances: kept,
      prompt: theme.prompt,
    })
    await applySorting(db, theme.id, actions, now)
    // 問いかけを作り直すのは、答えが届いたときと、問いかけが無いあいだに新しい意見ができたときだけ
    promptDue = promptAnswered || (theme.prompt === null && actions.some(({ type }) => type === 'new'))
  } catch (error) {
    await markCommentsFailed(db, theme.id, commentIds)
    await recordFailure(db, 'opinion-sort-failed', `意見ボードのコメント${commentIds.length}件を振り分けられませんでした: ${reasonOf(error)}`, now)
    return true
  }
  await pushCurrentOpinions(dependencies)
  if (!promptDue) return true

  try {
    if ((await replaceOpinionPrompt(db, llm, theme)) === null) return true
  } catch (error) {
    await recordFailure(db, 'opinion-prompt-failed', `意見ボードの問いかけを作り直せませんでした（前の問いかけを残します）: ${reasonOf(error)}`, now)
    return true
  }
  await pushCurrentOpinions(dependencies)
  return true
}
