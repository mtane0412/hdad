/**
 * 意見の振り分けの1回分（opinion-run.ts）のテスト
 *
 * D1（fake-database.ts）・配送先（fake-alert-channel.ts）・LLM（fake-ai.ts）を差し替えて、次の点を確かめる。
 * - テーマを開いていなければ何もせず、テーマが開いていないことを返すこと（アラームを止めるため）
 * - 渡せる発言が無ければ LLM を呼ばないこと（無料枠を食わないため）
 * - 振り分けを書いて、いまの意見ボードを合成ページへ押し出すこと
 * - LLM が失敗した・応答が照合を通らなかったら、その回の発言を失敗にして記録し、次の回に同じ発言で失敗し続けないこと
 * - 押し出しに失敗しても、書いた振り分けは残して失敗を記録すること
 * - Jev で絞り込んでから振り分けの LLM に渡し、Jev の失敗はその回の発言を失敗にすること。鍵が無ければ絞り込まないこと（issue #307）
 * - 問いかけが無いあいだに新しい意見ができたとき・問いかけに答える発言が届いたときだけ、問いかけを作り直すこと（issue #307）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeNoulJev } from './fake-jev'
import type { LlmUsage } from './llm-config'
import type { LlmRequest, TextGenerator } from './llm'
import { MERGE_GAP_MS } from './opinion'
import { runOpinionSorting, type OpinionSortingDependencies } from './opinion-run'
import { openTheme, readAdminBoard, readOpenTheme, readPendingComments, recordOpinionComment, saveThemePrompt } from './opinion-store'

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
/** 続きを待つ間隔が過ぎた時刻 */
const READY = NOW + MERGE_GAP_MS + 1000

let db: ReturnType<typeof createFakeDatabase>

beforeEach(() => {
  db = createFakeDatabase()
})

/** テーマを開いて、コメントを1件貯める */
const prepare = async (): Promise<number> => {
  const theme = await openTheme(db, '配信中にAIをどこまで使っていい？', NOW)
  if (theme === null) throw new Error('テーマを開けませんでした')
  await recordOpinionComment(
    db,
    { messageId: 'm1', userId: 'id-aoi', userName: 'aoi', text: 'AIのコメ返しはちょっと寂しい', replyName: null, replyText: null, dropReason: null },
    NOW,
  )
  return theme.id
}

/** 発言 C1 を新しい論点の新しい意見にする応答 */
const newOpinionResponse = JSON.stringify({ results: [{ comments: ['C1'], action: 'new', newTopic: '視聴者との距離', kind: '課題', text: 'AIの返事は寂しい' }] })

/** 失敗の記録の種類を読む */
const failureCodes = (): unknown[] => db.sqlite.prepare('SELECT code FROM collection_failures').all().map((row) => row.code)

/**
 * 箇所ごとに決まった応答を返す LLM の代役（振り分けと問いかけで別の応答を返すため）。
 *
 * 応答を決めていない箇所が呼ばれたら失敗する（問いかけの作り直しの失敗の再現にも使う）。
 */
const createRoutedAi = (responses: Partial<Record<LlmUsage, string>>): TextGenerator & { calls: { usage: LlmUsage; request: LlmRequest }[] } => {
  const calls: { usage: LlmUsage; request: LlmRequest }[] = []
  return {
    calls,
    run: (usage, request) => {
      calls.push({ usage, request })
      const response = responses[usage]
      return response === undefined ? Promise.reject(new Error(`${usage} の無料枠を使い切りました`)) : Promise.resolve(response)
    },
  }
}

/** 新しい問いかけ */
const NEXT_PROMPT = 'AIの使用料、配信者はどこまで払っていいと思う？'

/** Jev を使わない（鍵が無い）ときの、振り分けの1回分に要るもののうち LLM と時刻以外 */
const withoutJev = { jev: null, filterThreshold: 0 } as const

