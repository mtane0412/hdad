/**
 * 意見ボードの読み書き（opinion-store.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）で、次の点を確かめる。
 * - テーマは1つだけ開け、開いているあいだに次のテーマは開けないこと。締め切ったら次のテーマを開けること
 * - コメントはテーマを開いているあいだだけ貯め、通知の再送で二重に貯めないこと。規則で落としたものも理由つきで残すこと
 * - 振り分けを1つの batch で書き、新しい論点・新しい意見・既にある意見への統合・無関係をコメントの状態に反映すること
 * - 合成ページへは隠した意見と人数を出さず、管理画面へは隠した意見・人数・もとのコメントを出すこと
 * - 締め切ったあとも、次のテーマを開くまで最後のテーマを映すこと
 * - 視聴者への問いかけを、開いているテーマにだけ書くこと（issue #307）
 * - Jev の確率をコメントに残し、しきい値に届かなかったコメントだけを振り分け待ちから外すこと（issue #307）
 * - 管理画面へコメントの内訳と救い出せるコメントを出し、救い出し・論点の名前の書き換え・論点の統合を書けること（issue #308）
 * - 振り分けの LLM を待つあいだに論点がまとめられた・増えたら、その意見を書かずにコメントを振り分け待ちに残すこと（issue #308）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import {
  closeTheme,
  joinRescuedComment,
  markCommentsFailed,
  mergeTopics,
  openTheme,
  readAdminBoard,
  readOpenTheme,
  readOverlayBoard,
  readLatestThemeTopics,
  readPendingComments,
  readRescuableComment,
  readSortingBoard,
  readVisibleBoard,
  recordFilterResults,
  recordOpinionComment,
  applySorting,
  renameTopic,
  saveRescuedOpinion,
  saveThemePrompt,
  setOpinionHidden,
  type OpinionCommentInput,
} from './opinion-store'
import { MAX_TOPICS } from './opinion'

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

  it('LLM を待つあいだにテーマが締め切られていたら、何も書かずに振り分け待ちのまま残す', async () => {
    const { theme, ids } = await prepare()
    await closeTheme(db, theme.id, LATER)

    await applySorting(
      db,
      theme.id,
      [
        { type: 'new', commentIds: [ids[0]], topic: { type: 'new', title: '視聴者との距離' }, kind: 'issue', text: '寂しい' },
        { type: 'ignore', commentIds: [ids[2]] },
      ],
      LATER,
    )

    expect(await readSortingBoard(db, theme.id)).toEqual([])
    expect((await readPendingComments(db, theme.id)).map(({ id }) => id)).toEqual([...ids])
  })

  it('振り分けに失敗した回のコメントは失敗にし、振り分け待ちから外す', async () => {
    const { theme, ids } = await prepare()
    await markCommentsFailed(db, theme.id, [ids[0], ids[1]])
    expect((await readPendingComments(db, theme.id)).map(({ id }) => id)).toEqual([ids[2]])
  })

  it('LLM を待つあいだにテーマが締め切られていたら、失敗にせず振り分け待ちのまま残す', async () => {
    const { theme, ids } = await prepare()
    await closeTheme(db, theme.id, LATER)
    await markCommentsFailed(db, theme.id, [ids[0], ids[1]])
    expect((await readPendingComments(db, theme.id)).map(({ id }) => id)).toEqual([...ids])
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

describe('問いかけ', () => {
  it('開いたばかりのテーマは問いかけを持たない', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    expect(theme.prompt).toBeNull()
  })

  it('開いているテーマに問いかけを書き、合成ページと管理画面へ渡す', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')

    const saved = await saveThemePrompt(db, theme.id, 'AIの使用料、配信者はどこまで払っていいと思う？')

    expect(saved).toEqual({ ...theme, prompt: 'AIの使用料、配信者はどこまで払っていいと思う？' })
    expect((await readOverlayBoard(db)).theme?.prompt).toBe('AIの使用料、配信者はどこまで払っていいと思う？')
    expect((await readAdminBoard(db)).theme?.prompt).toBe('AIの使用料、配信者はどこまで払っていいと思う？')
  })

  it('LLM を待つあいだにテーマが締め切られていたら書かない', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    await closeTheme(db, theme.id, LATER)

    expect(await saveThemePrompt(db, theme.id, 'AIの使用料、配信者はどこまで払っていいと思う？')).toBeNull()
    expect((await readOverlayBoard(db)).theme?.prompt).toBeNull()
  })
})

describe('Jev の確率の記録', () => {
  /** テーマを開き、2人のコメントを貯めて、コメントのIDを返す */
  const prepare = async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    await recordOpinionComment(db, comment('m1', 'aoi', 'AIのコメ返しはちょっと寂しい'), NOW)
    await recordOpinionComment(db, comment('m2', 'mugi', '今日の晩ごはんはカレー'), NOW + 1000)
    const [first, second] = (await readPendingComments(db, theme.id)).map(({ id }) => id)
    if (first === undefined || second === undefined) throw new Error('コメントが2件貯まっていません')
    return { theme, ids: [first, second] as const }
  }

  /** コメントの状態と Jev の確率を、IDの順に読む */
  const statuses = (): unknown[] => db.sqlite.prepare('SELECT status, jev_score FROM opinion_comments ORDER BY id').all().map((row) => ({ ...row }))

  it('確率を残し、しきい値に届かなかったコメントだけを filtered にする', async () => {
    const { theme, ids } = await prepare()

    await recordFilterResults(db, theme.id, [
      { commentIds: [ids[0]], score: 0.92, kept: true },
      { commentIds: [ids[1]], score: 0.03, kept: false },
    ])

    expect(statuses()).toEqual([
      { status: 'pending', jev_score: 0.92 },
      { status: 'filtered', jev_score: 0.03 },
    ])
    expect((await readPendingComments(db, theme.id)).map(({ id }) => id)).toEqual([ids[0]])
  })

  it('Jev を待つあいだにテーマが締め切られていたら書かない', async () => {
    const { theme, ids } = await prepare()
    await closeTheme(db, theme.id, LATER)

    await recordFilterResults(db, theme.id, [{ commentIds: [ids[1]], score: 0.03, kept: false }])

    expect(statuses()).toEqual([
      { status: 'pending', jev_score: null },
      { status: 'pending', jev_score: null },
    ])
  })
})

