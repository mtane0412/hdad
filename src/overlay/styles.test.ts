/**
 * 合成オーバーレイのCSS（src/overlay/overlay.css）の整合性テスト
 *
 * 合成ページは重ねうる素材すべてのCSSを、1枚のページで読み込む必要がある。
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

  it('レジストリを持たない素材（アラート・サイドスーパー・注目コメント・手書き・再生中の曲・タブの映像・字幕・作業ログ・作業机・ポモドーロ・市町村紹介・ツイスター・ワイプ・テキスト・漢字クイズ・意見ボード・ペロペロ・VRM・チャットで推理）のCSSも読み込んでいる', () => {
    for (const path of ['../alerts/alerts.css', '../side-super/side-super.css', '../focus/focus.css', '../draw/draw.css', '../bgm/bgm.css', '../tab/tab.css', '../caption/caption.css', '../work-log/work-log.css', '../task-desk/task-desk.css', '../pomodoro/pomodoro.css', '../town-tour/town-tour.css', '../twister/twister.css', '../wipe/wipe.css', '../text/text.css', '../kanji-quiz/kanji-quiz.css', '../opinions/opinions.css', '../lick/lick.css', '../vrm/vrm.css', '../chat-deduction/chat-deduction.css']) {
      expect(overlayCss).toContain(`@import '${path}';`)
    }
  })

  it('直置きの文字の縁取り（src/core/text-outline.css）を、素材のCSSより先に読み込んでいる', () => {
    const outlineAt = overlayCss.indexOf(`@import '../core/text-outline.css';`)
    expect(outlineAt).toBeGreaterThanOrEqual(0)
    expect(outlineAt).toBeLessThan(overlayCss.indexOf(`@import '../chat/`))
  })

  it('配信の映像の上に地を持たずに文字を置く素材（チャットの plain・アラート・字幕）は、共通の縁取りを使う', () => {
    // 前提: 縁取りの作り方を素材ごとに書き分けると、太さも作り方もばらつく（8方向の影・text-stroke など）
    for (const path of ['../chat/plain.css', '../alerts/alerts.css', '../caption/caption.css']) {
      const css = readFileSync(resolve(import.meta.dirname, path), 'utf8')
      expect(css, path).toContain('var(--text-outline)')
      expect(css, path).not.toContain('-webkit-text-stroke')
    }
  })

  it('素材の箱は、中の素材と失敗の表示の基準になるよう位置を持つ', () => {
    expect(overlayCss).toMatch(/\.overlay-item \{[^}]*position: absolute;/)
  })
})
