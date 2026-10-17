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
 * 7. 新しい意見ができ、前に作り直してから意見が REGROUP_OPINION_STEP 件増えていれば、論点を意見全体から作り直して押し出す
 *    （worker/opinion-regroup.ts。issue #402）。LLM に意見の全体を渡して時間がかかるので、問いかけを待たせないよう最後に行う
 *
 * 注意: Jev・LLM が失敗した・応答が照合を通らなかったときは、その回の発言を「失敗」にして失敗を記録する（opinion-filter-failed・
 *   opinion-sort-failed）。振り分け待ちに残すと、同じ発言で毎回失敗し続けて無料枠を食い続けるためである。失敗にした発言は、
 *   配信者が管理画面から救い出せる（issue #308）。黙って無関係にも、黙って全件を通しもしない（方針4）。
 * 注意: Jev は OpenRouter の鍵が無ければ呼べない。鍵が無い配信者では jev を null にして、絞り込みを飛ばす（配信者が決めたこと。
 *   鍵の有無で決まる分岐で、Jev の失敗を飛ばすのとは違う）。
 * 注意: 問いかけを作れなかったときは前の問いかけを残し、失敗を記録する（opinion-prompt-failed）。振り分けは取り消さない。
 * 注意: 論点を作り直せなかったときも前の論点を残し、失敗を記録する（opinion-regroup-failed）。振り分けは取り消さない。
 * 配信後のまとめ（issue #309）は、振り分けとは別に、テーマを締め切ったとき（worker/opinion-routes.ts）にここの runClosedThemeFinish が、
 * 論点の作り直しと並べて作る。配信者が作り直させるときは replaceOpinionSummary を通る。
 *
 * 注意: 押し出しに失敗しても書いた振り分けは取り消さず、失敗を記録する（opinion-push-failed）。合成ページは定期的に読み直すので、
 *   いずれ映る。
 */
import { pushOpinions, type AlertChannelNamespace } from './alert-channel'
import type { Database } from './database'
import type { JevClient } from './jev'
import type { TextGenerator } from './llm'
import { readyUtterances, type OpinionTheme, type StoredOpinionSummary, type Utterance } from './opinion'
import { filterUtterances } from './opinion-filter'
import { proposeOpinionPrompt } from './opinion-prompt'
import { planRegrouping, regroupMaterialOf, regroupOpinions } from './opinion-regroup'
import { sortOpinions } from './opinion-sort'
import { summarizeOpinions } from './opinion-summary'
import {
  applyRegrouping,
  applySorting,
  claimRegroup,
  markCommentsFailed,
  readOpenTheme,
  readOverlayBoard,
  readPendingComments,
  readRegroupBoard,
  readSortingBoard,
  readVisibleBoard,
  recordFilterResults,
  saveThemePrompt,
  saveThemeSummary,
} from './opinion-store'
import { recordFailure } from './stats-store'

/**
 * 論点を作り直す、意見の増え方（件）。前に作り直してからこの数だけ意見が増えた回に作り直す（issue #402）。
 *
 * 2026-10-16 の本番は1つのテーマで意見が13件だった。作り直しは意見の全体を LLM に渡すので、毎回ではなく、論点の中身が
 * 変わるほど意見が増えたときに限る（1つのテーマで2〜3回になる）。
 */
export const REGROUP_OPINION_STEP = 5

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
 * 締め切ったテーマの配信後のまとめを作り直して書く。隠していない意見をもとに、LLM に作らせる。
 *
 * @returns 書いたまとめ。隠していない意見が1件も無ければ null（LLM を呼ばず、何も書かない）
 * @throws Error LLM が失敗した・まとめが照合を通らなかった・テーマがまだ開いている場合（前のまとめは残る）
 */
export const replaceOpinionSummary = async (db: Database, llm: TextGenerator, theme: OpinionTheme, now: number): Promise<StoredOpinionSummary | null> => {
  const board = await readVisibleBoard(db, theme.id)
  if (board.every(({ opinions }) => opinions.length === 0)) return null
  const summary = await summarizeOpinions(llm, { theme: theme.title, board })
  if (!(await saveThemeSummary(db, theme.id, summary, now))) throw new Error(`テーマ「${theme.title}」はまだ開いているので、まとめを書けません`)
  return { ...summary, createdAt: new Date(now).toISOString() }
}

/** 論点の作り直しに要るもの */
type RegroupDependencies = Pick<OpinionSortingDependencies, 'db' | 'alerts' | 'llm' | 'now'>

