/**
 * デジタル時計（digital.ts）のテスト
 *
 * 描画そのものではなく、表示する文字列と文字サイズを決める純粋関数を検証する。
 * 日時はすべて「配信PCのローカル時刻」として組み立てるため、テストの結果は実行環境のタイムゾーンに依存しない。
 */
import { describe, expect, it } from 'vitest'
import { fitFontSize, formatDateLine, formatTimeLine } from './digital'

/** 年月日と時分秒から、ローカル時刻の Date を作るテスト用ヘルパー（月は1始まり） */
const 日時 = (年: number, 月: number, 日: number, 時 = 0, 分 = 0, 秒 = 0): Date =>
  new Date(年, 月 - 1, 日, 時, 分, 秒)

describe('formatTimeLine', () => {
  it('24時間制では、時・分・秒を2桁にそろえてコロンで区切る', () => {
    const 夜の配信中 = 日時(2026, 9, 20, 21, 34, 8)
    expect(formatTimeLine(夜の配信中, { hour12: false, seconds: true })).toBe('21:34:08')
  })

  it('24時間制では、1桁の時も0で埋める（桁数が変わって表示幅が揺れないようにする）', () => {
    const 朝 = 日時(2026, 9, 20, 9, 5, 3)
    expect(formatTimeLine(朝, { hour12: false, seconds: true })).toBe('09:05:03')
  })

  it('秒を非表示にすると、時と分だけになる', () => {
    const 夜の配信中 = 日時(2026, 9, 20, 21, 34, 8)
    expect(formatTimeLine(夜の配信中, { hour12: false, seconds: false })).toBe('21:34')
  })

  it('12時間制では、午前は AM・午後は PM を先頭に付け、時は0で埋めない', () => {
    expect(formatTimeLine(日時(2026, 9, 20, 9, 5, 3), { hour12: true, seconds: true })).toBe('AM 9:05:03')
    expect(formatTimeLine(日時(2026, 9, 20, 21, 34, 8), { hour12: true, seconds: false })).toBe('PM 9:34')
  })

  it('12時間制では、深夜0時台は AM 12時・正午台は PM 12時と表示する（0時とは表示しない）', () => {
    expect(formatTimeLine(日時(2026, 9, 20, 0, 15), { hour12: true, seconds: false })).toBe('AM 12:15')
    expect(formatTimeLine(日時(2026, 9, 20, 12, 15), { hour12: true, seconds: false })).toBe('PM 12:15')
  })
})

describe('formatDateLine', () => {
  const 日曜日 = 日時(2026, 9, 20)

  it('日付と曜日の両方を表示すると「月/日 (曜)」になる', () => {
    expect(formatDateLine(日曜日, { date: true, weekday: true })).toBe('9/20 (日)')
  })

  it('日付だけ・曜日だけでも表示できる', () => {
    expect(formatDateLine(日曜日, { date: true, weekday: false })).toBe('9/20')
    expect(formatDateLine(日曜日, { date: false, weekday: true })).toBe('(日)')
  })

  it('どちらも非表示なら空文字になる（日付の行そのものを描かない合図）', () => {
    expect(formatDateLine(日曜日, { date: false, weekday: false })).toBe('')
  })

  it('月曜から日曜まで、曜日を漢字1文字で表示する', () => {
    // 前提: 2026年9月21日は月曜日。そこから7日間を順に確認する
    const 曜日の並び = [21, 22, 23, 24, 25, 26, 27].map((日) =>
      formatDateLine(日時(2026, 9, 日), { date: false, weekday: true }),
    )
    expect(曜日の並び).toEqual(['(月)', '(火)', '(水)', '(木)', '(金)', '(土)', '(日)'])
  })
})

describe('fitFontSize', () => {
  // 前提: 文字サイズ1pxあたり、幅5px・高さ2pxを占める内容（横長の時計表示を想定）
  const 内容の大きさ = { width: 5, height: 2 }

  it('横に余裕がある領域では、高さいっぱいに収まる文字サイズになる', () => {
    expect(fitFontSize({ width: 2000, height: 200 }, 内容の大きさ, 1)).toBe(100)
  })

  it('縦に余裕がある領域では、幅いっぱいに収まる文字サイズになる', () => {
    expect(fitFontSize({ width: 500, height: 1000 }, 内容の大きさ, 1)).toBe(100)
  })

  it('倍率を指定すると、収まる最大サイズに対してその割合まで小さくなる', () => {
    expect(fitFontSize({ width: 2000, height: 200 }, 内容の大きさ, 0.5)).toBe(50)
  })

  it('どんな領域でも、内容が領域からはみ出さない', () => {
    for (let width = 50; width <= 2000; width += 150) {
      for (let height = 50; height <= 1200; height += 115) {
        const size = fitFontSize({ width, height }, 内容の大きさ, 1)
        expect(size * 内容の大きさ.width).toBeLessThanOrEqual(width + 1e-9)
        expect(size * 内容の大きさ.height).toBeLessThanOrEqual(height + 1e-9)
      }
    }
  })
})
