/**
 * 意見ボードの読み書き（opinion-store.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）で、次の点を確かめる。
 * - テーマは1つだけ開け、開いているあいだに次のテーマは開けないこと。締め切ったら次のテーマを開けること
 * - コメントはテーマを開いているあいだだけ貯め、通知の再送で二重に貯めないこと。規則で落としたものも理由つきで残すこと
 * - 振り分けを1つの batch で書き、新しい論点・新しい意見・既にある意見への統合・無関係をコメントの状態に反映すること
 * - 合成ページへは隠した意見と人数を出さず、管理画面へは隠した意見・人数・もとのコメントを出すこと
 * - 締め切ったあとも、次のテーマを開くまで最後のテーマを映すこと
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import {
  closeTheme,
  markCommentsFailed,
  openTheme,
  readAdminBoard,
  readOpenTheme,
  readOverlayBoard,
  readPendingComments,
  readSortingBoard,
  recordOpinionComment,
  applySorting,
  setOpinionHidden,
  type OpinionCommentInput,
} from './opinion-store'

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const LATER = Date.parse('2026-10-10T12:10:00.000Z')

let db: ReturnType<typeof createFakeDatabase>

beforeEach(() => {
  db = createFakeDatabase()
})

/** 返信でも規則で落としたものでもないコメント */
const comment = (messageId: string, userName: string, text: string): OpinionCommentInput => ({
  messageId,
  userId: `id-${userName}`,
  userName,
  text,
  replyName: null,
  replyText: null,
  dropReason: null,
})

/** テーマを開き、開いたテーマを返す（開けなければテストを失敗させる） */
const open = async (title: string, at = NOW) => {
  const theme = await openTheme(db, title, at)
  if (theme === null) throw new Error('テーマを開けませんでした（ほかのテーマが開いています）')
  return theme
}

describe('テーマ', () => {
  it('開いたテーマを返し、開いているあいだは次のテーマを開けない', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    expect(theme).toMatchObject({ title: '配信中にAIをどこまで使っていい？', openedAt: new Date(NOW).toISOString(), closedAt: null })
    expect(await openTheme(db, '次のテーマ', LATER)).toBeNull()
    expect(await readOpenTheme(db)).toEqual(theme)
  })

  it('締め切ったら次のテーマを開ける', async () => {
    const theme = await open('最初のテーマ')
    expect(await closeTheme(db, theme.id, LATER)).toMatchObject({ id: theme.id, closedAt: new Date(LATER).toISOString() })
    expect(await readOpenTheme(db)).toBeNull()
    // 締め切ったテーマはもう締め切れない
    expect(await closeTheme(db, theme.id, LATER)).toBeNull()
    expect(await openTheme(db, '次のテーマ', LATER)).not.toBeNull()
  })
})

describe('コメントの記録', () => {
  it('テーマを開いていなければ貯めない', async () => {
    await recordOpinionComment(db, comment('m1', 'aoi', 'AIのコメ返しは寂しい'), NOW)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM opinion_comments').get()).toEqual({ count: 0 })
  })

  it('開いているテーマに貯め、再送では二重に貯めない', async () => {
    const theme = await open('テーマ')
    await recordOpinionComment(db, comment('m1', 'aoi', 'AIのコメ返しは寂しい'), NOW)
    await recordOpinionComment(db, comment('m1', 'aoi', 'AIのコメ返しは寂しい'), NOW)
    expect(await readPendingComments(db, theme.id)).toEqual([
      { id: expect.any(Number), userId: 'id-aoi', userName: 'aoi', text: 'AIのコメ返しは寂しい', replyName: null, replyText: null, sentAt: new Date(NOW).toISOString() },
    ])
  })

  it('規則で落としたコメントは理由つきで残し、振り分け待ちにしない', async () => {
    const theme = await open('テーマ')
    await recordOpinionComment(db, { ...comment('m1', 'nekomaru', '草'), dropReason: 'reaction' }, NOW)
    expect(await readPendingComments(db, theme.id)).toEqual([])
    expect(db.sqlite.prepare('SELECT status, drop_reason FROM opinion_comments').get()).toEqual({ status: 'dropped', drop_reason: 'reaction' })
  })
})

