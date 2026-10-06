/**
 * 市町村紹介の呼び出し（合成ページへ押し出す中身）の組み立てのテスト
 */
import { describe, expect, it } from 'vitest'
import towns from '../src/town-tour/towns.json'
import { pickTown, townTourCallOf } from './town-tour-call'
import { DEFAULT_TOWN_TOUR_SOUND, playbackSoundOf } from './town-tour-sound'

describe('pickTown', () => {
  /** まだ1つも紹介していない */
  const noVisits = new Set<string>()

  it('乱数が0なら一覧の先頭の市町村を引く', () => {
    expect(pickTown(() => 0, noVisits)).toEqual(towns[0])
  })

  it('乱数が1に近ければ一覧の末尾の市町村を引く（範囲の外へはみ出さない）', () => {
    expect(pickTown(() => 0.9999999, noVisits)).toEqual(towns[towns.length - 1])
  })

  it('紹介済みの市町村は除いて引く（一覧の先頭の札幌市を紹介済みなら、乱数が0でも次の市町村を引く）', () => {
    const [first, second] = towns
    if (first === undefined || second === undefined) throw new Error('一覧に2件以上が必要です')

    expect(pickTown(() => 0, new Set([first.code]))).toEqual(second)
  })

  it('すべて紹介済みなら、一覧の全体から引く（全国制覇の後も紹介は続ける）', () => {
    expect(pickTown(() => 0, new Set(towns.map(({ code }) => code)))).toEqual(towns[0])
  })
})

