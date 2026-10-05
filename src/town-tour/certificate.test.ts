/**
 * 名誉町民の認定証の文面（certificate.ts）のテスト
 *
 * 認定証はレイドで紹介した締めに出し、レイド元をその市町村の名誉町民に任命する（issue #253）。
 * 文面はコードで組み立て、LLM に作らせない。町の公式なものと誤解されないよう、発行者はこの配信（HDAD 市町村紹介）にする。
 */
import { describe, expect, it } from 'vitest'
import { certificateOf } from './certificate'

/** 2026年10月5日 20時（日本時間）。令和8年 */
const ISSUED_AT = Date.parse('2026-10-05T20:00:00+09:00')

describe('certificateOf', () => {
  it('名誉町民にする相手の名前と、都道府県・郡から書いた市町村と、和暦の日付を入れた文面にする', () => {
    const tobetsu = { prefecture: '北海道', county: '石狩郡', name: '当別町', honoraryCitizen: '山田花子' }

    expect(certificateOf(tobetsu, ISSUED_AT)).toEqual({
      title: '名誉町民証',
      holder: '山田花子 様',
      appointment: 'あなたを北海道石狩郡当別町の名誉町民に任命します',
      date: '令和8年10月5日',
      issuer: 'HDAD 市町村紹介',
    })
  })

  it('市・村・区では、名誉市民・名誉村民・名誉区民にする（市町村の名前の最後の字に合わせる）', () => {
    const titleOf = (name: string) => certificateOf({ prefecture: '東京都', county: '', name, honoraryCitizen: '山田花子' }, ISSUED_AT)?.title

    expect(titleOf('八王子市')).toBe('名誉市民証')
    expect(titleOf('檜原村')).toBe('名誉村民証')
    expect(titleOf('千代田区')).toBe('名誉区民証')
  })

  it('日付は日本時間で数える（日本時間で日付が変わった直後は、もう翌日の日付にする）', () => {
    const justAfterMidnight = Date.parse('2026-10-06T00:05:00+09:00')

    expect(certificateOf({ prefecture: '北海道', county: '石狩郡', name: '当別町', honoraryCitizen: '山田花子' }, justAfterMidnight)?.date).toBe(
      '令和8年10月6日',
    )
  })

  it('名誉町民にする相手がいない呼び出し（キーワード）では、認定証を出さないので null を返す', () => {
    expect(certificateOf({ prefecture: '北海道', county: '石狩郡', name: '当別町', honoraryCitizen: null }, ISSUED_AT)).toBeNull()
  })
})
