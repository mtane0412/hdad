/**
 * 漢字クイズで配信を止めるまでの時間切れの回数の設定（kanji-quiz-miss-limit.ts）のテスト
 *
 * 管理画面から受け取った回数を検証して KV に保存し、時間切れの判定と出題が読み出す。
 * - 1〜10の整数だけを受け付け、それ以外は問題点つきで断る
 * - 未保存なら1回（回数を設定にする前と同じく、1回の時間切れで配信を止める）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import { loadKanjiQuizMissLimit, parseKanjiQuizMissLimit, saveKanjiQuizMissLimit } from './kanji-quiz-miss-limit'

describe('parseKanjiQuizMissLimit', () => {
  it('1〜10の整数の回数を受け付ける', () => {
    expect(parseKanjiQuizMissLimit({ missLimit: 3 })).toEqual({ missLimit: 3 })
  })

  it('回数が0・上限を超える・整数でない・無いなら、問題点つきで断る', () => {
    for (const input of [{ missLimit: 0 }, { missLimit: 11 }, { missLimit: 2.5 }, { missLimit: '3' }, {}]) {
      expect(() => parseKanjiQuizMissLimit(input)).toThrowError(ConfigError)
    }
  })

  it('オブジェクトでなければ断る', () => {
    expect(() => parseKanjiQuizMissLimit(3)).toThrowError(ConfigError)
  })
})

describe('loadKanjiQuizMissLimit・saveKanjiQuizMissLimit', () => {
  it('未保存なら1回を返す', async () => {
    expect(await loadKanjiQuizMissLimit(createFakeStore())).toEqual({ missLimit: 1 })
  })

  it('保存した回数を読み出す', async () => {
    const store = createFakeStore()

    await saveKanjiQuizMissLimit(store, { missLimit: 3 })

    expect(await loadKanjiQuizMissLimit(store)).toEqual({ missLimit: 3 })
  })
})