describe('runOpinionSorting', () => {
  it('テーマを開いていなければ何もせず、開いていないことを返す', async () => {
    const llm = createFakeAi({ response: newOpinionResponse })
    const alerts = createFakeAlertChannel()
    expect(await runOpinionSorting({ db, alerts: alerts.namespace, llm, now: READY, ...withoutJev })).toBe(false)
    expect(llm.calls).toEqual([])
  })

  it('渡せる発言が無ければ LLM を呼ばない', async () => {
    await prepare()
    const llm = createFakeAi({ response: newOpinionResponse })
    const alerts = createFakeAlertChannel()
    // 続きが来るかもしれないあいだは渡さない
    expect(await runOpinionSorting({ db, alerts: alerts.namespace, llm, now: NOW + 1000, ...withoutJev })).toBe(true)
    expect(llm.calls).toEqual([])
    expect(alerts.pushedOpinions).toEqual([])
  })

  it('振り分けを書き、いまの意見ボードを押し出す', async () => {
    await prepare()
    const llm = createRoutedAi({ opinionSort: newOpinionResponse, opinionPrompt: NEXT_PROMPT })
    const alerts = createFakeAlertChannel()

    expect(await runOpinionSorting({ db, alerts: alerts.namespace, llm, now: READY, ...withoutJev })).toBe(true)

    expect(llm.calls.map(({ usage }) => usage)).toEqual(['opinionSort', 'opinionPrompt'])
    // 振り分けのあとにすぐ押し出し、問いかけを作れたらもう一度押し出す
    expect(alerts.pushedOpinions).toHaveLength(2)
    expect(alerts.pushedOpinions[0]?.topics).toEqual([
      { id: expect.any(Number), title: '視聴者との距離', opinions: [{ id: expect.any(Number), kind: 'issue', text: 'AIの返事は寂しい', author: 'aoi', createdAt: new Date(READY).toISOString() }] },
    ])
  })

  it('LLM が失敗したら、その回の発言を失敗にして記録する', async () => {
    const themeId = await prepare()
    const alerts = createFakeAlertChannel()

    expect(await runOpinionSorting({ db, alerts: alerts.namespace, llm: createFakeAi({ shouldFail: true }), now: READY, ...withoutJev })).toBe(true)

    expect(await readPendingComments(db, themeId)).toEqual([])
    expect(failureCodes()).toEqual(['opinion-sort-failed'])
    expect(alerts.pushedOpinions).toEqual([])
  })

  it('応答が照合を通らなければ、その回の発言を失敗にして記録する', async () => {
    const themeId = await prepare()
    const alerts = createFakeAlertChannel()

    await runOpinionSorting({ db, alerts: alerts.namespace, llm: createFakeAi({ response: '振り分けました' }), now: READY, ...withoutJev })

    expect(await readPendingComments(db, themeId)).toEqual([])
    expect(failureCodes()).toEqual(['opinion-sort-failed'])
  })

  it('押し出しに失敗しても、書いた振り分けは残して記録する', async () => {
    await prepare()
    const alerts = createFakeAlertChannel({ shouldFail: true })

    await runOpinionSorting({ db, alerts: alerts.namespace, llm: createRoutedAi({ opinionSort: newOpinionResponse, opinionPrompt: NEXT_PROMPT }), now: READY, ...withoutJev })

    expect((await readAdminBoard(db)).topics).toHaveLength(1)
    // 振り分けのあとと問いかけを作ったあとの2回とも送れなかったが、記録は時刻と種類が同じなので1行にまとまる
    expect(failureCodes()).toEqual(['opinion-push-failed'])
  })
})

describe('runOpinionSorting の Jev による絞り込み', () => {
  /** テーマを開き、意見と雑談のコメントを1件ずつ貯める */
  const prepareTwo = async (): Promise<number> => {
    const themeId = await prepare()
    await recordOpinionComment(
      db,
      { messageId: 'm2', userId: 'id-mugi', userName: 'mugi', text: '今日の晩ごはんはカレー', replyName: null, replyText: null, dropReason: null },
      NOW,
    )
    return themeId
  }

  /** 振り分けの1回分に要るもの（LLM・Jev・しきい値を差し替える） */
  const dependencies = (overrides: Partial<OpinionSortingDependencies>): OpinionSortingDependencies => ({
    db,
    alerts: createFakeAlertChannel().namespace,
    llm: createRoutedAi({ opinionSort: newOpinionResponse, opinionPrompt: NEXT_PROMPT }),
    now: READY,
    ...withoutJev,
    ...overrides,
  })

  /** コメントの状態と Jev の確率を、IDの順に読む */
  const statuses = (): unknown[] => db.sqlite.prepare('SELECT status, jev_score FROM opinion_comments ORDER BY id').all().map((row) => ({ ...row }))

  it('しきい値に届かない発言は振り分けの LLM に渡さず、確率を残す', async () => {
    await prepareTwo()
    const jev = createFakeNoulJev({ C1: 0.92, C2: 0.03 })
    const llm = createRoutedAi({ opinionSort: newOpinionResponse, opinionPrompt: NEXT_PROMPT })

    await runOpinionSorting(dependencies({ jev, llm, filterThreshold: 0.5 }))

    expect(jev.usages).toEqual(['opinionFilter'])
    // 振り分けの LLM には、しきい値に届いた発言（aoi）だけを渡す
    const sortPrompt = llm.calls.find(({ usage }) => usage === 'opinionSort')?.request.messages.at(-1)?.content ?? ''
    expect(sortPrompt).toContain('[C1] aoi')
    expect(sortPrompt).not.toContain('カレー')
    expect(statuses()).toEqual([
      { status: 'used', jev_score: 0.92 },
      { status: 'filtered', jev_score: 0.03 },
    ])
  })

  it('全部の発言がしきい値に届かなければ、振り分けの LLM を呼ばない', async () => {
    await prepareTwo()
    const llm = createRoutedAi({ opinionSort: newOpinionResponse })

    await runOpinionSorting(dependencies({ jev: createFakeNoulJev({ C1: 0.1, C2: 0.03 }), llm, filterThreshold: 0.5 }))

    expect(llm.calls).toEqual([])
  })

  it('Jev が失敗したら、その回の発言を失敗にして記録する（黙って全件を通さない）', async () => {
    const themeId = await prepareTwo()
    const llm = createRoutedAi({ opinionSort: newOpinionResponse })

    await runOpinionSorting(dependencies({ jev: createFakeNoulJev(new Error('Jev が失敗を返しました（402）')), llm }))

    expect(llm.calls).toEqual([])
    expect(await readPendingComments(db, themeId)).toEqual([])
    expect(failureCodes()).toEqual(['opinion-filter-failed'])
  })

  it('Jev を使わない（鍵が無い）ときは、絞り込まずに振り分けの LLM へ渡す', async () => {
    await prepareTwo()
    const llm = createRoutedAi({
      opinionSort: JSON.stringify({ results: [{ comments: ['C1'], action: 'new', newTopic: '視聴者との距離', kind: '課題', text: 'AIの返事は寂しい' }, { comments: ['C2'], action: 'ignore' }] }),
      opinionPrompt: NEXT_PROMPT,
    })

    await runOpinionSorting(dependencies({ llm }))

    expect(statuses()).toEqual([
      { status: 'used', jev_score: null },
      { status: 'ignored', jev_score: null },
    ])
  })
})

