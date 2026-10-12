/**
 * 合成オーバーレイの構成の読み取り（src/overlay/layout.ts）のテスト
 *
 * 確かめたいのは次の3点である。
 * - 自分のオーバーレイ（OBSのブラウザソース1つ）に積む素材だけを、保存された並びの順で取り出すこと
 * - 位置と大きさ（％）を、箱に当てるCSSの値へ直すこと
 * - 構成にどんなオーバーレイがあるかを取り出すこと（名前を間違えたときに知らせるため）
 * - 隠した素材を除くこと・押し出された構成で自分のオーバーレイの中身が変わったかを見分けること
 */
import { describe, expect, it } from 'vitest'
import { itemsInOverlay, overlayChanged, overlayNamesOf, rectStyle, shownItems, type Overlay, type OverlayItem } from './layout'

const wallpaper: OverlayItem = { kind: 'wallpaper', id: 'aurora', params: 'speed=2', rect: { x: 0, y: 0, width: 100, height: 100 } }
const chat: OverlayItem = { kind: 'chat', id: 'plain', params: 'max=10', rect: { x: 2, y: 40, width: 30, height: 58 } }
const clock: OverlayItem = { kind: 'clock', id: 'analog', params: '', rect: { x: 78, y: 70, width: 20, height: 26 } }

const back: Overlay = { name: 'back', items: [wallpaper] }
const front: Overlay = { name: 'front', items: [chat, clock] }

describe('itemsInOverlay', () => {
  it('そのオーバーレイの素材だけを、保存された並びの順で返す', () => {
    expect(itemsInOverlay([back, front], 'front')).toEqual([chat, clock])
  })

  it('その名前のオーバーレイが無ければ空になる（呼び出し側が、どんな名前があるかを知らせる）', () => {
    expect(itemsInOverlay([back], 'front')).toEqual([])
  })
})

describe('rectStyle', () => {
  it('位置と大きさを割合（％）のCSSの値にする', () => {
    expect(rectStyle(clock.rect)).toEqual({ left: '78%', top: '70%', width: '20%', height: '26%' })
  })

  it('小数もそのまま割合として渡す（オーバーレイの幅に対する比なので丸めない）', () => {
    expect(rectStyle({ x: 12.5, y: 0, width: 33.3, height: 100 })).toEqual({
      left: '12.5%',
      top: '0%',
      width: '33.3%',
      height: '100%',
    })
  })
})

describe('overlayNamesOf', () => {
  it('構成にあるオーバーレイの名前を、並んでいる順で返す', () => {
    expect(overlayNamesOf([back, front])).toEqual(['back', 'front'])
  })
})

describe('shownItems', () => {
  it('隠した素材を除き、残りを並びの順のまま返す', () => {
    expect(shownItems([wallpaper, { ...chat, hidden: true }, clock])).toEqual([wallpaper, clock])
  })
})

describe('overlayChanged', () => {
  it('自分のオーバーレイの素材が変わっていれば true（素材を隠した・表示した）', () => {
    const hiddenClock: Overlay = { name: 'front', items: [chat, { ...clock, hidden: true }] }

    expect(overlayChanged([back, front], [back, hiddenClock], 'front')).toBe(true)
  })

  it('ほかのオーバーレイだけが変わったなら false（読み込み直さない）', () => {
    const hiddenWallpaper: Overlay = { name: 'back', items: [{ ...wallpaper, hidden: true }] }

    expect(overlayChanged([back, front], [hiddenWallpaper, front], 'front')).toBe(false)
  })
})
