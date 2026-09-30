// @vitest-environment jsdom
/**
 * 素材の起動処理（src/core/mount.ts）のうち、canvas の描画を伴わない部分のテスト
 *
 * 確かめたいのは次の2点である。
 * - canvas の解像度は「箱のCSS上の大きさ × 画素比」で決まる。レイヤーの箱は割合（％）で大きさが
 *   決まるため、端数や、まだ大きさが測れていない（0）場合の扱いを確かめる
 * - 失敗の表示は置かれた箱の中だけに出し、直ったら消せること（合成ページでは同じレイヤーを
 *   定期的に読み直すので、消せないと一度の失敗が配信中ずっと残ってしまう）
 * - 消すのは同じ出どころの表示だけであること（1つの箱には、読み出しの失敗とチャットの接続の失敗が
 *   同時に出うる。読み出しが直ったからといって、まだ直っていないチャットの表示まで消してはいけない）
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
  const createBox = (): HTMLElement => {
    const box = document.createElement('div')
    document.body.append(box)
    return box
  }

  it('失敗の理由を、渡した箱の中だけに出す', () => {
    const box = createBox()

    showError(new Error('背景「aurora」はレジストリに登録されていません'), '背景', box)

    const panel = box.querySelector('.stage-error')
    expect(panel?.textContent).toContain('背景「aurora」はレジストリに登録されていません')
    expect(panel?.getAttribute('role')).toBe('alert')
  })

  it('直ったら、同じ出どころの表示を消せる（読み直しが成功したときに使う）', () => {
    const box = createBox()
    showError(new Error('読み込めませんでした'), 'サイドスーパー', box, 'read')

    clearError(box, 'read')

    expect(box.querySelector('.stage-error')).toBeNull()
  })

  it('出どころが違う表示は消さない（読み出しが直っても、チャットの接続の失敗は残す）', () => {
    const box = createBox()
    showError(new Error('読み込めませんでした'), '注目コメント', box, 'read')
    showError(new Error('Workerの応答に login がありません'), 'チャットボックス', box, 'chat')

    clearError(box, 'read')

    const remaining = box.querySelectorAll('.stage-error')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.textContent).toContain('login がありません')
  })

  it('表示が出ていない箱に対しても、何も壊さない', () => {
    const box = createBox()

    expect(() => clearError(box, 'read')).not.toThrow()
  })

  it('ほかの箱に出ている表示は消さない（レイヤーごとに独立して扱う）', () => {
    const recoverableBox = createBox()
    const brokenBox = createBox()
    showError(new Error('読み込めませんでした'), 'サイドスーパー', recoverableBox, 'read')
    showError(new Error('キーが違います'), '注目コメント', brokenBox, 'read')

    clearError(recoverableBox, 'read')

    expect(brokenBox.querySelector('.stage-error')).not.toBeNull()
  })
})