describe('runOpinionSorting の問いかけ', () => {
  /** 振り分けの1回分に要るもの */
  const dependencies = (llm: TextGenerator, alerts = createFakeAlertChannel()): OpinionSortingDependencies => ({ db, alerts: alerts.namespace, llm, now: READY, ...withoutJev })

  it('問いかけが無いあいだに新しい意見ができたら、問いかけを作って押し出す', async () => {
    await prepare()
    const llm = createRoutedAi({ opinionSort: newOpinionResponse, opinionPrompt: NEXT_PROMPT })
    const alerts = createFakeAlertChannel()

    await runOpinionSorting(dependencies(llm, alerts))

    expect(llm.calls.map(({ usage }) => usage)).toEqual(['opinionSort', 'opinionPrompt'])
    expect((await readOpenTheme(db))?.prompt).toBe(NEXT_PROMPT)
    expect(alerts.pushedOpinions.at(-1)?.theme?.prompt).toBe(NEXT_PROMPT)
  })

  it('新しい意見ができなければ、問いかけを作らない', async () => {
    await prepare()
    const llm = createRoutedAi({ opinionSort: JSON.stringify({ results: [{ comments: ['C1'], action: 'ignore' }] }), opinionPrompt: NEXT_PROMPT })

    await runOpinionSorting(dependencies(llm))

    expect(llm.calls.map(({ usage }) => usage)).toEqual(['opinionSort'])
    expect((await readOpenTheme(db))?.prompt).toBeNull()
  })

  it('問いかけを出しているあいだは、新しい意見ができても答えでなければ作り直さない', async () => {
    const themeId = await prepare()
    await saveThemePrompt(db, themeId, 'AIに任せたくない作業はどれ？')
    const llm = createRoutedAi({ opinionSort: newOpinionResponse, opinionPrompt: NEXT_PROMPT })

    await runOpinionSorting(dependencies(llm))

    expect(llm.calls.map(({ usage }) => usage)).toEqual(['opinionSort'])
    expect((await readOpenTheme(db))?.prompt).toBe('AIに任せたくない作業はどれ？')
  })

  it('問いかけに答える発言が届いたら、前の問いかけを添えて次の問いかけに切り替える', async () => {
    const themeId = await prepare()
    await saveThemePrompt(db, themeId, 'AIに任せたくない作業はどれ？')
    const answered = JSON.stringify({ results: [{ comments: ['C1'], action: 'new', newTopic: '任せたくない作業', kind: '課題', text: 'コメ返しはAIに任せたくない', answersPrompt: true }] })
    const llm = createRoutedAi({ opinionSort: answered, opinionPrompt: NEXT_PROMPT })

    await runOpinionSorting(dependencies(llm))

    // 振り分けの LLM にはいまの問いかけを渡し、問いかけの LLM には前の問いかけを避けさせる
    expect(llm.calls[0]?.request.messages.at(-1)?.content).toContain('AIに任せたくない作業はどれ？')
    expect(llm.calls[1]?.request.messages.at(-1)?.content).toContain('AIに任せたくない作業はどれ？')
    expect((await readOpenTheme(db))?.prompt).toBe(NEXT_PROMPT)
  })

  it('問いかけを作れなければ、前の問いかけを残して記録する', async () => {
    const themeId = await prepare()
    await saveThemePrompt(db, themeId, 'AIに任せたくない作業はどれ？')
    const answered = JSON.stringify({ results: [{ comments: ['C1'], action: 'new', newTopic: '任せたくない作業', kind: '課題', text: 'コメ返しはAIに任せたくない', answersPrompt: true }] })
    // 問いかけが上限の文字数を超える（切り詰めずに拒む）
    const llm = createRoutedAi({ opinionSort: answered, opinionPrompt: 'あ'.repeat(100) })

    await runOpinionSorting(dependencies(llm))

    expect((await readOpenTheme(db))?.prompt).toBe('AIに任せたくない作業はどれ？')
    expect(failureCodes()).toEqual(['opinion-prompt-failed'])
  })
})
