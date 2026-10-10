/**
 * 意見ボードの読み書き（issue #306）
 *
 * テーマ・論点・意見・テーマを出しているあいだのコメントを D1（migrations/0033_opinions.sql）に持つ。
 * - テーマは1つだけ開ける。開くときの確かめと書き込みは1つの文で行う（読んでから書くと、並んだ操作で2つ開いてしまうため）
 * - コメントは開いているテーマにだけ貯める。開いているテーマは INSERT ... SELECT の中で引く（読み出しを1回増やさないため。
 *   テーマを出していないあいだの発言では1行も書かない）
 * - 振り分け（worker/opinion-sort.ts）の結果は、論点・意見・コメントの状態を1つの batch で書く（途中で失敗して、意見だけ
 *   増えてコメントが振り分け待ちのまま残る、といった食い違いを作らないため）
 * - Jev の絞り込み（worker/opinion-filter.ts）の確率はコメントに残し、しきい値に届かなかったコメントは filtered にする（issue #307）
 * - 視聴者への問いかけ（worker/opinion-prompt.ts）はテーマの行に持つ（issue #307）
 * - 配信者の救い出し・論点の名前の書き換え・論点の統合（issue #308）は、最後に開いたテーマ（管理画面に出ているもの）にだけ書く。
 *   締め切ったあとも書ける。振り分け待ちのコメントは、締め切ったあとにだけ救い出せる（開いているあいだは振り分けと取り合うため）
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。コメントのIDの並びは JSON の配列にして json_each で展開する。
 */
import type { Database, DatabaseStatement } from './database'
import {
  MAX_TOPICS,
  type AdminOpinion,
  type AdminOpinionBoard,
  type DropReason,
  type OpinionBoardSnapshot,
  type OpinionCommentCounts,
  type OpinionKind,
  type OpinionTheme,
  type OverlayOpinion,
  type PendingComment,
  type RescuableComment,
  type RescuedOpinionInput,
} from './opinion'
import type { SortingAction, SortingTopic } from './opinion-sort'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** テーマを選ぶ列 */
const THEME_COLUMNS = 'id, title, opened_at AS openedAt, closed_at AS closedAt, prompt'

/** 貯めるコメント（届いた通知から取り出した値） */
export interface OpinionCommentInput {
  /** TwitchのメッセージのID。再送で二重に貯めないための鍵 */
  readonly messageId: string
  readonly userId: string
  /** 書いた人の表示名 */
  readonly userName: string
  readonly text: string
  readonly replyName: string | null
  readonly replyText: string | null
  /** 規則で落とした理由。落とさなければ null（振り分け待ちにする） */
  readonly dropReason: DropReason | null
}

/**
 * テーマを開く。ほかのテーマが開いていれば開かない。
 *
 * @returns 開いたテーマ。ほかのテーマが開いていれば null
 */
export const openTheme = async (db: Database, title: string, now: number): Promise<OpinionTheme | null> =>
  db
    .prepare(
      `INSERT INTO opinion_themes (title, opened_at)
       SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM opinion_themes WHERE closed_at IS NULL)
       RETURNING ${THEME_COLUMNS}`,
    )
    .bind(title, toIso(now))
    .first<OpinionTheme>()

/**
 * 開いているテーマを締め切る。
 *
 * @returns 締め切ったテーマ。そのIDのテーマが無い・もう締め切っていれば null
 */
export const closeTheme = async (db: Database, id: number, now: number): Promise<OpinionTheme | null> =>
  db.prepare(`UPDATE opinion_themes SET closed_at = ?2 WHERE id = ?1 AND closed_at IS NULL RETURNING ${THEME_COLUMNS}`).bind(id, toIso(now)).first<OpinionTheme>()

/** 開いているテーマを読む。開いていなければ null */
export const readOpenTheme = async (db: Database): Promise<OpinionTheme | null> =>
  db.prepare(`SELECT ${THEME_COLUMNS} FROM opinion_themes WHERE closed_at IS NULL`).first<OpinionTheme>()

