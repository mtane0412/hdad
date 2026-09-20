/**
 * アナログ時計（analog.ts）のテスト
 *
 * 描画そのものではなく、針の角度と文字盤上の位置を決める純粋関数を検証する。
 * 角度はすべて「12時の向きを0として、時計回りに何ラジアン回ったか」で表す。
 * 日時はすべて「配信PCのローカル時刻」として組み立てるため、テストの結果は実行環境のタイムゾーンに依存しない。
 */
import { describe, expect, it } from 'vitest'
import { handAngles, pointOnDial } from './analog'

/** 時分秒とミリ秒から、ローカル時刻の Date を作るテスト用ヘルパー（日付は2026年9月20日で固定） */
const 時刻 = (時: number, 分 = 0, 秒 = 0, ミリ秒 = 0): Date => new Date(2026, 8, 20, 時, 分, 秒, ミリ秒)

/** 1周（360度）のラジアン */
const 一周 = Math.PI * 2

describe('handAngles', () => {
  it('0時ちょうどは、すべての針が12時の向き（角度0）を指す', () => {
    const 角度 = handAngles(時刻(0, 0, 0), { smooth: false })
    expect(角度.hour).toBeCloseTo(0)
    expect(角度.minute).toBeCloseTo(0)
    expect(角度.second).toBeCloseTo(0)
  })

  it('3時ちょうどは、短針が3時の向き（4分の1周）を指す', () => {
    expect(handAngles(時刻(3, 0, 0), { smooth: false }).hour).toBeCloseTo(一周 / 4)
  })

  it('午後の時刻は、12時間前の午前と同じ向きを指す（15時は3時と同じ）', () => {
    expect(handAngles(時刻(15, 0, 0), { smooth: false }).hour).toBeCloseTo(一周 / 4)
  })

  it('短針は分の経過に合わせて少しずつ進む（3時30分は3時と4時のちょうど中間）', () => {
    const 三時 = 一周 / 4
    const 一時間ぶん = 一周 / 12
    expect(handAngles(時刻(3, 30, 0), { smooth: false }).hour).toBeCloseTo(三時 + 一時間ぶん / 2)
  })

  it('長針は秒の経過に合わせて少しずつ進む（15分30秒は15分と16分のちょうど中間）', () => {
    const 十五分 = 一周 / 4
    const 一分ぶん = 一周 / 60
    expect(handAngles(時刻(10, 15, 30), { smooth: false }).minute).toBeCloseTo(十五分 + 一分ぶん / 2)
  })

  it('秒針は30秒で半周する', () => {
    expect(handAngles(時刻(10, 15, 30), { smooth: false }).second).toBeCloseTo(一周 / 2)
  })

  it('smooth が無効なら、秒針は1秒ごとに刻んで動く（ミリ秒は無視する）', () => {
    const 三十秒ちょうど = handAngles(時刻(10, 15, 30, 0), { smooth: false }).second
    const 三十秒と半分 = handAngles(時刻(10, 15, 30, 500), { smooth: false }).second
    expect(三十秒と半分).toBeCloseTo(三十秒ちょうど)
  })

  it('smooth が有効なら、秒針はミリ秒まで使ってなめらかに進む（30.5秒は30秒と31秒のちょうど中間）', () => {
    const 一秒ぶん = 一周 / 60
    expect(handAngles(時刻(10, 15, 30, 500), { smooth: true }).second).toBeCloseTo(一周 / 2 + 一秒ぶん / 2)
  })

  it('どの時刻でも、角度は0以上1周未満に収まる', () => {
    for (const 日時 of [時刻(0, 0, 0), 時刻(11, 59, 59, 999), 時刻(12, 0, 0), 時刻(23, 59, 59, 999)]) {
      for (const 角度 of Object.values(handAngles(日時, { smooth: true }))) {
        expect(角度).toBeGreaterThanOrEqual(0)
        expect(角度).toBeLessThan(一周)
      }
    }
  })
})

describe('pointOnDial', () => {
  // 前提: 中心が (100, 100) の文字盤で、中心から50px離れた位置を求める
  const 中心 = { x: 100, y: 100 }
  const 距離 = 50

  it('角度0は、中心の真上（12時の位置）になる', () => {
    const 位置 = pointOnDial(中心, 距離, 0)
    expect(位置.x).toBeCloseTo(100)
    expect(位置.y).toBeCloseTo(50)
  })

  it('4分の1周は、中心の真右（3時の位置）になる', () => {
    const 位置 = pointOnDial(中心, 距離, 一周 / 4)
    expect(位置.x).toBeCloseTo(150)
    expect(位置.y).toBeCloseTo(100)
  })

  it('半周は、中心の真下（6時の位置）になる', () => {
    const 位置 = pointOnDial(中心, 距離, 一周 / 2)
    expect(位置.x).toBeCloseTo(100)
    expect(位置.y).toBeCloseTo(150)
  })

  it('距離に負の値を渡すと、中心をはさんだ反対側になる（針の尻尾を描くのに使う）', () => {
    const 位置 = pointOnDial(中心, -距離, 0)
    expect(位置.x).toBeCloseTo(100)
    expect(位置.y).toBeCloseTo(150)
  })
})