describe('振り分けの反映と読み出し', () => {
  /** テーマを開き、3人のコメントを貯めて、コメントのIDを返す */
  const prepare = async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    await recordOpinionComment(db, comment('m1', 'aoi', 'AIのコメ返しはちょっと寂しい'), NOW)
    await recordOpinionComment(db, comment('m2', 'riku', 'AIの返事だと距離を感じる'), NOW + 1000)
    await recordOpinionComment(db, comment('m3', 'mochi', 'BGMの曲名なに？'), NOW + 2000)
    const [first, second, third] = (await readPendingComments(db, theme.id)).map(({ id }) => id)
    if (first === undefined || second === undefined || third === undefined) throw new Error('コメントが3件貯まっていません')
    return { theme, ids: [first, second, third] as const }
  }

  it('新しい論点と意見を作り、同じ意見の発言は人数に数え、無関係は振り分け済みにする', async () => {
    const { theme, ids } = await prepare()
    await applySorting(
      db,
      theme.id,
      [
        { type: 'new', commentIds: [ids[0]], topic: { type: 'new', title: '視聴者との距離' }, kind: 'issue', text: 'AIが返事すると距離を感じる' },
        { type: 'ignore', commentIds: [ids[2]] },
      ],
      LATER,
    )
    const board = await readSortingBoard(db, theme.id)
    expect(board).toEqual([{ id: expect.any(Number), title: '視聴者との距離', opinions: [{ id: expect.any(Number), kind: 'issue', text: 'AIが返事すると距離を感じる' }] }])
    const opinionId = board[0]?.opinions[0]?.id ?? 0

    // 次の回で、2人目のコメントを既にある意見へ統合する
    await applySorting(db, theme.id, [{ type: 'join', commentIds: [ids[1]], opinionId }], LATER)
    expect(await readPendingComments(db, theme.id)).toEqual([])

    const admin = await readAdminBoard(db)
    expect(admin.topics[0]?.opinions[0]).toMatchObject({
      text: 'AIが返事すると距離を感じる',
      author: 'aoi',
      hidden: false,
      people: 2,
      sources: [
        { userName: 'aoi', text: 'AIのコメ返しはちょっと寂しい' },
        { userName: 'riku', text: 'AIの返事だと距離を感じる' },
      ],
    })
  })

  it('既にある論点へ新しい意見を足し、合成ページへは新しい順に、人数を付けずに渡す', async () => {
    const { theme, ids } = await prepare()
    await applySorting(db, theme.id, [{ type: 'new', commentIds: [ids[0]], topic: { type: 'new', title: '視聴者との距離' }, kind: 'issue', text: '距離を感じる' }], NOW)
    const topicId = (await readSortingBoard(db, theme.id))[0]?.id ?? 0
    await applySorting(db, theme.id, [{ type: 'new', commentIds: [ids[1]], topic: { type: 'existing', id: topicId }, kind: 'insight', text: '返事の速さは嬉しい' }], LATER)

    const overlay = await readOverlayBoard(db)
    expect(overlay.theme?.title).toBe('配信中にAIをどこまで使っていい？')
    expect(overlay.topics).toEqual([
      {
        id: topicId,
        title: '視聴者との距離',
        opinions: [
          { id: expect.any(Number), kind: 'insight', text: '返事の速さは嬉しい', author: 'riku', createdAt: new Date(LATER).toISOString() },
          { id: expect.any(Number), kind: 'issue', text: '距離を感じる', author: 'aoi', createdAt: new Date(NOW).toISOString() },
        ],
      },
    ])
  })

  it('同じ回に同じ名前の新しい論点が2回出たら、1つの論点にまとめる', async () => {
    const { theme, ids } = await prepare()
    await applySorting(
      db,
      theme.id,
      [
        { type: 'new', commentIds: [ids[0]], topic: { type: 'new', title: '視聴者との距離' }, kind: 'issue', text: '寂しい' },
        { type: 'new', commentIds: [ids[1]], topic: { type: 'new', title: '視聴者との距離' }, kind: 'issue', text: '距離を感じる' },
      ],
      NOW,
    )
    const board = await readSortingBoard(db, theme.id)
    expect(board).toHaveLength(1)
    expect(board[0]?.opinions).toHaveLength(2)
  })

  it('隠した意見は合成ページに出さず、管理画面には隠したことを添えて出す', async () => {
    const { theme, ids } = await prepare()
    await applySorting(db, theme.id, [{ type: 'new', commentIds: [ids[0]], topic: { type: 'new', title: '視聴者との距離' }, kind: 'issue', text: '寂しい' }], NOW)
    const opinionId = (await readSortingBoard(db, theme.id))[0]?.opinions[0]?.id ?? 0

    expect(await setOpinionHidden(db, opinionId, true)).toBe(true)
    expect((await readOverlayBoard(db)).topics).toEqual([{ id: expect.any(Number), title: '視聴者との距離', opinions: [] }])
    expect((await readAdminBoard(db)).topics[0]?.opinions[0]?.hidden).toBe(true)
    // 隠した意見も振り分けの材料には残す（同じ意見を新しい意見として出し直させないため）
    expect((await readSortingBoard(db, theme.id))[0]?.opinions).toHaveLength(1)

    expect(await setOpinionHidden(db, opinionId, false)).toBe(true)
    expect((await readOverlayBoard(db)).topics[0]?.opinions).toHaveLength(1)
    expect(await setOpinionHidden(db, opinionId + 100, true)).toBe(false)
  })

  it('振り分けに失敗した回のコメントは失敗にし、振り分け待ちから外す', async () => {
    const { theme, ids } = await prepare()
    await markCommentsFailed(db, [ids[0], ids[1]])
    expect((await readPendingComments(db, theme.id)).map(({ id }) => id)).toEqual([ids[2]])
  })

  it('締め切ったあとも、次のテーマを開くまで最後のテーマを映す', async () => {
    expect(await readOverlayBoard(db)).toEqual({ theme: null, topics: [] })
    const { theme } = await prepare()
    await closeTheme(db, theme.id, LATER)
    expect((await readOverlayBoard(db)).theme).toMatchObject({ id: theme.id, closedAt: new Date(LATER).toISOString() })
    const next = await open('次のテーマ', LATER + 1000)
    expect(await readOverlayBoard(db)).toEqual({ theme: next, topics: [] })
  })
})