/** 最後に開いたテーマを読む（締め切ったものも含む）。一度も開いていなければ null */
export const readLatestTheme = async (db: Database): Promise<OpinionTheme | null> =>
  db.prepare(`SELECT ${THEME_COLUMNS} FROM opinion_themes ORDER BY id DESC LIMIT 1`).first<OpinionTheme>()

/**
 * テーマを開いているあいだに届いたコメントを貯める。開いていなければ1行も書かない。
 *
 * 規則で落としたコメントも、理由をつけて残す（拾えなかったコメントを配信者が救い出せるようにするため。issue #308）。
 * 同じメッセージのIDのコメントは、通知の再送なので二重に貯めない。
 */
export const recordOpinionComment = async (db: Database, comment: OpinionCommentInput, now: number): Promise<void> => {
  await db
    .prepare(
      `INSERT OR IGNORE INTO opinion_comments (theme_id, message_id, user_id, user_name, text, reply_name, reply_text, sent_at, status, drop_reason)
       SELECT id, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 FROM opinion_themes WHERE closed_at IS NULL`,
    )
    .bind(
      comment.messageId,
      comment.userId,
      comment.userName,
      comment.text,
      comment.replyName,
      comment.replyText,
      toIso(now),
      comment.dropReason === null ? 'pending' : 'dropped',
      comment.dropReason,
    )
    .run()
}

/** テーマの振り分け待ちのコメントを、書かれた順に読む */
export const readPendingComments = async (db: Database, themeId: number): Promise<PendingComment[]> => {
  const { results } = await db
    .prepare(
      `SELECT id, user_id AS userId, user_name AS userName, text, reply_name AS replyName, reply_text AS replyText, sent_at AS sentAt
       FROM opinion_comments WHERE theme_id = ?1 AND status = 'pending' ORDER BY sent_at, id`,
    )
    .bind(themeId)
    .all<PendingComment>()
  return results
}

/** 論点を作った順に読む */
const readTopics = async (db: Database, themeId: number): Promise<{ id: number; title: string }[]> => {
  const { results } = await db.prepare('SELECT id, title FROM opinion_topics WHERE theme_id = ?1 ORDER BY id').bind(themeId).all<{ id: number; title: string }>()
  return results
}

/** Jev の絞り込みの結果1件（worker/opinion-filter.ts の FilteredUtterance を、コメントのIDで指したもの） */
export interface FilterResultInput {
  /** 発言につなげたコメントのID */
  readonly commentIds: readonly number[]
  /** 意見である確率（0〜1） */
  readonly score: number
  /** 振り分けの LLM へ渡すか。渡さなければ filtered にする */
  readonly kept: boolean
}

/**
 * Jev の絞り込みの結果を書く。確率はどのコメントにも残し（しきい値を実配信の記録から決めるため）、渡さないコメントは filtered にする。
 *
 * 振り分け待ちのコメントだけを書き換え、Jev を待つあいだにテーマが締め切られていたら何も書かない（applySorting と同じ条件）。
 */
export const recordFilterResults = async (db: Database, themeId: number, results: readonly FilterResultInput[]): Promise<void> => {
  if (results.length === 0) return
  await db.batch(
    results.map(({ commentIds, score, kept }) =>
      db
        .prepare(
          `UPDATE opinion_comments SET jev_score = ?1, status = ?2
           WHERE id IN (SELECT value FROM json_each(?3)) AND status = 'pending' AND ${themeIsOpen('?4')}`,
        )
        .bind(score, kept ? 'pending' : 'filtered', JSON.stringify(commentIds), themeId),
    ),
  )
}

/**
 * 開いているテーマに、視聴者への問いかけを書く。
 *
 * @returns 書いたテーマ。LLM を待つあいだに締め切られていた（またはそのIDのテーマが開いていない）なら null で、何も書かない
 */
