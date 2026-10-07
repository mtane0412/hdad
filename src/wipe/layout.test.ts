/**
 * ワイプを置いたオーバーレイの見つけ方（layout.ts）のテスト
 *
 * ワイプはチャットを自分で読み上げるので、裏方の読み上げと同時に動くと同じ発言が二重に読まれる。
 * 裏方の読み上げはこれで構成を確かめ、ワイプがあれば読み上げを始めない。
 */
import { describe, expect, it } from 'vitest'
import type { Overlay, OverlayItem } from '../overlay/layout'
import { wipeOverlayNameOf } from './layout'

const fullRect = { x: 0, y: 0, width: 100, height: 100 }
const clock: OverlayItem = { kind: 'clock', id: 'analog', params: '', rect: fullRect }
const wipe: OverlayItem = { kind: 'wipe', id: '', params: '', rect: { x: 70, y: 3, width: 28, height: 30 } }

describe('wipeOverlayNameOf', () => {
  it('ワイプを置いたオーバーレイの名前を返す', () => {
    const overlays: Overlay[] = [
      { name: 'back', items: [clock] },
      { name: 'front', items: [clock, wipe] },
    ]

    expect(wipeOverlayNameOf(overlays)).toBe('front')
  })

  it('どこにもワイプが無ければ null を返す', () => {
    expect(wipeOverlayNameOf([{ name: 'back', items: [clock] }])).toBeNull()
  })
})
