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
 * - 素材が動き続ける軽い失敗（読み出し・チャット）は箱を覆わない帯で出し、同じ出どころは最新の1件だけにし、
 *   読み出しの失敗は時間が経ったら消すこと（箱いっぱいの板で演出全体を隠さないため）
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOTICE_VISIBLE_MS, canvasPixels, clearError, showError } from './mount'

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

  describe('素材が動き続ける軽い失敗', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('素材を起動できない失敗は、いままでどおり箱いっぱいの板で出す', () => {
      const box = createBox()

      showError(new Error('背景「aurora」はレジストリに登録されていません'), '背景', box)

      expect(box.querySelector('.stage-error')?.classList.contains('stage-error-notice')).toBe(false)
    })

    it('読み出しとチャットの失敗は、箱を覆わない帯で出す', () => {
      const box = createBox()

      showError(new Error('効果音を鳴らせませんでした'), '市町村紹介', box, 'read')
      showError(new Error('チャンネル名を読めませんでした'), 'チャットボックス', box, 'chat')

      const panels = box.querySelectorAll('.stage-error')
      expect(panels).toHaveLength(2)
      for (const panel of panels) expect(panel.classList.contains('stage-error-notice')).toBe(true)
    })

    it('同じ出どころの失敗が続いたら、積み重ねずに最新の1件だけを出す', () => {
      const box = createBox()

      showError(new Error('効果音を鳴らせませんでした'), '市町村紹介', box, 'read')
      showError(new Error('代表画像を読み込めませんでした'), '市町村紹介', box, 'read')

      const panels = box.querySelectorAll('.stage-error')
      expect(panels).toHaveLength(1)
      expect(panels[0]?.textContent).toContain('代表画像を読み込めませんでした')
    })

    it('読み出しの失敗は、しばらく経ったら消す（一時的な失敗が次の演出まで残らないように）', () => {
      vi.useFakeTimers()
      const box = createBox()
      showError(new Error('配信のBGMを下げられませんでした'), 'ツイスター', box, 'read')

      // 消える直前までは出ている
      vi.advanceTimersByTime(NOTICE_VISIBLE_MS - 1)
      expect(box.querySelector('.stage-error')).not.toBeNull()

      vi.advanceTimersByTime(1)
      expect(box.querySelector('.stage-error')).toBeNull()
    })

    it('新しい失敗に置き換えたら、消すまでの時間は新しい失敗から数える', () => {
      vi.useFakeTimers()
      const box = createBox()
      showError(new Error('効果音を鳴らせませんでした'), '市町村紹介', box, 'read')
      vi.advanceTimersByTime(NOTICE_VISIBLE_MS - 1000)
      showError(new Error('代表画像を読み込めませんでした'), '市町村紹介', box, 'read')

      // 前の失敗が消えるはずだった時刻を過ぎても、新しい失敗は残っている
      vi.advanceTimersByTime(2000)
      expect(box.querySelector('.stage-error')?.textContent).toContain('代表画像を読み込めませんでした')
    })

    it('チャットの接続の失敗は、直るまで続くので時間が経っても消さない', () => {
      vi.useFakeTimers()
      const box = createBox()
      showError(new Error('チャンネル名を読めませんでした'), 'チャットボックス', box, 'chat')

      vi.advanceTimersByTime(NOTICE_VISIBLE_MS * 2)

      expect(box.querySelector('.stage-error')).not.toBeNull()
    })
  })
})
