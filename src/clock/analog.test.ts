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
const time = (hours: number, minutes = 0, seconds = 0, milliseconds = 0): Date => new Date(2026, 8, 20, hours, minutes, seconds, milliseconds)

/** 1周（360度）のラジアン */
const fullTurn = Math.PI * 2

describe('handAngles', () => {
  it('0時ちょうどは、すべての針が12時の向き（角度0）を指す', () => {
    const angle = handAngles(time(0, 0, 0), { smooth: false })
    expect(angle.hour).toBeCloseTo(0)
    expect(angle.minute).toBeCloseTo(0)
    expect(angle.second).toBeCloseTo(0)
  })

  it('3時ちょうどは、短針が3時の向き（4分の1周）を指す', () => {
    expect(handAngles(time(3, 0, 0), { smooth: false }).hour).toBeCloseTo(fullTurn / 4)
  })

  it('午後の時刻は、12時間前の午前と同じ向きを指す（15時は3時と同じ）', () => {
    expect(handAngles(time(15, 0, 0), { smooth: false }).hour).toBeCloseTo(fullTurn / 4)
  })

  it('短針は分の経過に合わせて少しずつ進む（3時30分は3時と4時のちょうど中間）', () => {
    const threeOClock = fullTurn / 4
    const oneHourWorth = fullTurn / 12
    expect(handAngles(time(3, 30, 0), { smooth: false }).hour).toBeCloseTo(threeOClock + oneHourWorth / 2)
  })

  it('長針は秒の経過に合わせて少しずつ進む（15分30秒は15分と16分のちょうど中間）', () => {
    const fifteenMinutes = fullTurn / 4
    const oneMinuteWorth = fullTurn / 60
    expect(handAngles(time(10, 15, 30), { smooth: false }).minute).toBeCloseTo(fifteenMinutes + oneMinuteWorth / 2)
  })

  it('秒針は30秒で半周する', () => {
    expect(handAngles(time(10, 15, 30), { smooth: false }).second).toBeCloseTo(fullTurn / 2)
  })

  it('smooth が無効なら、秒針は1秒ごとに刻んで動く（ミリ秒は無視する）', () => {
    const exactlyThirtySeconds = handAngles(time(10, 15, 30, 0), { smooth: false }).second
    const thirtyAndHalfSeconds = handAngles(time(10, 15, 30, 500), { smooth: false }).second
    expect(thirtyAndHalfSeconds).toBeCloseTo(exactlyThirtySeconds)
  })

  it('smooth が有効なら、秒針はミリ秒まで使ってなめらかに進む（30.5秒は30秒と31秒のちょうど中間）', () => {
    const oneSecondWorth = fullTurn / 60
    expect(handAngles(time(10, 15, 30, 500), { smooth: true }).second).toBeCloseTo(fullTurn / 2 + oneSecondWorth / 2)
  })

  it('どの時刻でも、角度は0以上1周未満に収まる', () => {
    for (const dateTime of [time(0, 0, 0), time(11, 59, 59, 999), time(12, 0, 0), time(23, 59, 59, 999)]) {
      for (const angle of Object.values(handAngles(dateTime, { smooth: true }))) {
        expect(angle).toBeGreaterThanOrEqual(0)
        expect(angle).toBeLessThan(fullTurn)
      }
    }
  })
})

describe('pointOnDial', () => {
  // 前提: 中心が (100, 100) の文字盤で、中心から50px離れた位置を求める
  const center = { x: 100, y: 100 }
  const distance = 50

  it('角度0は、中心の真上（12時の位置）になる', () => {
    const position = pointOnDial(center, distance, 0)
    expect(position.x).toBeCloseTo(100)
    expect(position.y).toBeCloseTo(50)
  })

  it('4分の1周は、中心の真右（3時の位置）になる', () => {
    const position = pointOnDial(center, distance, fullTurn / 4)
    expect(position.x).toBeCloseTo(150)
    expect(position.y).toBeCloseTo(100)
  })

  it('半周は、中心の真下（6時の位置）になる', () => {
    const position = pointOnDial(center, distance, fullTurn / 2)
    expect(position.x).toBeCloseTo(100)
    expect(position.y).toBeCloseTo(150)
  })

  it('距離に負の値を渡すと、中心をはさんだ反対側になる（針の尻尾を描くのに使う）', () => {
    const position = pointOnDial(center, -distance, 0)
    expect(position.x).toBeCloseTo(100)
    expect(position.y).toBeCloseTo(150)
  })
})
