/**
 * 人形の獲得の見た目（doll-award.css）のテスト
 *
 * 人形の獲得は、ほかの演出（漢字クイズの正解など）と重ならないよう、管理画面で素材の箱を小さくして隅に置けるようにする。
 * そのため、中身の大きさは配信画面ではなく素材の箱を基準に決めることを確かめる。
 * - 外枠が箱の大きさを測れる入れ物（container-type: size）であること
 * - 配信画面を基準にする単位（vw・vh・vmin・vmax）を使わないこと（使うと、箱を小さくしても中身が縮まない）
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(import.meta.dirname, 'doll-award.css'), 'utf8')
// 先頭の説明のコメントは単位の名前を書くことがあるので、コメントを除いて調べる
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('doll-award.css', () => {
  it('外枠は、素材の箱の大きさを測れる入れ物にする', () => {
    expect(rules).toMatch(/\.doll-awards \{[^}]*container-type: size;/)
  })

  it('配信画面を基準にする単位（vw・vh・vmin・vmax）を使わない', () => {
    expect(rules).not.toMatch(/\d(vw|vh|vmin|vmax)\b/)
  })
})
