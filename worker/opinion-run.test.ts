/**
 * 意見の振り分けの1回分（opinion-run.ts）のテスト
 *
 * D1（fake-database.ts）・配送先（fake-alert-channel.ts）・LLM（fake-ai.ts）を差し替えて、次の点を確かめる。
 * - テーマを開いていなければ何もせず、テーマが開いていないことを返すこと（アラームを止めるため）
 * - 渡せる発言が無ければ LLM を呼ばないこと（無料枠を食わないため）
 * - 振り分けを書いて、いまの意見ボードを合成ページへ押し出すこと
 * - LLM が失敗した・応答が照合を通らなかったら、その回の発言を失敗にして記録し、次の回に同じ発言で失敗し続けないこと
 * - 押し出しに失敗しても、書いた振り分けは残して失敗を記録すること
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createFakeAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { MERGE_GAP_MS } from './opinion'
import { runOpinionSorting } from './opinion-run'
import { openTheme, readAdminBoard, readPendingComments, recordOpinionComment } from './opinion-store'

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

describe('runOpinionSorting', () => {
  it('テーマを開いていなければ何もせず、開いていないことを返す', async () => {
    const llm = createFakeAi({ response: newOpinionResponse })
    const alerts = createFakeAlertChannel()
    expect(await runOpinionSorting({ db, alerts: alerts.namespace, llm, now: READY })).toBe(false)
    expect(llm.calls).toEqual([])
  })

  it('渡せる発言が無ければ LLM を呼ばない', async () => {
    await prepare()
    const llm = createFakeAi({ response: newOpinionResponse })
    const alerts = createFakeAlertChannel()
    // 続きが来るかもしれないあいだは渡さない
    expect(await runOpinionSorting({ db, alerts: alerts.namespace, llm, now: NOW + 1000 })).toBe(true)
    expect(llm.calls).toEqual([])
    expect(alerts.pushedOpinions).toEqual([])
  })

  it('振り分けを書き、いまの意見ボードを押し出す', async () => {
    await prepare()
    const llm = createFakeAi({ response: newOpinionResponse })
    const alerts = createFakeAlertChannel()

    expect(await runOpinionSorting({ db, alerts: alerts.namespace, llm, now: READY })).toBe(true)

    expect(llm.calls).toHaveLength(1)
    expect(alerts.pushedOpinions).toHaveLength(1)
    expect(alerts.pushedOpinions[0]?.topics).toEqual([
      { id: expect.any(Number), title: '視聴者との距離', opinions: [{ id: expect.any(Number), kind: 'issue', text: 'AIの返事は寂しい', author: 'aoi', createdAt: new Date(READY).toISOString() }] },
    ])
  })

  it('LLM が失敗したら、その回の発言を失敗にして記録する', async () => {
    const themeId = await prepare()
    const alerts = createFakeAlertChannel()

    expect(await runOpinionSorting({ db, alerts: alerts.namespace, llm: createFakeAi({ shouldFail: true }), now: READY })).toBe(true)

    expect(await readPendingComments(db, themeId)).toEqual([])
    expect(failureCodes()).toEqual(['opinion-sort-failed'])
    expect(alerts.pushedOpinions).toEqual([])
  })

  it('応答が照合を通らなければ、その回の発言を失敗にして記録する', async () => {
    const themeId = await prepare()
    const alerts = createFakeAlertChannel()

    await runOpinionSorting({ db, alerts: alerts.namespace, llm: createFakeAi({ response: '振り分けました' }), now: READY })

    expect(await readPendingComments(db, themeId)).toEqual([])
    expect(failureCodes()).toEqual(['opinion-sort-failed'])
  })

  it('押し出しに失敗しても、書いた振り分けは残して記録する', async () => {
    await prepare()
    const alerts = createFakeAlertChannel({ shouldFail: true })

    await runOpinionSorting({ db, alerts: alerts.namespace, llm: createFakeAi({ response: newOpinionResponse }), now: READY })

    expect((await readAdminBoard(db)).topics).toHaveLength(1)
    expect(failureCodes()).toEqual(['opinion-push-failed'])
  })
})
