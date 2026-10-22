/**
 * 人形の組と増減の形と検証（doll.ts）のテスト
 *
 * 次の点を確かめる。
 * - ふつうの人形とスーパー人形の名前と画像（素材のID）を受け取り、名前の前後の空白を落とすこと
 * - 名前が空・長すぎる、画像が無い・画像でない素材を指す、をすべて集めて拒むこと（最初の1件で止めない）
 * - 手での増減は、種類（ふつう／スーパー）と0でない整数の増減だけを受け取ること
 * - ゲームの正解者に渡す人形は、ふつう／スーパー／なし（null）のどれかだけを受け取ること
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, type MediaKind } from './alert-config'
import { SUPER_DOLL_VALUE as SCREEN_SUPER_DOLL_VALUE } from '../src/dolls/doll'
import { MAX_DOLL_CHANGE, MAX_DOLL_NAME_LENGTH, SUPER_DOLL_VALUE, parseDollChangeInput, parseDollPrize, parseDollSetInput } from './doll'

/** 素材の種類の引き当て。アップロード済みの画像2枚と効果音1つがある */
const kindOf = (mediaId: string): MediaKind | null =>
  ({ 'image-normal': 'image', 'image-super': 'image', 'sound-fanfare': 'audio' } as Record<string, MediaKind>)[mediaId] ?? null

/** 問題点をすべて取り出す（ConfigError でなければテストを失敗させる） */
const problemsOf = (run: () => unknown): readonly string[] => {
  try {
    run()
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('ConfigError が投げられませんでした')
}

describe('parseDollSetInput', () => {
  it('ふつうの人形とスーパー人形の名前と画像を受け取り、名前の前後の空白を落とす', () => {
    const input = {
      normal: { name: '  ふつうのクマ人形 ', mediaId: 'image-normal' },
      super: { name: 'スーパークマ人形', mediaId: 'image-super' },
    }

    expect(parseDollSetInput(input, kindOf)).toEqual({
      normal: { name: 'ふつうのクマ人形', mediaId: 'image-normal' },
      super: { name: 'スーパークマ人形', mediaId: 'image-super' },
    })
  })

  it('名前の空・長すぎる、画像の無い素材・画像でない素材を、すべて集めて拒む', () => {
    const input = {
      normal: { name: '   ', mediaId: 'deleted-image' },
      super: { name: 'ス'.repeat(MAX_DOLL_NAME_LENGTH + 1), mediaId: 'sound-fanfare' },
    }

    const problems = problemsOf(() => parseDollSetInput(input, kindOf))

    // 4つの問題がそれぞれどの項目のものか分かる形で並ぶ
    expect(problems).toHaveLength(4)
    expect(problems.filter((problem) => problem.startsWith('normal.name:'))).toHaveLength(1)
    expect(problems.filter((problem) => problem.startsWith('normal.mediaId:'))).toHaveLength(1)
    expect(problems.filter((problem) => problem.startsWith('super.name:'))).toHaveLength(1)
    expect(problems.filter((problem) => problem.startsWith('super.mediaId:'))).toHaveLength(1)
  })

  it('形が違う（片方の人形が無い）なら拒む', () => {
    const problems = problemsOf(() => parseDollSetInput({ normal: { name: 'ふつうのクマ人形', mediaId: 'image-normal' } }, kindOf))

    expect(problems.some((problem) => problem.startsWith('super:'))).toBe(true)
  })
})

describe('parseDollChangeInput', () => {
  it('種類と0でない整数の増減を受け取る', () => {
    expect(parseDollChangeInput({ kind: 'normal', delta: 1 })).toEqual({ kind: 'normal', delta: 1 })
    expect(parseDollChangeInput({ kind: 'super', delta: -1 })).toEqual({ kind: 'super', delta: -1 })
  })

  it('知らない種類・0・小数・上限を超える増減を拒む', () => {
    expect(problemsOf(() => parseDollChangeInput({ kind: 'golden', delta: 1 }))).toHaveLength(1)
    expect(problemsOf(() => parseDollChangeInput({ kind: 'normal', delta: 0 }))).toHaveLength(1)
    expect(problemsOf(() => parseDollChangeInput({ kind: 'normal', delta: 1.5 }))).toHaveLength(1)
    expect(problemsOf(() => parseDollChangeInput({ kind: 'normal', delta: -(MAX_DOLL_CHANGE + 1) }))).toHaveLength(1)
  })
})

describe('parseDollPrize', () => {
  it('ふつう・スーパー・渡さない（null）のどれかを受け取る', () => {
    expect(parseDollPrize({ kind: 'normal' })).toEqual({ kind: 'normal' })
    expect(parseDollPrize({ kind: 'super' })).toEqual({ kind: 'super' })
    expect(parseDollPrize({ kind: null })).toEqual({ kind: null })
  })

  it('知らない種類・種類の書き忘れ・オブジェクトでない値を拒む', () => {
    expect(problemsOf(() => parseDollPrize({ kind: 'golden' }))).toHaveLength(1)
    // 書き忘れを「渡さない」と読み替えない
    expect(problemsOf(() => parseDollPrize({}))).toHaveLength(1)
    expect(problemsOf(() => parseDollPrize('normal'))).toHaveLength(1)
  })
})

describe('SUPER_DOLL_VALUE', () => {
  it('ランキングの点数に使う比と、画面の説明に出す比が同じである（片方だけ変えると、出す点数の決まりと実際の点数が食い違うため）', () => {
    expect(SUPER_DOLL_VALUE).toBe(SCREEN_SUPER_DOLL_VALUE)
  })
})
