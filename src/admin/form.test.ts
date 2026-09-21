/**
 * 入力欄と保存形式の変換（form.ts）のテスト
 *
 * 入力欄の値はすべて文字列で、音量は 0〜100 の百分率で見せる。
 * Workerへ送る形（報酬なしは null、音量は 0〜1）との行き来と、OBS用URL・表示用の文言を確認する。
 */
import { describe, expect, it } from 'vitest'
import { describeProblem, formatBytes, overlayUrl, rewardOptions, toDraft, toTriggerInput } from './form'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

describe('overlayUrl', () => {
  it('サイトのオリジンとオーバーレイ用キーから、OBSに貼るURLを組み立てる', () => {
    expect(overlayUrl('https://stream-assets.example.com', 'overlay-key_0123')).toBe('https://stream-assets.example.com/alerts/?key=overlay-key_0123')
  })
})

describe('toTriggerInput', () => {
  it('入力欄の値を、Workerへ送る形にする（音量は百分率から0〜1へ）', () => {
    const draft = { rewardId: '報酬ID-乾杯', mediaId: 'sozai-1', durationSeconds: '8', volumePercent: '50', message: '{user} さん、乾杯！' }

    expect(toTriggerInput(draft)).toEqual({
      event: REDEMPTION,
      rewardId: '報酬ID-乾杯',
      mediaId: 'sozai-1',
      durationSeconds: 8,
      volume: 0.5,
      message: '{user} さん、乾杯！',
    })
  })

  it('報酬を選んでいなければ（空文字）、すべての報酬を表す null にする', () => {
    const draft = { rewardId: '', mediaId: 'sozai-1', durationSeconds: '5', volumePercent: '100', message: '' }
    expect(toTriggerInput(draft).rewardId).toBeNull()
  })

  it('表示時間が数として読めなければエラーにする（何番目のトリガーかは呼び出し側が添える）', () => {
    const draft = { rewardId: '', mediaId: 'sozai-1', durationSeconds: '', volumePercent: '100', message: '' }
    expect(() => toTriggerInput(draft)).toThrow('表示時間')
  })
})

describe('toDraft', () => {
  it('保存済みのトリガーを入力欄の値に戻す（null の報酬は空文字、音量は百分率）', () => {
    const stored = { event: REDEMPTION, rewardId: null, mediaId: 'sozai-1', mediaKind: 'video', durationSeconds: 8, volume: 0.35, message: '乾杯！' } as const

    expect(toDraft(stored)).toEqual({ rewardId: '', mediaId: 'sozai-1', durationSeconds: '8', volumePercent: '35', message: '乾杯！' })
  })
})

describe('rewardOptions', () => {
  const rewards = [
    { id: '報酬ID-乾杯', title: '乾杯する', cost: 500 },
    { id: '報酬ID-おみくじ', title: 'おみくじを引く', cost: 100 },
  ]

  it('先頭に「すべての報酬」を置き、報酬は名前と必要ポイントで見せる', () => {
    expect(rewardOptions(rewards, '')).toEqual([
      { value: '', label: 'すべての報酬' },
      { value: '報酬ID-乾杯', label: '乾杯する（500pt）' },
      { value: '報酬ID-おみくじ', label: 'おみくじを引く（100pt）' },
    ])
  })

  it('保存済みの報酬がTwitchの一覧にない（削除された）場合も、選択肢として残して分かるようにする', () => {
    const options = rewardOptions(rewards, '報酬ID-消した報酬')
    expect(options.at(-1)).toEqual({ value: '報酬ID-消した報酬', label: 'Twitchの一覧にない報酬（報酬ID-消した報酬）' })
  })
})

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [1536, '1.5 KB'],
    [1_234_567, '1.2 MB'],
  ])('%d バイトを %s と表示する', (size, expected) => {
    expect(formatBytes(size)).toBe(expected)
  })
})

describe('describeProblem', () => {
  it('Workerの問題点の位置（0始まりの triggers[0]）を、画面の番号（1番目のトリガー）に読み替える', () => {
    expect(describeProblem('triggers[0].durationSeconds: 1〜60 の数値で指定してください')).toBe('1番目のトリガーの durationSeconds: 1〜60 の数値で指定してください')
    expect(describeProblem('triggers[11].mediaId: 素材「sozai-9」が存在しません')).toBe('12番目のトリガーの mediaId: 素材「sozai-9」が存在しません')
  })

  it('トリガーの位置を含まない問題点は、そのまま返す', () => {
    expect(describeProblem('triggers: 100件以内にしてください')).toBe('triggers: 100件以内にしてください')
  })
})
