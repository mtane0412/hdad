/**
 * 合成オーバーレイの構成の読み取り（src/overlay/layout.ts）のテスト
 *
 * 確かめたいのは次の3点である。
 * - 自分のオーバーレイ（OBSのブラウザソース1つ）に積む素材だけを、保存された並びの順で取り出すこと
 * - 位置と大きさ（％）を、箱に当てるCSSの値へ直すこと
 * - 構成にどんなオーバーレイがあるかを取り出すこと（名前を間違えたときに知らせるため）
 */
import { describe, expect, it } from 'vitest'
import { itemsInOverlay, overlayNamesOf, rectStyle, type Overlay, type OverlayItem } from './layout'

const 壁紙: OverlayItem = { kind: 'wallpaper', id: 'aurora', params: 'speed=2', rect: { x: 0, y: 0, width: 100, height: 100 } }
const チャット: OverlayItem = { kind: 'chat', id: 'plain', params: 'max=10', rect: { x: 2, y: 40, width: 30, height: 58 } }
const 時計: OverlayItem = { kind: 'clock', id: 'analog', params: '', rect: { x: 78, y: 70, width: 20, height: 26 } }

const 背面: Overlay = { name: 'back', items: [壁紙] }
const 前面: Overlay = { name: 'front', items: [チャット, 時計] }

describe('itemsInOverlay', () => {
  it('そのオーバーレイの素材だけを、保存された並びの順で返す', () => {
    expect(itemsInOverlay([背面, 前面], 'front')).toEqual([チャット, 時計])
  })

  it('その名前のオーバーレイが無ければ空になる（呼び出し側が、どんな名前があるかを知らせる）', () => {
    expect(itemsInOverlay([背面], 'front')).toEqual([])
  })
})

describe('rectStyle', () => {
  it('位置と大きさを割合（％）のCSSの値にする', () => {
    expect(rectStyle(時計.rect)).toEqual({ left: '78%', top: '70%', width: '20%', height: '26%' })
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
    expect(overlayNamesOf([背面, 前面])).toEqual(['back', 'front'])
  })
})
