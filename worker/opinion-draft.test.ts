/**
 * 救い出したコメントから作る意見の下書き（opinion-draft.ts）のテスト
 *
 * LLM を代役に差し替えて、次の点を確かめる。
 * - 材料（テーマ・いまの論点と意見・救い出すコメントと返信先）が漏れなく指示に入ること
 * - 箇所 opinionSort（振り分けと同じ）を指名すること
 * - 返ってきた下書きが、札の種類・文字数・論点（既にある論点か、重ならない新しい論点。数の上限）に収まっていれば受け付け、
 *   外れたら切り詰めずに拒むこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeAi } from './fake-ai'
import { MAX_OPINION_LENGTH, MAX_TOPICS } from './opinion'
import { OpinionDraftContentError, buildOpinionDraftPrompt, draftOpinion, parseOpinionDraft, type DraftMaterial } from './opinion-draft'

const material: DraftMaterial = {
  theme: '配信中にAIをどこまで使っていい？',
  board: [{ id: 3, title: '視聴者との距離', opinions: [{ id: 10, kind: 'issue', text: 'AIが返事すると距離を感じる' }] }],
  comment: { userName: 'mugi', text: 'それより声が人っぽすぎると怖い', replyName: 'aoi', replyText: 'AIのコメ返しは寂しい' },
}

describe('buildOpinionDraftPrompt', () => {
  it('テーマ・論点・意見・コメントと返信先を入れる', () => {
    const prompt = buildOpinionDraftPrompt(material)

    expect(prompt).toContain('配信中にAIをどこまで使っていい？')
    expect(prompt).toContain('[T3] 視聴者との距離')
    expect(prompt).toContain('課題: AIが返事すると距離を感じる')
    expect(prompt).toContain('それより声が人っぽすぎると怖い')
    expect(prompt).toContain('aoiさんの「AIのコメ返しは寂しい」への返信')
    expect(prompt).toContain(`${MAX_OPINION_LENGTH}文字以内`)
  })
})

describe('parseOpinionDraft', () => {
  it('既にある論点に入れる下書きを受け付ける', () => {
    expect(parseOpinionDraft('{"topic":"T3","kind":"気づき","text":"人っぽすぎる声は怖い"}', material)).toEqual({
      kind: 'insight',
      text: '人っぽすぎる声は怖い',
      topic: { type: 'existing', id: 3 },
    })
  })

  it('コードブロックに包まれた、新しい論点に入れる下書きを受け付ける', () => {
    expect(parseOpinionDraft('```json\n{"newTopic":"声と人格","kind":"課題","text":"人っぽすぎる声は怖い"}\n```', material)).toEqual({
      kind: 'issue',
      text: '人っぽすぎる声は怖い',
      topic: { type: 'new', title: '声と人格' },
    })
  })

  it('JSON でない・知らない札の種類・上限を超える1文・知らない論点は拒む', () => {
    expect(() => parseOpinionDraft('下書きです', material)).toThrow(OpinionDraftContentError)
    expect(() => parseOpinionDraft('{"topic":"T3","kind":"賛成","text":"怖い"}', material)).toThrow(OpinionDraftContentError)
    expect(() => parseOpinionDraft(`{"topic":"T3","kind":"課題","text":"${'あ'.repeat(MAX_OPINION_LENGTH + 1)}"}`, material)).toThrow(
      `${MAX_OPINION_LENGTH}文字以内`,
    )
    expect(() => parseOpinionDraft('{"topic":"T9","kind":"課題","text":"怖い"}', material)).toThrow('見つかりません')
  })

  it('既にある名前の新しい論点・上限を超える新しい論点は拒む', () => {
    expect(() => parseOpinionDraft('{"newTopic":"視聴者との距離","kind":"課題","text":"怖い"}', material)).toThrow('既にあります')
    const full = { ...material, board: Array.from({ length: MAX_TOPICS }, (_, index) => ({ id: index + 1, title: `論点${index + 1}`, opinions: [] })) }
    expect(() => parseOpinionDraft('{"newTopic":"声と人格","kind":"課題","text":"怖い"}', full)).toThrow(`${MAX_TOPICS}つまで`)
  })
})

describe('draftOpinion', () => {
  it('箇所 opinionSort を指名して作らせ、照合した下書きを返す', async () => {
    const llm = createFakeAi({ response: '{"topic":"T3","kind":"気づき","text":"人っぽすぎる声は怖い"}' })

    expect(await draftOpinion(llm, material)).toEqual({ kind: 'insight', text: '人っぽすぎる声は怖い', topic: { type: 'existing', id: 3 } })
    expect(llm.calls.map(({ usage }) => usage)).toEqual(['opinionSort'])
  })

  it('LLM が失敗したら、そのまま投げる', async () => {
    await expect(draftOpinion(createFakeAi({ shouldFail: true }), material)).rejects.toThrow('無料枠')
  })
})