export const saveThemePrompt = async (db: Database, themeId: number, prompt: string): Promise<OpinionTheme | null> =>
  db.prepare(`UPDATE opinion_themes SET prompt = ?2 WHERE id = ?1 AND closed_at IS NULL RETURNING ${THEME_COLUMNS}`).bind(themeId, prompt).first<OpinionTheme>()

/** 意見の行（最初のもとのコメントの書き手を添える） */
interface OpinionRow {
  id: number
  topicId: number
  kind: OpinionKind
  text: string
  hidden: number
  createdAt: string
  author: string
}

/** テーマの意見を新しい順に読む（隠したものも含む） */
const readOpinions = async (db: Database, themeId: number): Promise<OpinionRow[]> => {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.topic_id AS topicId, o.kind, o.text, o.hidden, o.created_at AS createdAt, c.user_name AS author
       FROM opinions o
       JOIN opinion_topics t ON t.id = o.topic_id
       JOIN opinion_comments c ON c.id = o.first_comment_id
       WHERE t.theme_id = ?1
       ORDER BY o.created_at DESC, o.id DESC`,
    )
    .bind(themeId)
    .all<OpinionRow>()
  return results
}

const toOverlayOpinion = (row: OpinionRow): OverlayOpinion => ({ id: row.id, kind: row.kind, text: row.text, author: row.author, createdAt: row.createdAt })

/**
 * LLM の材料にする、いまの論点と意見を読む（論点は作った順、意見は作った順）。
 *
 * @param includeHidden 隠した意見も含めるか
 */
const readMaterialBoard = async (db: Database, themeId: number, includeHidden: boolean): Promise<SortingTopic[]> => {
  const [topics, opinions] = await Promise.all([readTopics(db, themeId), readOpinions(db, themeId)])
  return topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    opinions: opinions
      .filter(({ topicId, hidden }) => topicId === topic.id && (includeHidden || hidden === 0))
      .reverse()
      .map(({ id, kind, text }) => ({ id, kind, text })),
  }))
}

/**
 * 振り分けの材料にする、いまの論点と意見を読む（論点は作った順、意見は作った順）。
 *
 * 隠した意見も含める。同じ意見が書かれたときに、新しい意見として出し直させないため。
 */
export const readSortingBoard = (db: Database, themeId: number): Promise<SortingTopic[]> => readMaterialBoard(db, themeId, true)

/**
 * 問いかけの材料にする、いまの論点と意見を読む（論点は作った順、意見は作った順）。
 *
 * 隠した意見は含めない（荒らしの文を、合成ページに出す問いかけの材料にしないため）。
 */
export const readVisibleBoard = (db: Database, themeId: number): Promise<SortingTopic[]> => readMaterialBoard(db, themeId, false)

/**
 * テーマがまだ開いているかを確かめる条件。振り分けの各文に付け、LLM を待つあいだに締め切られたテーマへは書かない。
 *
 * @param placeholder テーマのIDを渡すプレースホルダ（?1 など）
 */
const themeIsOpen = (placeholder: string): string => `EXISTS (SELECT 1 FROM opinion_themes WHERE id = ${placeholder} AND closed_at IS NULL)`

/**
 * 振り分けを書く。論点・意見・コメントの状態を1つの batch で書く。
 *
 * 新しい論点は、同じ回に同じ名前で2回出てきたら1つだけ作る。作った意見をコメントから指すために、意見の最初のもとのコメントのID
 * （first_comment_id。表で重ならない）を鍵にする。コメントの状態は振り分け待ちのものだけを書き換える。
 * LLM を待つあいだにテーマが締め切られていたら、どの文も何も書かない（コメントは振り分け待ちのまま残る）。
 * LLM を待つあいだに配信者が論点をまとめた・足した（issue #308）ために意見を書けなかったときも、そのコメントは振り分け待ちに残し、
 * 次の回でいまの論点と照らして振り分け直す。
 *
 * @param actions 照合を通った振り分け（worker/opinion-sort.ts の parseOpinionSorting）
 */
export const applySorting = async (db: Database, themeId: number, actions: readonly SortingAction[], now: number): Promise<void> => {
  const createdAt = toIso(now)
  const newTitles = [...new Set(actions.flatMap((action) => (action.type === 'new' && action.topic.type === 'new' ? [action.topic.title] : [])))]
  const statements = newTitles.map((title) =>
    db
      // LLM を待つあいだに配信者が論点を足して上限に達していたら作らない（その論点に入る意見も書かれず、コメントは振り分け待ちに残る）
      .prepare(
        `INSERT INTO opinion_topics (theme_id, title, created_at)
         SELECT ?1, ?2, ?3 WHERE ${themeIsOpen('?1')} AND (SELECT COUNT(*) FROM opinion_topics WHERE theme_id = ?1) < ?4`,
      )
      .bind(themeId, title, createdAt, MAX_TOPICS),
  )

  for (const action of actions) {
    const commentIds = JSON.stringify(action.commentIds)
    if (action.type === 'ignore') {
      statements.push(
        db
          .prepare(`UPDATE opinion_comments SET status = 'ignored' WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'pending' AND ${themeIsOpen('?2')}`)
          .bind(commentIds, themeId),
      )
      continue
    }
    if (action.type === 'join') {
      statements.push(
        db
          .prepare(
            `UPDATE opinion_comments SET status = 'used', opinion_id = ?1 WHERE id IN (SELECT value FROM json_each(?2)) AND status = 'pending' AND ${themeIsOpen('?3')}`,
          )
          .bind(action.opinionId, commentIds, themeId),
      )
      continue
    }

    const [firstCommentId] = action.commentIds
    if (firstCommentId === undefined) throw new Error('新しい意見に、もとのコメントがありません')
    // 論点は、既にあるものはID、この回に作るものは名前で、同じテーマの中から引く
    const topicCondition = action.topic.type === 'existing' ? 'id = ?5' : 'title = ?5'
    const topicKey = action.topic.type === 'existing' ? action.topic.id : action.topic.title
    statements.push(
      db
        .prepare(
          `INSERT INTO opinions (topic_id, kind, text, first_comment_id, created_at)
           SELECT id, ?1, ?2, ?3, ?4 FROM opinion_topics WHERE ${topicCondition} AND theme_id = ?6 AND ${themeIsOpen('?6')}`,
        )
        .bind(action.kind, action.text, firstCommentId, createdAt, topicKey, themeId),
      // 意見を書けなかった（LLM を待つあいだに論点がまとめられて消えた・論点が上限に達した）ときは、コメントを振り分け待ちに残す
      db
        .prepare(
          `UPDATE opinion_comments SET status = 'used', opinion_id = (SELECT id FROM opinions WHERE first_comment_id = ?1)
           WHERE id IN (SELECT value FROM json_each(?2)) AND status = 'pending' AND ${themeIsOpen('?3')}
             AND EXISTS (SELECT 1 FROM opinions WHERE first_comment_id = ?1)`,
        )
        .bind(firstCommentId, commentIds, themeId),
    )
  }
  if (statements.length > 0) await db.batch(statements)
}

/**
 * 振り分けに失敗した回のコメントを失敗にし、振り分け待ちから外す（同じ発言で失敗し続けないため）。
 *
 * LLM を待つあいだにテーマが締め切られていたら、失敗にせず振り分け待ちのまま残す（締め切りで残ったコメントと、
 * 振り分けの失敗を混ぜないため。applySorting と同じ条件）。
 */
export const markCommentsFailed = async (db: Database, themeId: number, commentIds: readonly number[]): Promise<void> => {
  await db
    .prepare(`UPDATE opinion_comments SET status = 'failed' WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'pending' AND ${themeIsOpen('?2')}`)
    .bind(JSON.stringify(commentIds), themeId)
    .run()
}

/**
 * 意見を隠す・隠すのをやめる。
 *
 * @returns その意見があったか
 */
export const setOpinionHidden = async (db: Database, opinionId: number, hidden: boolean): Promise<boolean> =>
  (await db.prepare('UPDATE opinions SET hidden = ?2 WHERE id = ?1 RETURNING id').bind(opinionId, hidden ? 1 : 0).first<{ id: number }>()) !== null

/**
 * 合成ページへ渡す意見ボードを読む。最後に開いたテーマ（締め切ったものも含む）の、隠していない意見だけを人数を付けずに返す。
 */
export const readOverlayBoard = async (db: Database): Promise<OpinionBoardSnapshot> => {
  const theme = await readLatestTheme(db)
  if (theme === null) return { theme: null, topics: [] }
  const [topics, opinions] = await Promise.all([readTopics(db, theme.id), readOpinions(db, theme.id)])
  return {
    theme,
    topics: topics.map((topic) => ({
      ...topic,
      opinions: opinions.filter((row) => row.topicId === topic.id && row.hidden === 0).map(toOverlayOpinion),
    })),
  }
}

/** もとのコメントの行 */
interface SourceRow {
  opinionId: number
  userId: string
  userName: string
  text: string
}

/** 内訳を数えはじめる値（テーマを開いたことがないときもこのまま返す） */
const emptyCounts = (): OpinionCommentCounts => ({
  received: 0,
  used: 0,
  pending: 0,
  dropped: { command: 0, emote: 0, reaction: 0 },
  filtered: 0,
  ignored: 0,
  failed: 0,
})

/** 状態ごとにそのまま数える状態（dropped は理由ごとに分けて数える） */
const COUNTED_STATUSES = ['used', 'pending', 'filtered', 'ignored', 'failed'] as const

/** テーマのコメントの内訳を数える（状態と、規則で落とした理由ごと） */
const readCommentCounts = async (db: Database, themeId: number): Promise<OpinionCommentCounts> => {
  const { results } = await db
    .prepare('SELECT status, drop_reason AS dropReason, COUNT(*) AS count FROM opinion_comments WHERE theme_id = ?1 GROUP BY status, drop_reason')
    .bind(themeId)
    .all<{ status: string; dropReason: DropReason | null; count: number }>()
  const empty = emptyCounts()
  const counts = { ...empty, dropped: { ...empty.dropped } }
  for (const { status, dropReason, count } of results) {
    counts.received += count
    if (status === 'dropped' && dropReason !== null) counts.dropped[dropReason] += count
    const counted = COUNTED_STATUSES.find((candidate) => candidate === status)
    if (counted !== undefined) counts[counted] += count
  }
  return counts
}

/**
 * コメントを救い出せるかの条件。最後に開いたテーマのコメントで、意見にならなかったもの。振り分け待ちのものは、テーマを締め切った
 * あとにだけ救い出せる（開いているあいだは、振り分けのアラームと同じコメントを取り合うため）。
 *
 * @param table コメントの表の名前か別名（opinion_comments・c など）
 */
const rescuable = (table: string): string =>
  `${table}.theme_id = (SELECT MAX(id) FROM opinion_themes)
   AND (${table}.status IN ('dropped', 'filtered', 'ignored', 'failed')
     OR (${table}.status = 'pending' AND EXISTS (SELECT 1 FROM opinion_themes WHERE id = ${table}.theme_id AND closed_at IS NOT NULL)))`

/** 救い出せるコメントを選ぶ列 */
const RESCUABLE_COLUMNS = `id, user_name AS userName, text, reply_name AS replyName, reply_text AS replyText, sent_at AS sentAt, status,
  drop_reason AS dropReason, jev_score AS jevScore`

/** 救い出せるコメントを新しい順に読む */
const readRescuableComments = async (db: Database): Promise<RescuableComment[]> => {
  const { results } = await db
    .prepare(`SELECT ${RESCUABLE_COLUMNS} FROM opinion_comments WHERE ${rescuable('opinion_comments')} ORDER BY sent_at DESC, id DESC`)
    .all<RescuableComment>()
  return results
}

/**
 * 救い出せるコメントを1件読む（issue #308）。
 *
 * @returns そのコメント。無い・意見になった・前のテーマのもの・開いているテーマの振り分け待ちのものなら null
 */
export const readRescuableComment = async (db: Database, commentId: number): Promise<RescuableComment | null> =>
  db.prepare(`SELECT ${RESCUABLE_COLUMNS} FROM opinion_comments WHERE id = ?1 AND ${rescuable('opinion_comments')}`).bind(commentId).first<RescuableComment>()

/** 最後に開いたテーマの論点を作った順に読む。テーマを開いたことがなければ空 */
export const readLatestThemeTopics = async (db: Database): Promise<{ id: number; title: string }[]> => {
  const { results } = await db
    .prepare('SELECT id, title FROM opinion_topics WHERE theme_id = (SELECT MAX(id) FROM opinion_themes) ORDER BY id')
    .all<{ id: number; title: string }>()
  return results
}

/**
 * 救い出したコメントを、既にある意見に統合する（issue #308）。
 *
 * @returns 統合したか。コメントが救い出せない・意見が同じテーマに無ければ false で、何も書かない
 */
export const joinRescuedComment = async (db: Database, commentId: number, opinionId: number): Promise<boolean> =>
  (await db
    .prepare(
      `UPDATE opinion_comments SET status = 'used', opinion_id = ?2
       WHERE id = ?1 AND ${rescuable('opinion_comments')}
         AND EXISTS (SELECT 1 FROM opinions o JOIN opinion_topics t ON t.id = o.topic_id WHERE o.id = ?2 AND t.theme_id = opinion_comments.theme_id)
       RETURNING id`,
    )
    .bind(commentId, opinionId)
    .first<{ id: number }>()) !== null

/**
 * 救い出したコメントから意見を作る（issue #308）。新しい論点なら論点も作る。論点・意見・コメントの状態を1つの batch で書く。
 *
 * 選んだ論点がいまの論点と食い違わないか（worker/opinion.ts の topicChoiceProblem）は、呼び出し側が先に確かめる。
 * ここでも、論点の数の上限と、コメントがまだ救い出せることを各文の条件にする（並んだ操作で食い違わないため）。
 *
 * @returns 作ったか。コメントが救い出せない（意見になった・無い）なら false で、何も書かない
 */
export const saveRescuedOpinion = async (db: Database, commentId: number, input: RescuedOpinionInput, now: number): Promise<boolean> => {
  if ((await readRescuableComment(db, commentId)) === null) return false
  const createdAt = toIso(now)
  const statements: DatabaseStatement[] = []
  if (input.topic.type === 'new') {
    statements.push(
      db
        .prepare(
          `INSERT INTO opinion_topics (theme_id, title, created_at)
           SELECT theme_id, ?2, ?3 FROM opinion_comments
           WHERE id = ?1 AND ${rescuable('opinion_comments')} AND (SELECT COUNT(*) FROM opinion_topics t WHERE t.theme_id = opinion_comments.theme_id) < ?4`,
        )
        .bind(commentId, input.topic.title, createdAt, MAX_TOPICS),
    )
  }
  // 論点は、既にあるものはID、作ったものは名前で、コメントと同じテーマの中から引く
  const topicCondition = input.topic.type === 'existing' ? 't.id = ?5' : 't.title = ?5'
  const topicKey = input.topic.type === 'existing' ? input.topic.id : input.topic.title
  statements.push(
    db
      .prepare(
        `INSERT INTO opinions (topic_id, kind, text, first_comment_id, created_at)
         SELECT t.id, ?2, ?3, c.id, ?4 FROM opinion_comments c JOIN opinion_topics t ON t.theme_id = c.theme_id
         WHERE c.id = ?1 AND ${rescuable('c')} AND ${topicCondition}`,
      )
      .bind(commentId, input.kind, input.text, createdAt, topicKey),
    db
      .prepare(
        `UPDATE opinion_comments SET status = 'used', opinion_id = (SELECT id FROM opinions WHERE first_comment_id = ?1)
         WHERE id = ?1 AND ${rescuable('opinion_comments')} AND EXISTS (SELECT 1 FROM opinions WHERE first_comment_id = ?1)`,
      )
      .bind(commentId),
  )
  await db.batch(statements)
  const saved = await db.prepare("SELECT 1 AS saved FROM opinion_comments WHERE id = ?1 AND status = 'used'").bind(commentId).first<{ saved: number }>()
  return saved !== null
}

/**
 * 最後に開いたテーマの論点の名前を書き換える（issue #308）。
 *
 * 同じテーマに同じ名前の論点が無いことは、呼び出し側が先に確かめる（表の UNIQUE に当たると失敗するため）。
 *
 * @returns 書き換えたか。その論点が最後に開いたテーマに無ければ false
 */
export const renameTopic = async (db: Database, topicId: number, title: string): Promise<boolean> =>
  (await db
    .prepare('UPDATE opinion_topics SET title = ?2 WHERE id = ?1 AND theme_id = (SELECT MAX(id) FROM opinion_themes) RETURNING id')
    .bind(topicId, title)
    .first<{ id: number }>()) !== null

/**
 * 最後に開いたテーマの2つの論点を1つにまとめる（issue #308）。まとめる側の意見をまとめ先へ移し、まとめる側の論点を消す。
 * まとめ先の名前を残す（LLM に名前を付け直させない）。
 *
 * @param fromId まとめる側（消す論点）
 * @param intoId まとめ先（残す論点）
 * @returns まとめたか。どちらかが最後に開いたテーマに無い・同じ論点なら false で、何も書かない
 */
export const mergeTopics = async (db: Database, fromId: number, intoId: number): Promise<boolean> => {
  const topicIds = new Set((await readLatestThemeTopics(db)).map(({ id }) => id))
  if (fromId === intoId || !topicIds.has(fromId) || !topicIds.has(intoId)) return false
  await db.batch([
    db.prepare('UPDATE opinions SET topic_id = ?2 WHERE topic_id = ?1').bind(fromId, intoId),
    // 移しきれなかった意見が残っていれば消さない（意見の行き先が無くならないため）
    db.prepare('DELETE FROM opinion_topics WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM opinions WHERE topic_id = ?1)').bind(fromId),
  ])
  return true
}

/**
 * 管理画面へ渡す意見ボードを読む。最後に開いたテーマの、隠した意見も含めて、人数ともとのコメントを添えて返す。
 * コメントの内訳と、救い出せるコメント（issue #308）も添える。
 */
export const readAdminBoard = async (db: Database): Promise<AdminOpinionBoard> => {
  const theme = await readLatestTheme(db)
  if (theme === null) return { theme: null, topics: [], counts: emptyCounts(), rescuable: [] }
  const [topics, opinions, counts, rescuableComments, sources] = await Promise.all([
    readTopics(db, theme.id),
    readOpinions(db, theme.id),
    readCommentCounts(db, theme.id),
    readRescuableComments(db),
    db
      .prepare(
        `SELECT opinion_id AS opinionId, user_id AS userId, user_name AS userName, text FROM opinion_comments
         WHERE theme_id = ?1 AND opinion_id IS NOT NULL ORDER BY sent_at, id`,
      )
      .bind(theme.id)
      .all<SourceRow>()
      .then(({ results }) => results),
  ])
  const toAdminOpinion = (row: OpinionRow): AdminOpinion => {
    const own = sources.filter(({ opinionId }) => opinionId === row.id)
    return {
      ...toOverlayOpinion(row),
      hidden: row.hidden === 1,
      people: new Set(own.map(({ userId }) => userId)).size,
      sources: own.map(({ userName, text }) => ({ userName, text })),
    }
  }
  return {
    theme,
    topics: topics.map((topic) => ({ ...topic, opinions: opinions.filter(({ topicId }) => topicId === topic.id).map(toAdminOpinion) })),
    counts,
    rescuable: rescuableComments,
  }
}
