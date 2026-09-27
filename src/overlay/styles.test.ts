/**
 * 合成オーバーレイのCSS（src/overlay/overlay.css）の整合性テスト
 *
 * 合成ページは素材ごとのページと違い、重ねうる素材すべてのCSSを1枚のページで読み込む必要がある。
 * 読み込みを忘れると、その素材だけが見た目を失ったまま配信画面に出てしまい、配信中に気付きにくい。
 * そのため、チャットボックスのデザインが増えたときに取りこぼしを検出できるようにする。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chats } from '../chat/registry'

const overlayCss = readFileSync(resolve(import.meta.dirname, 'overlay.css'), 'utf8')

describe('overlay.css', () => {
  it('チャットボックスのデザインのCSSをすべて読み込んでいる', () => {
    for (const chat of chats) {
      expect(overlayCss).toContain(`@import '../chat/${chat.id}.css';`)
    }
  })

  it('canvas を使わない素材（アラート・サイドスーパー・注目コメント）のCSSも読み込んでいる', () => {
    for (const path of ['../alerts/alerts.css', '../side-super/side-super.css', '../focus/focus.css']) {
      expect(overlayCss).toContain(`@import '${path}';`)
    }
  })

  it('素材の箱は、中の素材と失敗の表示の基準になるよう位置を持つ', () => {
    expect(overlayCss).toMatch(/\.overlay-item \{[^}]*position: absolute;/)
  })
})