describe('readVisibleBoard', () => {
  it('隠した意見を除いて、論点と意見を作った順に読む', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    await recordOpinionComment(db, comment('m1', 'aoi', 'AIのコメ返しはちょっと寂しい'), NOW)
    await recordOpinionComment(db, comment('m2', 'arashi', '配信者はAIの言いなり'), NOW + 1000)
    const [first, second] = (await readPendingComments(db, theme.id)).map(({ id }) => id)
    if (first === undefined || second === undefined) throw new Error('コメントが2件貯まっていません')
    await applySorting(
      db,
      theme.id,
      [
        { type: 'new', commentIds: [first], topic: { type: 'new', title: '視聴者との距離' }, kind: 'issue', text: 'AIの返事は寂しい' },
        { type: 'new', commentIds: [second], topic: { type: 'new', title: '視聴者との距離' }, kind: 'insight', text: '配信者はAIの言いなり' },
      ],
      NOW,
    )
    const hiddenId = (await readSortingBoard(db, theme.id))[0]?.opinions[1]?.id ?? 0
    await setOpinionHidden(db, hiddenId, true)

    expect(await readVisibleBoard(db, theme.id)).toEqual([
      { id: expect.any(Number), title: '視聴者との距離', opinions: [{ id: expect.any(Number), kind: 'issue', text: 'AIの返事は寂しい' }] },
    ])
  })
})

