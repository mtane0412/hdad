/**
 * 市町村の紹介づくり（town-tour.ts）のテスト
 *
 * LLM の文面そのものは確かめられないので、次の点を確かめる。
 * - buildTownTourPrompt: 市町村の名前と、Wikipedia から拾った材料が漏れなく入り、材料が無い系統はその旨を伝えること
 * - parseTownTour: LLM の応答（JSON）を大見出し・項目・振りとして読み、形が違う・長すぎる・項目の数が合わない応答はエラーにすること
 * - generateTownTour: 「市町村紹介」の箇所を指名して LLM を呼ぶこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeAi } from './fake-ai'
import {
  MAX_CUE_LENGTH,
  MAX_HOOK_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_POINTS,
  MAX_POINT_LENGTH,
  TownTourContentError,
  buildTownTourPrompt,
  generateTownTour,
  parseTownTour,
  type TownTourInput,
} from './town-tour'

/** 檜枝岐村の記事から拾った材料（縮めたもの）。名前の由来の節は記事に無い */
const hinoemataInput: TownTourInput = {
  prefecture: '福島県',
  county: '南会津郡',
  name: '檜枝岐村',
  material: {
    lead: '檜枝岐村（ひのえまたむら）は、福島県会津地方南西部（奥会津）に位置し、南会津郡に属する村。平家の落人伝説が残る。',
    geography: '会津駒ケ岳と燧ケ岳、帝釈山に囲まれた標高920 - 1000 mの地帯。',
    origin: '',
    history: '1889年（明治22年）4月1日 - 町村制施行により、檜枝岐村が単独で村制度施行。',
    specialty: '山人（やもーど）料理 - 山菜やキノコ、イワナ、サンショウウオなどを使った料理。',
    topics: '尾瀬\n桧枝岐温泉',
  },
}

/** LLM が返す、正しい形の紹介 */
const validResponse = {
  hook: 'サンショウウオを食べる村',
  points: [
    { label: 'どこにある？', text: '福島県の南西の端、尾瀬の入口にある山あいの村です。' },
    { label: '名物', text: 'イワナやサンショウウオまで使う「山人料理」が名物です。' },
    { label: '伝説', text: '平家の落人が隠れ住んだという伝説が残っています。' },
  ],
  cue: 'サンショウウオ、食べてみたいですか？',
}

describe('buildTownTourPrompt', () => {
  it('市町村の名前と、拾った材料がすべて入る', () => {
    const prompt = buildTownTourPrompt(hinoemataInput)

    expect(prompt).toContain('福島県南会津郡檜枝岐村')
    for (const text of Object.values(hinoemataInput.material).filter((value) => value !== '')) expect(prompt).toContain(text)
  })

  it('材料が無い系統は、無いことを伝える', () => {
    const prompt = buildTownTourPrompt(hinoemataInput)

    expect(prompt).toMatch(/# 名前の由来について書かれた節\n（記事にありません）/)
  })

  it('郡に属さない市は、都道府県と名前だけで呼ぶ', () => {
    expect(buildTownTourPrompt({ ...hinoemataInput, prefecture: '広島県', county: '', name: '府中市' })).toContain('広島県府中市')
  })
})

describe('parseTownTour', () => {
  it('JSON の応答を、大見出し・項目・振りとして読む', () => {
    expect(parseTownTour(JSON.stringify(validResponse))).toEqual(validResponse)
  })

  it('コードブロックで囲まれた JSON も読む', () => {
    expect(parseTownTour(`\`\`\`json\n${JSON.stringify(validResponse)}\n\`\`\``)).toEqual(validResponse)
  })

  it('前後の空白は落とす', () => {
    const padded = { ...validResponse, hook: ' サンショウウオを食べる村 ', points: [{ label: ' 名物 ', text: '  山人料理が名物です。 ' }] }

    expect(parseTownTour(JSON.stringify(padded))).toEqual({ ...validResponse, points: [{ label: '名物', text: '山人料理が名物です。' }] })
  })

  it('大見出しが空の紹介は、大見出しなしとして読む（材料が薄い町）', () => {
    expect(parseTownTour(JSON.stringify({ ...validResponse, hook: '' })).hook).toBe('')
  })

  it('JSON でなければエラーにする', () => {
    expect(() => parseTownTour('檜枝岐村は福島県の村です。')).toThrow(TownTourContentError)
  })

  it('大見出し・項目・振りが欠けている・文字列でなければエラーにする', () => {
    // 前提: 振り（cue）そのものが無い応答
    const withoutCue = Object.fromEntries(Object.entries(validResponse).filter(([key]) => key !== 'cue'))
    expect(() => parseTownTour(JSON.stringify(withoutCue))).toThrow(TownTourContentError)
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, hook: null }))).toThrow(TownTourContentError)
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, points: '山人料理が名物です。' }))).toThrow(TownTourContentError)
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, points: [{ label: '名物' }] }))).toThrow(TownTourContentError)
  })

  it('項目の見出しか文が空ならエラーにする', () => {
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, points: [{ label: '', text: '山人料理が名物です。' }] }))).toThrow(TownTourContentError)
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, points: [{ label: '名物', text: '' }] }))).toThrow(TownTourContentError)
  })

  it('振りが空ならエラーにする', () => {
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, cue: '' }))).toThrow(TownTourContentError)
  })

  it('項目が1つも無い・上限より多ければエラーにする', () => {
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, points: [] }))).toThrow(TownTourContentError)
    const tooMany = Array.from({ length: MAX_POINTS + 1 }, () => validResponse.points[0])
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, points: tooMany }))).toThrow(TownTourContentError)
  })

  it('上限より長い大見出し・見出し・文・振りがあればエラーにする', () => {
    const point = validResponse.points[0]
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, hook: 'あ'.repeat(MAX_HOOK_LENGTH + 1) }))).toThrow(TownTourContentError)
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, points: [{ ...point, label: 'あ'.repeat(MAX_LABEL_LENGTH + 1) }] }))).toThrow(TownTourContentError)
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, points: [{ ...point, text: 'あ'.repeat(MAX_POINT_LENGTH + 1) }] }))).toThrow(TownTourContentError)
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, cue: 'あ'.repeat(MAX_CUE_LENGTH + 1) }))).toThrow(TownTourContentError)
  })
})

describe('generateTownTour', () => {
  it('市町村紹介の箇所を指名して呼び、紹介を返す', async () => {
    const ai = createFakeAi({ response: JSON.stringify(validResponse) })

    expect(await generateTownTour(ai, hinoemataInput)).toEqual(validResponse)
    expect(ai.calls.map((call) => call.usage)).toEqual(['townTour'])
    expect(ai.calls[0]?.request.messages.at(-1)?.content).toBe(buildTownTourPrompt(hinoemataInput))
  })
})
