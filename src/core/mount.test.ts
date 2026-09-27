// @vitest-environment jsdom
/**
 * 素材の起動処理（src/core/mount.ts）のうち、canvas の描画を伴わない部分のテスト
 *
 * 確かめたいのは次の2点である。
 * - canvas の解像度は「箱のCSS上の大きさ × 画素比」で決まる。レイヤーの箱は割合（％）で大きさが
 *   決まるため、端数や、まだ大きさが測れていない（0）場合の扱いを確かめる
 * - 失敗の表示は置かれた箱の中だけに出し、直ったら消せること（合成ページでは同じレイヤーを
 *   定期的に読み直すので、消せないと一度の失敗が配信中ずっと残ってしまう）
 */
import { describe, expect, it } from 'vitest'
import { canvasPixels, clearError, showError } from './mount'

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

describe('showError・clearError', () => {
  /** レイヤーの箱に見立てた要素 */
  const 箱を作る = (): HTMLElement => {
    const box = document.createElement('div')
    document.body.append(box)
    return box
  }

  it('失敗の理由を、渡した箱の中だけに出す', () => {
    const box = 箱を作る()

    showError(new Error('背景「aurora」はレジストリに登録されていません'), '背景', box)

    const panel = box.querySelector('.stage-error')
    expect(panel?.textContent).toContain('背景「aurora」はレジストリに登録されていません')
    expect(panel?.getAttribute('role')).toBe('alert')
  })

  it('直ったら箱の中の表示を消せる（読み直しが成功したときに使う）', () => {
    const box = 箱を作る()
    showError(new Error('読み込めませんでした'), 'サイドスーパー', box)

    clearError(box)

    expect(box.querySelector('.stage-error')).toBeNull()
  })

  it('表示が出ていない箱に対しても、何も壊さない', () => {
    const box = 箱を作る()

    expect(() => clearError(box)).not.toThrow()
  })

  it('ほかの箱に出ている表示は消さない（レイヤーごとに独立して扱う）', () => {
    const 直る箱 = 箱を作る()
    const 壊れたままの箱 = 箱を作る()
    showError(new Error('読み込めませんでした'), 'サイドスーパー', 直る箱)
    showError(new Error('キーが違います'), '注目コメント', 壊れたままの箱)

    clearError(直る箱)

    expect(壊れたままの箱.querySelector('.stage-error')).not.toBeNull()
  })
})
