/**
 * 素材の起動処理（src/core/mount.ts）のうち、DOMを持ち込まない部分のテスト
 *
 * canvas の解像度は「箱のCSS上の大きさ × 画素比」で決まる。レイヤーの箱は割合（％）で大きさが決まるため、
 * 端数や、まだ大きさが測れていない（0）場合の扱いをここで確かめる。
 */
import { describe, expect, it } from 'vitest'
import { canvasPixels } from './mount'

describe('canvasPixels', () => {
  it('箱の大きさに画素比をかけた画素数にする', () => {
    expect(canvasPixels(1920, 2)).toBe(3840)
  })

  it('端数は四捨五入する（canvas の解像度は整数でしか持てない）', () => {
    expect(canvasPixels(100, 1.5)).toBe(150)
    expect(canvasPixels(33.3, 1)).toBe(33)
  })

  it('まだ大きさが測れていなくても1画素は確保する（canvas は0を受け取らない）', () => {
    expect(canvasPixels(0, 2)).toBe(1)
  })
})
