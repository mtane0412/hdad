/**
 * 市町村の紹介づくり（town-tour.ts）のテスト
 *
 * LLM の文面そのものは確かめられないので、次の点を確かめる。
 * - buildTownTourPrompt: 市町村の名前と、Wikipedia から拾った材料が漏れなく入り、材料が無い系統はその旨を伝えること
 * - parseTownTour: LLM の応答（JSON）を項目ごとに読み、形が違う・長すぎる・全部が空の応答はエラーにすること
 * - generateTownTour: 「市町村紹介」の箇所を指名して LLM を呼ぶこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeAi } from './fake-ai'
import { MAX_ITEM_LENGTH, TownTourContentError, buildTownTourPrompt, generateTownTour, parseTownTour, type TownTourInput } from './town-tour'

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
  location: '福島県の南西の端、尾瀬の入口にある山あいの村です。',
  nameOrigin: '',
  history: '平家の落人が隠れ住んだという伝説が残っています。',
  specialty: 'サンショウウオまで使う「山人料理」が名物です。',
  surprise: '村の面積の約98%が林野です。',
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
  it('JSON の応答を項目ごとに読む', () => {
    expect(parseTownTour(JSON.stringify(validResponse))).toEqual(validResponse)
  })

  it('コードブロックで囲まれた JSON も読む', () => {
    expect(parseTownTour(`\`\`\`json\n${JSON.stringify(validResponse)}\n\`\`\``)).toEqual(validResponse)
  })

  it('前後の空白は落とす', () => {
    expect(parseTownTour(JSON.stringify({ ...validResponse, history: '  平家の落人伝説が残っています。 ' })).history).toBe('平家の落人伝説が残っています。')
  })

  it('JSON でなければエラーにする', () => {
    expect(() => parseTownTour('檜枝岐村は福島県の村です。')).toThrow(TownTourContentError)
  })

  it('項目が欠けている・文字列でなければエラーにする', () => {
    // 前提: 意外な一面（surprise）の項目そのものが無い応答
    const withoutSurprise = Object.fromEntries(Object.entries(validResponse).filter(([item]) => item !== 'surprise'))
    expect(() => parseTownTour(JSON.stringify(withoutSurprise))).toThrow(TownTourContentError)
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, history: null }))).toThrow(TownTourContentError)
  })

  it('上限より長い項目があればエラーにする', () => {
    expect(() => parseTownTour(JSON.stringify({ ...validResponse, history: 'あ'.repeat(MAX_ITEM_LENGTH + 1) }))).toThrow(TownTourContentError)
  })

  it('すべての項目が空ならエラーにする', () => {
    const empty = { location: '', nameOrigin: '', history: '', specialty: '', surprise: '' }
    expect(() => parseTownTour(JSON.stringify(empty))).toThrow(TownTourContentError)
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
