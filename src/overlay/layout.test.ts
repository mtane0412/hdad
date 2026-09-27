/**
 * 合成オーバーレイの構成の読み取り（src/overlay/layout.ts）のテスト
 *
 * 確かめたいのは次の3点である。
 * - 自分の段のレイヤーだけを、保存された並びの順で取り出すこと（並びがそのまま重ねる順になる）
 * - 位置と大きさ（％）を、箱に当てるCSSの値へ直すこと
 * - 構成にどんな段があるかを重複なく取り出すこと（段の名前を間違えたときに知らせるため）
 */
import { describe, expect, it } from 'vitest'
import { groupsOf, layersInGroup, rectStyle, type OverlayLayer } from './layout'

const 壁紙: OverlayLayer = {
  kind: 'wallpaper',
  id: 'aurora',
  params: 'speed=2',
  group: 'back',
  rect: { x: 0, y: 0, width: 100, height: 100 },
}
const チャット: OverlayLayer = {
  kind: 'chat',
  id: 'plain',
  params: 'max=10',
  group: 'front',
  rect: { x: 2, y: 40, width: 30, height: 58 },
}
const 時計: OverlayLayer = {
  kind: 'clock',
  id: 'analog',
  params: '',
  group: 'front',
  rect: { x: 78, y: 70, width: 20, height: 26 },
}

describe('layersInGroup', () => {
  it('その段のレイヤーだけを、保存された並びの順で返す', () => {
    expect(layersInGroup([壁紙, チャット, 時計], 'front')).toEqual([チャット, 時計])
  })

  it('その段にレイヤーが1つも無ければ空になる', () => {
    expect(layersInGroup([壁紙], 'front')).toEqual([])
  })
})

describe('rectStyle', () => {
  it('位置と大きさを割合（％）のCSSの値にする', () => {
    expect(rectStyle(時計.rect)).toEqual({ left: '78%', top: '70%', width: '20%', height: '26%' })
  })

  it('小数もそのまま割合として渡す（段の幅に対する比なので丸めない）', () => {
    expect(rectStyle({ x: 12.5, y: 0, width: 33.3, height: 100 })).toEqual({
      left: '12.5%',
      top: '0%',
      width: '33.3%',
      height: '100%',
    })
  })
})

describe('groupsOf', () => {
  it('構成にある段の名前を、重複なく現れた順で返す', () => {
    expect(groupsOf([壁紙, チャット, 時計, { ...壁紙, group: 'back' }])).toEqual(['back', 'front'])
  })
})