describe('救い出しと論点の整理（issue #308）', () => {
  /** コメントの状態を直接書き換える（振り分けの結果を作る手間を省く） */
  const setStatus = (id: number, status: string): void => {
    db.sqlite.prepare('UPDATE opinion_comments SET status = ? WHERE id = ?').run(status, id)
  }

  /**
   * テーマを開き、意見1件（aoi のコメントから）と、意見にならなかったコメントを状態ごとに1件ずつ貯める。
   * 状態: 規則で落とした（短い反応・コマンド）・Jev が落とした・LLM が無関係とした・振り分けに失敗した・振り分け待ち
   */
  const prepare = async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    await recordOpinionComment(db, comment('m1', 'aoi', 'AIのコメ返しはちょっと寂しい'), NOW)
    await recordOpinionComment(db, { ...comment('m2', 'nekomaru', '草'), dropReason: 'reaction' }, NOW + 1000)
    await recordOpinionComment(db, { ...comment('m3', 'mochi', '!task 洗濯'), dropReason: 'command' }, NOW + 2000)
    await recordOpinionComment(db, comment('m4', 'riku', 'AIは裏方だけでいい'), NOW + 3000)
    await recordOpinionComment(db, comment('m5', 'mugi', 'AIの声が人っぽすぎると怖い'), NOW + 4000)
    await recordOpinionComment(db, comment('m6', 'sora', '翻訳だけはAIに任せたい'), NOW + 5000)
    await recordOpinionComment(db, comment('m7', 'hana', 'あとで考えたい'), NOW + 6000)
    const ids = db.sqlite.prepare('SELECT id FROM opinion_comments ORDER BY id').all().map((row) => Number((row as { id: number }).id))
    const [used, reaction, command, filtered, ignored, failed, pending] = ids
    if (used === undefined || reaction === undefined || command === undefined || filtered === undefined || ignored === undefined || failed === undefined || pending === undefined) {
      throw new Error('コメントが7件貯まっていません')
    }
    await applySorting(db, theme.id, [{ type: 'new', commentIds: [used], topic: { type: 'new', title: '視聴者との距離' }, kind: 'issue', text: 'AIの返事は寂しい' }], NOW)
    setStatus(filtered, 'filtered')
    setStatus(ignored, 'ignored')
    setStatus(failed, 'failed')
    const topic = (await readSortingBoard(db, theme.id))[0]
    const opinionId = topic?.opinions[0]?.id
    if (topic === undefined || opinionId === undefined) throw new Error('意見を作れませんでした')
    return { theme, topicId: topic.id, opinionId, ids: { used, reaction, command, filtered, ignored, failed, pending } }
  }

  it('テーマを開いたことがなければ、内訳は全部0で救い出せるコメントも無い', async () => {
    const board = await readAdminBoard(db)
    expect(board.counts).toEqual({ received: 0, used: 0, pending: 0, dropped: { command: 0, emote: 0, reaction: 0 }, filtered: 0, ignored: 0, failed: 0 })
    expect(board.rescuable).toEqual([])
  })

  it('コメントの内訳を、規則で落とした理由・Jev・LLM・失敗に分けて数える', async () => {
    await prepare()
    expect((await readAdminBoard(db)).counts).toEqual({
      received: 7,
      used: 1,
      pending: 1,
      dropped: { command: 1, emote: 0, reaction: 1 },
      filtered: 1,
      ignored: 1,
      failed: 1,
    })
  })

  it('意見にならなかったコメントを新しい順に出す。振り分け待ちは、締め切るまで出さない', async () => {
    const { theme, ids } = await prepare()
    const rescuable = (await readAdminBoard(db)).rescuable
    expect(rescuable.map(({ id }) => id)).toEqual([ids.failed, ids.ignored, ids.filtered, ids.command, ids.reaction])
    expect(rescuable[3]).toEqual({
      id: ids.command,
      userName: 'mochi',
      text: '!task 洗濯',
      replyName: null,
      replyText: null,
      sentAt: new Date(NOW + 2000).toISOString(),
      status: 'dropped',
      dropReason: 'command',
      jevScore: null,
    })

    // 締め切ったあとは、振り分けられないまま残ったコメントも救い出せる
    await closeTheme(db, theme.id, LATER)
    expect((await readAdminBoard(db)).rescuable[0]).toMatchObject({ id: ids.pending, status: 'pending' })
  })

  it('救い出せるコメントだけを1件読む。意見になったもの・前のテーマのものは読まない', async () => {
    const { theme, ids } = await prepare()
    expect(await readRescuableComment(db, ids.ignored)).toMatchObject({ id: ids.ignored, text: 'AIの声が人っぽすぎると怖い', status: 'ignored' })
    expect(await readRescuableComment(db, ids.used)).toBeNull()
    expect(await readRescuableComment(db, ids.pending)).toBeNull()

    await closeTheme(db, theme.id, LATER)
    await open('次のテーマ', LATER + 1000)
    expect(await readRescuableComment(db, ids.ignored)).toBeNull()
  })

  it('救い出したコメントを既にある意見に統合し、人数ともとのコメントに足す', async () => {
    const { opinionId, ids } = await prepare()

    expect(await joinRescuedComment(db, ids.filtered, opinionId)).toBe(true)

    const opinion = (await readAdminBoard(db)).topics[0]?.opinions[0]
    expect(opinion?.people).toBe(2)
    expect(opinion?.sources.map(({ userName }) => userName)).toEqual(['aoi', 'riku'])
    // 意見になったコメントは、もう救い出せない
    expect(await joinRescuedComment(db, ids.filtered, opinionId)).toBe(false)
    expect(await joinRescuedComment(db, ids.ignored, opinionId + 100)).toBe(false)
  })

  it('救い出したコメントから、既にある論点・新しい論点に意見を作る', async () => {
    const { topicId, ids } = await prepare()

    expect(await saveRescuedOpinion(db, ids.ignored, { kind: 'insight', text: '人っぽすぎる声は怖い', topic: { type: 'existing', id: topicId } }, LATER)).toBe(true)
    expect(await saveRescuedOpinion(db, ids.failed, { kind: 'solution', text: '翻訳だけAIに任せる', topic: { type: 'new', title: '使いどころ' } }, LATER)).toBe(true)

    const board = await readAdminBoard(db)
    expect(board.topics.map(({ title, opinions }) => ({ title, opinions: opinions.map(({ text, author }) => ({ text, author })) }))).toEqual([
      { title: '視聴者との距離', opinions: [{ text: '人っぽすぎる声は怖い', author: 'mugi' }, { text: 'AIの返事は寂しい', author: 'aoi' }] },
      { title: '使いどころ', opinions: [{ text: '翻訳だけAIに任せる', author: 'sora' }] },
    ])
    expect(board.counts.used).toBe(3)
    // 意見になったコメントからは、もう作れない
    expect(await saveRescuedOpinion(db, ids.ignored, { kind: 'insight', text: '二重に作る', topic: { type: 'existing', id: topicId } }, LATER)).toBe(false)
  })

  it('締め切ったテーマでも救い出せ、振り分け待ちのまま残ったコメントも意見にできる', async () => {
    const { theme, topicId, ids } = await prepare()
    await closeTheme(db, theme.id, LATER)

    expect(await saveRescuedOpinion(db, ids.pending, { kind: 'question', text: 'AIの使いどころは後で決める？', topic: { type: 'existing', id: topicId } }, LATER)).toBe(true)
    expect((await readOverlayBoard(db)).topics[0]?.opinions[0]?.text).toBe('AIの使いどころは後で決める？')
  })

  it('論点の名前を書き換える。前のテーマの論点は書き換えない', async () => {
    const { theme, topicId } = await prepare()

    expect(await renameTopic(db, topicId, 'AIとの距離感')).toBe(true)
    expect(await readLatestThemeTopics(db)).toEqual([{ id: topicId, title: 'AIとの距離感' }])

    await closeTheme(db, theme.id, LATER)
    await open('次のテーマ', LATER + 1000)
    expect(await renameTopic(db, topicId, '古い論点')).toBe(false)
  })

  it('2つの論点を1つにまとめ、まとめた側の意見を移して論点を消す', async () => {
    const { topicId, ids } = await prepare()
    await saveRescuedOpinion(db, ids.failed, { kind: 'solution', text: '翻訳だけAIに任せる', topic: { type: 'new', title: '使いどころ' } }, LATER)
    const usage = (await readLatestThemeTopics(db)).find(({ title }) => title === '使いどころ')
    if (usage === undefined) throw new Error('論点「使いどころ」を作れませんでした')

    expect(await mergeTopics(db, usage.id, topicId)).toBe(true)

    const topics = (await readAdminBoard(db)).topics
    expect(topics.map(({ title }) => title)).toEqual(['視聴者との距離'])
    expect(topics[0]?.opinions.map(({ text }) => text)).toEqual(['翻訳だけAIに任せる', 'AIの返事は寂しい'])
    // 消した論点はもうまとめられない
    expect(await mergeTopics(db, usage.id, topicId)).toBe(false)
  })

  it('振り分けの LLM を待つあいだに論点がまとめられたら、その意見を書かずにコメントを振り分け待ちに残す', async () => {
    const { theme, topicId, ids } = await prepare()
    await saveRescuedOpinion(db, ids.failed, { kind: 'solution', text: '翻訳だけAIに任せる', topic: { type: 'new', title: '使いどころ' } }, LATER)
    const usage = (await readLatestThemeTopics(db)).find(({ title }) => title === '使いどころ')
    if (usage === undefined) throw new Error('論点「使いどころ」を作れませんでした')
    await mergeTopics(db, usage.id, topicId)

    // LLM は、まとめる前の論点（使いどころ）を指して新しい意見を返した
    await applySorting(db, theme.id, [{ type: 'new', commentIds: [ids.pending], topic: { type: 'existing', id: usage.id }, kind: 'insight', text: 'あとで考えたい' }], LATER)

    expect((await readPendingComments(db, theme.id)).map(({ id }) => id)).toEqual([ids.pending])
  })

  it('振り分けの LLM を待つあいだに論点が上限まで増えたら、新しい論点を作らずにコメントを振り分け待ちに残す', async () => {
    const { theme, ids } = await prepare()
    const rescued = [ids.reaction, ids.command, ids.filtered, ids.ignored, ids.failed]
    for (const [index, commentId] of rescued.entries()) {
      await saveRescuedOpinion(db, commentId, { kind: 'insight', text: `救い出した意見${index}`, topic: { type: 'new', title: `論点${index}` } }, LATER)
    }
    expect(await readLatestThemeTopics(db)).toHaveLength(MAX_TOPICS)

    await applySorting(db, theme.id, [{ type: 'new', commentIds: [ids.pending], topic: { type: 'new', title: '七つ目の論点' }, kind: 'insight', text: 'あとで考えたい' }], LATER)

    expect(await readLatestThemeTopics(db)).toHaveLength(MAX_TOPICS)
    expect((await readPendingComments(db, theme.id)).map(({ id }) => id)).toEqual([ids.pending])
  })
})
