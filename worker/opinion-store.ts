/**
 * 意見ボードの読み書き（issue #306）
 *
 * テーマ・論点・意見・テーマを出しているあいだのコメントを D1（migrations/0033_opinions.sql）に持つ。
 * - テーマは1つだけ開ける。開くときの確かめと書き込みは1つの文で行う（読んでから書くと、並んだ操作で2つ開いてしまうため）
 * - コメントは開いているテーマにだけ貯める。開いているテーマは INSERT ... SELECT の中で引く（読み出しを1回増やさないため。
 *   テーマを出していないあいだの発言では1行も書かない）
 * - 振り分け（worker/opinion-sort.ts）の結果は、論点・意見・コメントの状態を1つの batch で書く（途中で失敗して、意見だけ
 *   増えてコメントが振り分け待ちのまま残る、といった食い違いを作らないため）
 *
 * 注意: SQLに値を埋め込まず、必ずプレースホルダで渡す。コメントのIDの並びは JSON の配列にして json_each で展開する。
 */
import type { Database } from './database'
import type {
  AdminOpinion,
  AdminOpinionBoard,
  DropReason,
  OpinionBoardSnapshot,
  OpinionKind,
  OpinionTheme,
  OverlayOpinion,
  PendingComment,
} from './opinion'
import type { SortingAction, SortingTopic } from './opinion-sort'

const toIso = (milliseconds: number): string => new Date(milliseconds).toISOString()

/** テーマを選ぶ列 */
const THEME_COLUMNS = 'id, title, opened_at AS openedAt, closed_at AS closedAt'

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
const readLatestTheme = async (db: Database): Promise<OpinionTheme | null> =>
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
 * 振り分けの材料にする、いまの論点と意見を読む（論点は作った順、意見は作った順）。
 *
 * 隠した意見も含める。同じ意見が書かれたときに、新しい意見として出し直させないため。
 */
export const readSortingBoard = async (db: Database, themeId: number): Promise<SortingTopic[]> => {
  const [topics, opinions] = await Promise.all([readTopics(db, themeId), readOpinions(db, themeId)])
  return topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    opinions: opinions
      .filter(({ topicId }) => topicId === topic.id)
      .reverse()
      .map(({ id, kind, text }) => ({ id, kind, text })),
  }))
}

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
 *
 * @param actions 照合を通った振り分け（worker/opinion-sort.ts の parseOpinionSorting）
 */
export const applySorting = async (db: Database, themeId: number, actions: readonly SortingAction[], now: number): Promise<void> => {
  const createdAt = toIso(now)
  const newTitles = [...new Set(actions.flatMap((action) => (action.type === 'new' && action.topic.type === 'new' ? [action.topic.title] : [])))]
  const statements = newTitles.map((title) =>
    db
      .prepare(`INSERT INTO opinion_topics (theme_id, title, created_at) SELECT ?1, ?2, ?3 WHERE ${themeIsOpen('?1')}`)
      .bind(themeId, title, createdAt),
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
      db
        .prepare(
          `UPDATE opinion_comments SET status = 'used', opinion_id = (SELECT id FROM opinions WHERE first_comment_id = ?1)
           WHERE id IN (SELECT value FROM json_each(?2)) AND status = 'pending' AND ${themeIsOpen('?3')}`,
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

/**
 * 管理画面へ渡す意見ボードを読む。最後に開いたテーマの、隠した意見も含めて、人数ともとのコメントを添えて返す。
 */
export const readAdminBoard = async (db: Database): Promise<AdminOpinionBoard> => {
  const theme = await readLatestTheme(db)
  if (theme === null) return { theme: null, topics: [] }
  const [topics, opinions, sources] = await Promise.all([
    readTopics(db, theme.id),
    readOpinions(db, theme.id),
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
  }
}
