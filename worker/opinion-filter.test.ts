/**
 * Jev による振り分け前の絞り込み（opinion-filter.ts）のテスト
 *
 * Jev を代役に差し替えて、次の点を確かめる。
 * - 1回の振り分けの発言をまとめて1回の呼び出しで尋ね、箇所 opinionFilter を指名すること
 * - 材料にテーマと発言（返信なら返信先の発言も）を入れること
 * - 発言ごとに確率を添え、しきい値に届かない発言だけを落とす印を付けること
 * - Jev の失敗はそのまま投げること（黙って全件を通さない）
 */
import { describe, expect, it } from 'vitest'
import { createFakeNoulJev } from './fake-jev'
import type { Utterance } from './opinion'
import { buildOpinionFilterRequest, filterUtterances } from './opinion-filter'

const THEME = '配信中にAIをどこまで使っていい？'

/** 返信ではない発言 */
const opinionUtterance: Utterance = { commentIds: [1, 2], userName: 'aoi', text: 'AIのコメ返しは ちょっと寂しい', replyName: null, replyText: null }
/** 返信の発言（「それな」は返信先の意見への賛同） */
const replyUtterance: Utterance = { commentIds: [3], userName: 'riku', text: 'それな', replyName: 'aoi', replyText: 'AIのコメ返しはちょっと寂しい' }
/** 雑談 */
const chatUtterance: Utterance = { commentIds: [4], userName: 'mugi', text: '今日の晩ごはんはカレー', replyName: null, replyText: null }

describe('buildOpinionFilterRequest', () => {
  it('テーマと発言を材料にし、発言ごとに Noul の質問を1つずつ作る', () => {
    const request = buildOpinionFilterRequest(THEME, [opinionUtterance, replyUtterance])

    expect(request.state).toEqual({
      theme: THEME,
      utterances: {
        C1: { text: 'AIのコメ返しは ちょっと寂しい' },
        C2: { text: 'それな', replyTo: 'AIのコメ返しはちょっと寂しい' },
      },
    })
    expect(Object.keys(request.questions)).toEqual(['C1', 'C2'])
    expect(request.questions.C1?.type).toBe('noul')
    // 質問は、どの発言を指すかを中身だけで分かるようにする（質問の名前はモデルに意味が伝わらないため）
    expect(JSON.stringify(request.questions.C2?.instructions)).toContain('utterances.C2')
  })
})

describe('filterUtterances', () => {
  it('発言をまとめて1回で尋ね、発言ごとに確率を添える', async () => {
    const jev = createFakeNoulJev({ C1: 0.92, C2: 0.71, C3: 0.03 })

    const results = await filterUtterances(jev, THEME, [opinionUtterance, replyUtterance, chatUtterance], 0.5)

    expect(jev.usages).toEqual(['opinionFilter'])
    expect(results).toEqual([
      { utterance: opinionUtterance, score: 0.92, kept: true },
      { utterance: replyUtterance, score: 0.71, kept: true },
      { utterance: chatUtterance, score: 0.03, kept: false },
    ])
  })

  it('しきい値が0なら、確率がいくつでも落とさない（記録だけする）', async () => {
    const jev = createFakeNoulJev({ C1: 0 })

    expect(await filterUtterances(jev, THEME, [chatUtterance], 0)).toEqual([{ utterance: chatUtterance, score: 0, kept: true }])
  })

  it('Jev が失敗したら、そのまま投げる（黙って全件を通さない）', async () => {
    const jev = createFakeNoulJev(new Error('Jev が失敗を返しました（402）'))

    await expect(filterUtterances(jev, THEME, [opinionUtterance], 0)).rejects.toThrow('Jev が失敗を返しました')
  })
})
