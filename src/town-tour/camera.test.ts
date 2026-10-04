/**
 * 市町村紹介のカメラ（camera.ts）のテスト
 *
 * ズームの進み具合（0 で日本全体、1 で市町村）から、地図のどこを中心にどれだけ拡大して映すかを決める。
 */
import { describe, expect, it } from 'vitest'
import { JAPAN_BOUNDS, MIN_TOWN_SPAN, TOWN_FRACTION, cameraAt } from './camera'
import type { Bounds } from './topo'

/** 1920×1080 の箱 */
const WIDTH = 1920
const HEIGHT = 1080

/** 幅1・高さ0.5の市町村（投影した座標で、中心は (100, -40)） */
const town: Bounds = { minX: 99.5, minY: -40.25, maxX: 100.5, maxY: -39.75 }

const centerOf = (bounds: Bounds): [number, number] => [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2]

describe('cameraAt', () => {
  it('ズームの始まりでは、日本全体が箱に収まるように映す', () => {
    const camera = cameraAt(0, town, WIDTH, HEIGHT)
    const japanWidth = JAPAN_BOUNDS.maxX - JAPAN_BOUNDS.minX
    const japanHeight = JAPAN_BOUNDS.maxY - JAPAN_BOUNDS.minY

    expect([camera.centerX, camera.centerY]).toEqual(centerOf(JAPAN_BOUNDS))
    expect(camera.scale).toBeCloseTo(Math.min(WIDTH / japanWidth, HEIGHT / japanHeight))
  })

  it('ズームの終わりでは、市町村が箱の決まった割合に収まるように、市町村の中心を映す', () => {
    const camera = cameraAt(1, town, WIDTH, HEIGHT)

    expect([camera.centerX, camera.centerY]).toEqual(centerOf(town))
    // 幅1・高さ0.5の市町村は、幅のほうが先に箱の割合いっぱいになる
    expect(camera.scale).toBeCloseTo(Math.min((WIDTH * TOWN_FRACTION) / 1, (HEIGHT * TOWN_FRACTION) / 0.5))
  })

  it('途中では、拡大率を始まりと終わりの間で掛け算でならす（ズームの速さが見た目で一定になる）', () => {
    const start = cameraAt(0, town, WIDTH, HEIGHT).scale
    const end = cameraAt(1, town, WIDTH, HEIGHT).scale

    expect(cameraAt(0.5, town, WIDTH, HEIGHT).scale).toBeCloseTo(Math.sqrt(start * end))
  })

  it('とても小さな市町村は、決まった広さより拡大しない（簡略化した形が角ばって見えるため）', () => {
    const tiny: Bounds = { minX: 100, minY: -40, maxX: 100.01, maxY: -39.99 }

    expect(cameraAt(1, tiny, WIDTH, HEIGHT).scale).toBeCloseTo((HEIGHT * TOWN_FRACTION) / MIN_TOWN_SPAN)
  })
})
