/**
 * 意見の振り分けの1回分（issue #306）
 *
 * テーマを出しているあいだ、Durable Object のアラーム（worker/opinion-timer.ts）が一定の間隔でここを呼ぶ。
 * 1回分は次の順に進める。
 * 1. 開いているテーマを読む。開いていなければ何もせず false を返す（呼び出し側はアラームを止める）
 * 2. 振り分け待ちのコメントを読み、渡せる発言にまとめる（worker/opinion.ts の readyUtterances）。渡せる発言が無ければ LLM を呼ばない
 * 3. いまの論点と意見を材料に LLM に振り分けさせ、照合する（worker/opinion-sort.ts）
 * 4. 振り分けを書き（worker/opinion-store.ts）、いまの意見ボードを合成ページへ押し出す
 *
 * 注意: LLM が失敗した・応答が照合を通らなかったときは、その回の発言を「失敗」にして失敗を記録する（opinion-sort-failed）。
 *   振り分け待ちに残すと、同じ発言で毎回失敗し続けて無料枠を食い続けるためである。失敗にした発言は、配信者が管理画面から
 *   救い出せる（issue #308）。黙って無関係にはしない（方針4）。
 * 注意: 押し出しに失敗しても書いた振り分けは取り消さず、失敗を記録する（opinion-push-failed）。合成ページは定期的に読み直すので、
 *   いずれ映る。
 */
import { pushOpinions, type AlertChannelNamespace } from './alert-channel'
import type { Database } from './database'
import type { TextGenerator } from './llm'
import { readyUtterances } from './opinion'
import { sortOpinions } from './opinion-sort'
import { applySorting, markCommentsFailed, readOpenTheme, readOverlayBoard, readPendingComments, readSortingBoard } from './opinion-store'
import { recordFailure } from './stats-store'

/** 振り分けの1回分に要るもの。テストで差し替えられるよう引数で受け取る */
export interface OpinionSortingDependencies {
  readonly db: Database
  readonly alerts: AlertChannelNamespace
  readonly llm: TextGenerator
  /** 現在時刻（ミリ秒） */
  readonly now: number
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * いまの意見ボードを合成ページへ押し出す。失敗は投げずに記録する（書いたものは取り消さないため）。
 */
export const pushCurrentOpinions = async ({ db, alerts, now }: Omit<OpinionSortingDependencies, 'llm'>): Promise<void> => {
  try {
    await pushOpinions(alerts, await readOverlayBoard(db))
  } catch (error) {
    await recordFailure(db, 'opinion-push-failed', `意見ボードを合成ページへ送れませんでした: ${reasonOf(error)}`, now)
  }
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

  const commentIds = utterances.flatMap(({ commentIds }) => commentIds)
  try {
    const actions = await sortOpinions(llm, { theme: theme.title, board: await readSortingBoard(db, theme.id), utterances })
    await applySorting(db, theme.id, actions, now)
  } catch (error) {
    await markCommentsFailed(db, commentIds)
    await recordFailure(db, 'opinion-sort-failed', `意見ボードのコメント${commentIds.length}件を振り分けられませんでした: ${reasonOf(error)}`, now)
    return true
  }
  await pushCurrentOpinions(dependencies)
  return true
}