describe('townTourCallOf', () => {
  const town = { code: '13101', prefecture: '東京都', county: '', name: '千代田区' }
  const countyTown = { code: '01303', prefecture: '北海道', county: '石狩郡', name: '当別町' }
  /** BGM だけを選んだ音の設定 */
  const sound = playbackSoundOf({ ...DEFAULT_TOWN_TOUR_SOUND, slots: { ...DEFAULT_TOWN_TOUR_SOUND.slots, bgm: 'media-cookie' } }, 'overlay-key')

  it('レイドなら「○○さんのレイドを記念して」で始まる一文と、同梱した人口・面積と、同接にレイドの人数を足した人数を添える', () => {
    // 最後に記録した同接は20人、レイドは30人
    expect(townTourCallOf(town, { occasion: 'raid', userName: '山田花子', viewers: 30 }, sound, 20, 'quiz-1', [], false)).toEqual({
      code: '13101',
      prefecture: '東京都',
      county: '',
      name: '千代田区',
      headline: '山田花子さんのレイドを記念して、本日は東京都千代田区をご紹介します',
      quizId: 'quiz-1',
      quizHeadline: '山田花子さんのレイドを記念して、本日は千代田区をご紹介します',
      sound,
      population: 69139,
      area: 11.66,
      audience: { kind: 'raid', count: 50 },
      visited: [],
      visit: { occasion: 'raid', userName: '山田花子' },
      honoraryCitizen: '山田花子',
      narration: false,
    })
  })

  it('ナレーションを読み上げる設定なら、読み上げることを添える（合成ページが紹介の文の合成を頼むかを決める）', () => {
    expect(townTourCallOf(town, { occasion: 'demo' }, sound, null, 'quiz-1', [], true).narration).toBe(true)
  })

  it('名誉町民の認定証はレイドだけで出すので、キーワードでは名誉町民にする相手を持たない', () => {
    expect(townTourCallOf(countyTown, { occasion: 'keyword', userName: '田中太郎' }, sound, null, 'quiz-1', [], false).honoraryCitizen).toBeNull()
  })

  it('試し再生では、認定証の見た目を確かめられるよう、見本の名前を名誉町民にする相手にする', () => {
    expect(townTourCallOf(town, { occasion: 'demo' }, sound, null, 'quiz-1', [], false).honoraryCitizen).toBe('レイド元の配信者')
  })

  it('これまでに紹介した市町村のコードを、制覇マップの材料として添える', () => {
    expect(townTourCallOf(town, { occasion: 'demo' }, sound, null, 'quiz-1', ['01303', '34208'], false).visited).toEqual(['01303', '34208'])
  })

  it('キーワードなら、流しきったら記録するきっかけと相手を添える', () => {
    expect(townTourCallOf(countyTown, { occasion: 'keyword', userName: '田中太郎' }, sound, null, 'quiz-1', [], false).visit).toEqual({
      occasion: 'keyword',
      userName: '田中太郎',
    })
  })

  it('試し再生は記録しないので、記録するきっかけを持たない', () => {
    expect(townTourCallOf(town, { occasion: 'demo' }, sound, null, 'quiz-1', [], false).visit).toBeNull()
  })

  it('レイドで同接の記録が無ければ、レイドの人数だけを見ている人数にする', () => {
    expect(townTourCallOf(town, { occasion: 'raid', userName: '山田花子', viewers: 30 }, sound, null, 'quiz-1', [], false).audience).toEqual({
      kind: 'raid',
      count: 30,
    })
  })

  it('キーワードと試し再生では、最後に記録した同接を見ている人数にする', () => {
    expect(townTourCallOf(countyTown, { occasion: 'keyword', userName: '田中太郎' }, sound, 12, 'quiz-1', [], false).audience).toEqual({
      kind: 'live',
      count: 12,
    })
    expect(townTourCallOf(countyTown, { occasion: 'demo' }, sound, 12, 'quiz-1', [], false).audience).toEqual({ kind: 'live', count: 12 })
  })

  it('キーワードと試し再生で配信中でなければ（同接が null）、見ている人数を null にする', () => {
    expect(townTourCallOf(countyTown, { occasion: 'keyword', userName: '田中太郎' }, sound, null, 'quiz-1', [], false).audience).toBeNull()
    expect(townTourCallOf(countyTown, { occasion: 'demo' }, sound, null, 'quiz-1', [], false).audience).toBeNull()
  })

  it('人口の記録が無い北方領土の村は、人口を null のまま添える', () => {
    const shikotan = { code: '01695', prefecture: '北海道', county: '色丹郡', name: '色丹村' }

    expect(townTourCallOf(shikotan, { occasion: 'demo' }, sound, null, 'quiz-1', [], false)).toMatchObject({ population: null, area: 250.57 })
  })

  it('人口と面積の表に無いコードの市町村なら、黙って流さずに投げる', () => {
    const unknownTown = { code: '99999', prefecture: '架空県', county: '', name: '架空市' }

    expect(() => townTourCallOf(unknownTown, { occasion: 'demo' }, sound, null, 'quiz-1', [], false)).toThrow('99999')
  })

  it('キーワード（!darts など）なら、発言した人の投げたダーツに見立てた一文を添える', () => {
    expect(townTourCallOf(countyTown, { occasion: 'keyword', userName: '田中太郎' }, sound, null, 'quiz-1', [], false).headline).toBe(
      '田中太郎さんのダーツが刺さったのは、北海道石狩郡当別町でした',
    )
  })

  it('管理画面の試し再生なら、試しであることが分かる一文を添える', () => {
    expect(townTourCallOf(town, { occasion: 'demo' }, sound, null, 'quiz-1', [], false).headline).toBe('試し再生: 本日は東京都千代田区をご紹介します')
  })

  it('クイズのあいだに出す一文は、都道府県と郡を伏せて市町村の名前だけにする（答えが分からないように）', () => {
    expect(townTourCallOf(countyTown, { occasion: 'keyword', userName: '田中太郎' }, sound, null, 'quiz-1', [], false).quizHeadline).toBe(
      '田中太郎さんのダーツが刺さったのは、当別町でした',
    )
    expect(townTourCallOf(countyTown, { occasion: 'demo' }, sound, null, 'quiz-1', [], false).quizHeadline).toBe('試し再生: 本日は当別町をご紹介します')
  })
})