/**
 * 前に作り直してから意見が step 件以上増えていれば、論点を意見全体から作り直して書き、押し出す（issue #402）。
 * 失敗は投げずに記録する（opinion-regroup-failed。前の論点を残す）。
 *
 * 引き受けた時点で数を覚えるので、失敗しても同じ盤面で作り直し続けない。LLM を待つあいだに盤面が変わっていたら書かずに記録する
 * （次は意見がさらに step 件増えたときに作り直す）。
 */
const runOpinionRegrouping = async ({ db, alerts, llm, now }: RegroupDependencies, theme: OpinionTheme, step: number): Promise<void> => {
  try {
    if (!(await claimRegroup(db, theme.id, step))) return
    const board = await readRegroupBoard(db, theme.id)
    const material = regroupMaterialOf(theme.title, board)
    if (material === null) return
    const plan = planRegrouping(board, await regroupOpinions(llm, material))
    if (!(await applyRegrouping(db, theme.id, board, plan, now))) {
      await recordFailure(db, 'opinion-regroup-failed', `意見ボードのテーマ「${theme.title}」の論点を作り直すあいだに意見ボードが変わったので、書かずに見送りました`, now)
      return
    }
  } catch (error) {
    await recordFailure(db, 'opinion-regroup-failed', `意見ボードのテーマ「${theme.title}」の論点を作り直せませんでした（前の論点を残します）: ${reasonOf(error)}`, now)
    return
  }
  await pushCurrentOpinions({ db, alerts, now })
}

/**
 * テーマを締め切ったあとに、論点の作り直しと配信後のまとめを並べて行う。どちらの失敗も投げずに記録する（締め切りは取り消さないため）。
 *
 * 作り直しは、前に作り直してから意見が1件でも増えていれば行う（最後の意見まで論点に反映するため）。
 * 2つを順に待たないのは、締め切りの経路の waitUntil が応答のあと30秒ほどで打ち切られ、LLM を2回続けて待つと間に合わないことが
 * あるためである。まとめは論点の名前ではなく意見から作るので、作り直す前の論点を材料にしてよい。作り直せなくてもまとめは作る。
 */
export const runClosedThemeFinish = async (dependencies: RegroupDependencies, theme: OpinionTheme): Promise<void> => {
  await Promise.all([runOpinionRegrouping(dependencies, theme, 1), runClosedThemeSummary(dependencies.db, dependencies.llm, theme, dependencies.now)])
}

/**
 * テーマを締め切ったあとに、配信後のまとめを作る。失敗は投げずに記録する（締め切りは取り消さないため）。
 *
 * 作れなかったときは行を書かない。配信者は `/opinions/` から作り直せる。
 */
export const runClosedThemeSummary = async (db: Database, llm: TextGenerator, theme: OpinionTheme, now: number): Promise<void> => {
  try {
    await replaceOpinionSummary(db, llm, theme, now)
  } catch (error) {
    await recordFailure(db, 'opinion-summary-failed', `意見ボードのテーマ「${theme.title}」の配信後のまとめを作れませんでした: ${reasonOf(error)}`, now)
  }
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
  let createdOpinion: boolean
  try {
    const { actions, promptAnswered } = await sortOpinions(llm, {
      theme: theme.title,
      board: await readSortingBoard(db, theme.id),
      utterances: kept,
      prompt: theme.prompt,
    })
    await applySorting(db, theme.id, actions, now)
    createdOpinion = actions.some(({ type }) => type === 'new')
    // 問いかけを作り直すのは、答えが届いたときと、問いかけが無いあいだに新しい意見ができたときだけ
    promptDue = promptAnswered || (theme.prompt === null && createdOpinion)
  } catch (error) {
    await markCommentsFailed(db, theme.id, commentIds)
    await recordFailure(db, 'opinion-sort-failed', `意見ボードのコメント${commentIds.length}件を振り分けられませんでした: ${reasonOf(error)}`, now)
    return true
  }
  await pushCurrentOpinions(dependencies)
  if (promptDue) await runOpinionPrompt(dependencies, theme)
  // 作り直しは LLM に意見の全体を渡すので時間がかかる。問いかけを待たせないよう最後に行う
  if (createdOpinion) await runOpinionRegrouping(dependencies, theme, REGROUP_OPINION_STEP)
  return true
}

/**
 * 問いかけを作り直して押し出す。失敗は投げずに記録する（opinion-prompt-failed。前の問いかけを残す）。
 */
const runOpinionPrompt = async (dependencies: OpinionSortingDependencies, theme: OpinionTheme): Promise<void> => {
  const { db, llm, now } = dependencies
  try {
    if ((await replaceOpinionPrompt(db, llm, theme)) === null) return
  } catch (error) {
    await recordFailure(db, 'opinion-prompt-failed', `意見ボードの問いかけを作り直せませんでした（前の問いかけを残します）: ${reasonOf(error)}`, now)
    return
  }
  await pushCurrentOpinions(dependencies)
}
