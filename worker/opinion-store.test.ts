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
 * - 論点の作り直しを、意見が決まった数だけ増えたときにだけ1回引き受け、分け直した論点を1つの batch で書くこと。
 *   LLM を待つあいだに盤面が変わっていたら書かないこと。名前を変えた・まとめ先にした論点の名前を固定すること（issue #402）
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
  readThemeReviews,
  readLatestThemeTopics,
  readPendingComments,
  readRescuableComment,
  readSortingBoard,
  readThemeSummary,
  readVisibleBoard,
  recordFilterResults,
  recordOpinionComment,
  applySorting,
  applyRegrouping,
  claimRegroup,
  readRegroupBoard,
  renameTopic,
  saveRescuedOpinion,
  saveThemePrompt,
  saveThemeSummary,
  setOpinionHidden,
  type OpinionCommentInput,
} from './opinion-store'
import { MAX_TOPICS } from './opinion'
import { planRegrouping } from './opinion-regroup'

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

describe('配信後のまとめ（issue #309）', () => {
  const summary = {
    agreements: ['初見への挨拶ならAIでもよい'],
    disagreements: ['コメ返しをAIに任せるかは意見が分かれた'],
    openQuestions: ['AIの使用料はどこまで払うか'],
  }

  it('締め切ったテーマにまとめを書き、テーマのIDと管理画面から読める', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    await closeTheme(db, theme.id, LATER)

    expect(await saveThemeSummary(db, theme.id, summary, LATER)).toBe(true)

    const expected = { ...summary, createdAt: new Date(LATER).toISOString() }
    expect(await readThemeSummary(db, theme.id)).toEqual(expected)
    expect((await readAdminBoard(db)).summary).toEqual(expected)
  })

  it('作り直したら置き換える', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    await closeTheme(db, theme.id, LATER)
    await saveThemeSummary(db, theme.id, summary, LATER)

    await saveThemeSummary(db, theme.id, { agreements: [], disagreements: ['分かれた'], openQuestions: [] }, LATER + 1000)

    expect(await readThemeSummary(db, theme.id)).toEqual({
      agreements: [],
      disagreements: ['分かれた'],
      openQuestions: [],
      createdAt: new Date(LATER + 1000).toISOString(),
    })
  })

  it('開いているテーマには書かない', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')

    expect(await saveThemeSummary(db, theme.id, summary, LATER)).toBe(false)
    expect(await readThemeSummary(db, theme.id)).toBeNull()
  })

  it('まとめがなければ null で、合成ページには渡さない', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    await closeTheme(db, theme.id, LATER)

    expect(await readThemeSummary(db, theme.id)).toBeNull()
    expect((await readAdminBoard(db)).summary).toBeNull()
    await saveThemeSummary(db, theme.id, summary, LATER)
    expect(JSON.stringify(await readOverlayBoard(db))).not.toContain('初見への挨拶')
  })

  it('保存した中身が壊れていたら、黙って空にせず投げる', async () => {
    const theme = await open('配信中にAIをどこまで使っていい？')
    await closeTheme(db, theme.id, LATER)
    db.sqlite.prepare("INSERT INTO opinion_summaries (theme_id, agreements, disagreements, open_questions, created_at) VALUES (?, 'x', '[]', '[]', 'now')").run(theme.id)

    await expect(readThemeSummary(db, theme.id)).rejects.toThrow('まとめ')
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

describe('論点の作り直し（issue #402）', () => {
  /**
   * テーマを開き、論点「指示厨の特徴」に特徴1件・対策2件、論点「ネタバレ」に1件の意見を作る（2026-10-16 の本番に近い盤面）。
   */
  const prepare = async () => {
    const theme = await open('ネタバレ・指示厨対策')
    const texts = ['初見に多い', 'ハートをつけてもらう', '三度でBANする', 'ネタバレは楽しみを奪う']
    for (const [index, text] of texts.entries()) await recordOpinionComment(db, comment(`m${index}`, `viewer${index}`, text), NOW + index * 1000)
    const [first, second, third, fourth] = (await readPendingComments(db, theme.id)).map(({ id }) => id)
    if (first === undefined || second === undefined || third === undefined || fourth === undefined) throw new Error('コメントが4件貯まっていません')
    await applySorting(
      db,
      theme.id,
      [
        { type: 'new', commentIds: [first], topic: { type: 'new', title: '指示厨の特徴' }, kind: 'insight', text: '指示厨は初見に多い' },
        { type: 'new', commentIds: [second], topic: { type: 'new', title: '指示厨の特徴' }, kind: 'solution', text: '指示コメントにはハートをつけてもらう' },
        { type: 'new', commentIds: [third], topic: { type: 'new', title: '指示厨の特徴' }, kind: 'solution', text: '強制タイムアウトし、三度でBANする' },
        { type: 'new', commentIds: [fourth], topic: { type: 'new', title: 'ネタバレ' }, kind: 'issue', text: 'ネタバレは配信の楽しみを奪う' },
      ],
      NOW,
    )
    const board = await readRegroupBoard(db, theme.id)
    const ids = board.flatMap(({ opinions }) => opinions.map(({ id }) => id))
    const [trait, heart, ban, spoiler] = ids
    const [traitTopic, spoilerTopic] = board.map(({ id }) => id)
    if (trait === undefined || heart === undefined || ban === undefined || spoiler === undefined || traitTopic === undefined || spoilerTopic === undefined) {
      throw new Error('意見を作れませんでした')
    }
    return { theme, board, opinions: { trait, heart, ban, spoiler }, topics: { trait: traitTopic, spoiler: spoilerTopic } }
  }

  it('論点と意見を、隠したものと名前の固定を添えて作った順に読む', async () => {
    const { theme, opinions, topics } = await prepare()
    await setOpinionHidden(db, opinions.ban, true)
    await renameTopic(db, topics.spoiler, 'ネタバレの扱い')

    expect(await readRegroupBoard(db, theme.id)).toEqual([
      {
        id: topics.trait,
        title: '指示厨の特徴',
        titleLocked: false,
        opinions: [
          { id: opinions.trait, kind: 'insight', text: '指示厨は初見に多い', hidden: false },
          { id: opinions.heart, kind: 'solution', text: '指示コメントにはハートをつけてもらう', hidden: false },
          { id: opinions.ban, kind: 'solution', text: '強制タイムアウトし、三度でBANする', hidden: true },
        ],
      },
      { id: topics.spoiler, title: 'ネタバレの扱い', titleLocked: true, opinions: [{ id: opinions.spoiler, kind: 'issue', text: 'ネタバレは配信の楽しみを奪う', hidden: false }] },
    ])
  })

  it('まとめ先にした論点は名前を固定する', async () => {
    const { theme, topics } = await prepare()
    await mergeTopics(db, topics.trait, topics.spoiler)
    expect((await readRegroupBoard(db, theme.id)).map(({ title, titleLocked }) => ({ title, titleLocked }))).toEqual([{ title: 'ネタバレ', titleLocked: true }])
  })

  it('意見が決まった数だけ増えたときにだけ、作り直しを1回引き受ける', async () => {
    const { theme } = await prepare()
    // 前に作り直してから4件増えた。5件ごとなら、まだ作り直さない
    expect(await claimRegroup(db, theme.id, 5)).toBe(false)
    // 4件ごとなら作り直す。引き受けたら数を覚え、同じ数のあいだは二度と引き受けない
    expect(await claimRegroup(db, theme.id, 4)).toBe(true)
    expect(await claimRegroup(db, theme.id, 1)).toBe(false)
  })

  it('分け直した論点を書く。IDを継いだ論点は名前だけが変わり、新しい論点は後ろに足す', async () => {
    const { theme, board, opinions, topics } = await prepare()
    const plan = planRegrouping(board, [
      { title: '指示厨の特徴', opinionIds: [opinions.trait] },
      { title: '指示厨への対策', opinionIds: [opinions.heart, opinions.ban] },
      { title: 'ネタバレ', opinionIds: [opinions.spoiler] },
    ])

    expect(await applyRegrouping(db, theme.id, board, plan, LATER)).toBe(true)

    const after = await readRegroupBoard(db, theme.id)
    expect(after.map(({ id, title, opinions: list }) => ({ id, title, opinions: list.map(({ id: opinionId }) => opinionId) }))).toEqual([
      // 対策の2件を受け取った論点が、もとの「指示厨の特徴」のIDを継ぐ
      { id: topics.trait, title: '指示厨への対策', opinions: [opinions.heart, opinions.ban] },
      { id: topics.spoiler, title: 'ネタバレ', opinions: [opinions.spoiler] },
      { id: expect.any(Number), title: '指示厨の特徴', opinions: [opinions.trait] },
    ])
    // 意見そのもの（1文・札の種類）と人数は変わらない
    expect((await readAdminBoard(db)).topics.flatMap(({ opinions: list }) => list.map(({ text, people }) => ({ text, people })))).toContainEqual({
      text: '指示厨は初見に多い',
      people: 1,
    })
  })

  it('対応しなかった論点を消し、残っていた隠した意見を移す', async () => {
    const { theme, opinions, topics } = await prepare()
    await setOpinionHidden(db, opinions.spoiler, true)
    // 「ネタバレ」に隠していない意見を足してから、2つを1つにまとめ直す
    await recordOpinionComment(db, comment('m9', 'viewer9', '見どころを先に言わない'), NOW + 9000)
    const [pending] = await readPendingComments(db, theme.id)
    if (pending === undefined) throw new Error('コメントを貯められませんでした')
    await applySorting(db, theme.id, [{ type: 'new', commentIds: [pending.id], topic: { type: 'existing', id: topics.spoiler }, kind: 'solution', text: '見どころを先に言わない' }], NOW)
    const board = await readRegroupBoard(db, theme.id)
    const added = board[1]?.opinions.find(({ text }) => text === '見どころを先に言わない')?.id
    if (added === undefined) throw new Error('意見を作れませんでした')

    const plan = planRegrouping(board, [{ title: '配信の荒れ方', opinionIds: [opinions.trait, opinions.heart, opinions.ban, added] }])
    expect(await applyRegrouping(db, theme.id, board, plan, LATER)).toBe(true)

    const after = await readRegroupBoard(db, theme.id)
    expect(after.map(({ id, title }) => ({ id, title }))).toEqual([{ id: topics.trait, title: '配信の荒れ方' }])
    expect(after[0]?.opinions.map(({ id }) => id).sort()).toEqual([opinions.trait, opinions.heart, opinions.ban, opinions.spoiler, added].sort())
  })

  it('名前を入れ替えるだけの作り直しも書ける（同じ名前の論点を一時的に作らない）', async () => {
    const { theme, board, opinions, topics } = await prepare()
    const plan = planRegrouping(board, [
      { title: 'ネタバレ', opinionIds: [opinions.trait, opinions.heart, opinions.ban] },
      { title: '指示厨の特徴', opinionIds: [opinions.spoiler] },
    ])
    expect(await applyRegrouping(db, theme.id, board, plan, LATER)).toBe(true)
    expect((await readRegroupBoard(db, theme.id)).map(({ id, title }) => ({ id, title }))).toEqual([
      { id: topics.trait, title: 'ネタバレ' },
      { id: topics.spoiler, title: '指示厨の特徴' },
    ])
  })

  it('LLM を待つあいだに盤面が変わっていたら、何も書かない', async () => {
    const { theme, board, opinions, topics } = await prepare()
    const plan = planRegrouping(board, [{ title: 'ぜんぶ', opinionIds: [opinions.trait, opinions.heart, opinions.ban, opinions.spoiler] }])
    // 配信者が名前を変えた
    await renameTopic(db, topics.spoiler, 'ネタバレの扱い')

    expect(await applyRegrouping(db, theme.id, board, plan, LATER)).toBe(false)
    expect((await readRegroupBoard(db, theme.id)).map(({ title }) => title)).toEqual(['指示厨の特徴', 'ネタバレの扱い'])
  })

  it('最後に開いたテーマでなくなっていたら、何も書かない', async () => {
    const { theme, board, opinions } = await prepare()
    const plan = planRegrouping(board, [{ title: 'ぜんぶ', opinionIds: [opinions.trait, opinions.heart, opinions.ban, opinions.spoiler] }])
    await closeTheme(db, theme.id, LATER)
    await open('次のテーマ', LATER + 1000)

    expect(await applyRegrouping(db, theme.id, board, plan, LATER)).toBe(false)
    expect((await readRegroupBoard(db, theme.id)).map(({ title }) => title)).toEqual(['指示厨の特徴', 'ネタバレ'])
  })
})

describe('配信後の振り返り（issue #309）', () => {
  const HOUR = 60 * 60 * 1000

  /** テーマを開いてコメントを貯め、2件を1つの意見にして、テーマを締め切る */
  const runTheme = async (title: string, openedAt: number, userName: string, text: string) => {
    const theme = await open(title, openedAt)
    await recordOpinionComment(db, comment(`m-${title}-1`, userName, text), openedAt + 1000)
    await recordOpinionComment(db, comment(`m-${title}-2`, `${userName}の友人`, `${text}（同意）`), openedAt + 2000)
    await recordOpinionComment(db, { ...comment(`m-${title}-3`, 'nekomaru', '草'), dropReason: 'reaction' }, openedAt + 3000)
    const [first, second] = (await readPendingComments(db, theme.id)).map(({ id }) => id)
    if (first === undefined || second === undefined) throw new Error('コメントが貯まっていません')
    await applySorting(db, theme.id, [{ type: 'new', commentIds: [first, second], topic: { type: 'new', title: `${title}の論点` }, kind: 'issue', text: `${text}という課題` }], openedAt + 4000)
    await closeTheme(db, theme.id, openedAt + 5000)
    return theme
  }

  it('配信の時間に開いたテーマだけを、古い順に、全論点・全意見・人数・原文つきで返す', async () => {
    await runTheme('配信の前に開いたテーマ', NOW - 2 * HOUR, 'aoi', '前の配信の話')
    const first = await runTheme('AIの使いどころ', NOW + HOUR, 'riku', '返事が遅いと寂しい')
    const second = await runTheme('BGMの好み', NOW + 2 * HOUR, 'mochi', '作業用の曲がいい')
    await runTheme('配信のあとに開いたテーマ', NOW + 5 * HOUR, 'yuki', '次の配信の話')

    const reviews = await readThemeReviews(db, NOW, NOW + 3 * HOUR)

    expect(reviews.map(({ theme }) => theme.id)).toEqual([first.id, second.id])
    expect(reviews[0]?.topics).toEqual([
      {
        id: expect.any(Number),
        title: 'AIの使いどころの論点',
        opinions: [
          {
            id: expect.any(Number),
            kind: 'issue',
            text: '返事が遅いと寂しいという課題',
            author: 'riku',
            createdAt: new Date(NOW + HOUR + 4000).toISOString(),
            hidden: false,
            people: 2,
            sources: [
              { userName: 'riku', text: '返事が遅いと寂しい' },
              { userName: 'rikuの友人', text: '返事が遅いと寂しい（同意）' },
            ],
          },
        ],
      },
    ])
  })

  it('隠した意見も hidden つきで返し、コメントの内訳を添える', async () => {
    const theme = await runTheme('AIの使いどころ', NOW + HOUR, 'riku', '返事が遅いと寂しい')
    const opinionId = (await readSortingBoard(db, theme.id))[0]?.opinions[0]?.id ?? 0
    await setOpinionHidden(db, opinionId, true)

    const [review] = await readThemeReviews(db, NOW, NOW + 3 * HOUR)

    expect(review?.topics[0]?.opinions[0]).toMatchObject({ id: opinionId, hidden: true })
    expect(review?.counts).toMatchObject({ received: 3, used: 2, dropped: { reaction: 1, command: 0, emote: 0 } })
  })

  it('配信の時間の終わりちょうどに開いたテーマも含め、時間の外は含めない', async () => {
    const edge = await runTheme('終わりぎわのテーマ', NOW + HOUR, 'riku', '返事が遅いと寂しい')

    expect((await readThemeReviews(db, NOW, NOW + HOUR)).map(({ theme }) => theme.id)).toEqual([edge.id])
    expect(await readThemeReviews(db, NOW, NOW + HOUR - 1)).toEqual([])
    expect(await readThemeReviews(db, NOW + HOUR + 1, NOW + 2 * HOUR)).toEqual([])
  })

  it('開いているテーマ（まだ意見が無い）も、論点なしで返す', async () => {
    const theme = await open('いま開いているテーマ', NOW + HOUR)

    const reviews = await readThemeReviews(db, NOW, NOW + 3 * HOUR)

    expect(reviews).toEqual([{ theme, topics: [], counts: expect.objectContaining({ received: 0 }), summary: null }])
  })

  it('締め切ったときに作ったまとめをテーマごとに添え、作っていないテーマは null にする', async () => {
    const summarized = await runTheme('AIの使いどころ', NOW + HOUR, 'riku', '返事が遅いと寂しい')
    await runTheme('BGMの好み', NOW + 2 * HOUR, 'mochi', '作業用の曲がいい')
    const summary = { agreements: ['返事の遅さは寂しい'], disagreements: [], openQuestions: ['どこまでAIに任せるか'] }
    await saveThemeSummary(db, summarized.id, summary, NOW + 3 * HOUR)

    const reviews = await readThemeReviews(db, NOW, NOW + 3 * HOUR)

    expect(reviews.map((review) => review.summary)).toEqual([{ ...summary, createdAt: new Date(NOW + 3 * HOUR).toISOString() }, null])
  })
})
