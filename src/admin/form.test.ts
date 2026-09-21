/**
 * 入力欄と保存形式の変換（form.ts）のテスト
 *
 * 入力欄の値はすべて文字列で、音量は 0〜100 の百分率で見せる。
 * Workerへ送る形（報酬なしは null、音量は 0〜1）との行き来と、イベント種別ごとの選択肢・差し込み語、OBS用URL・表示用の文言を確認する。
 */
import { describe, expect, it } from 'vitest'
import { describeProblem, eventOptions, formatBytes, overlayUrl, placeholdersFor, rewardOptions, toDraft, toTriggerInput, type TriggerDraft } from './form'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const FOLLOW = 'channel.follow'
const RAID = 'channel.raid'

/** トリガー1件分の入力欄の値。テストでは違いのある項目だけを重ねて書く */
const 入力欄 = (overrides: Partial<TriggerDraft> = {}): TriggerDraft => ({
  event: REDEMPTION,
  rewardId: '',
  mediaId: 'sozai-1',
  durationSeconds: '5',
  volumePercent: '100',
  message: '',
  ...overrides,
})

describe('overlayUrl', () => {
  it('サイトのオリジンとオーバーレイ用キーから、OBSに貼るURLを組み立てる', () => {
    expect(overlayUrl('https://stream-assets.example.com', 'overlay-key_0123')).toBe('https://stream-assets.example.com/alerts/?key=overlay-key_0123')
  })
})

describe('toTriggerInput', () => {
  it('チャンネルポイント交換の入力欄の値を、Workerへ送る形にする（音量は百分率から0〜1へ）', () => {
    const draft = 入力欄({ rewardId: '報酬ID-乾杯', durationSeconds: '8', volumePercent: '50', message: '{user} さん、乾杯！' })

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
    expect(toTriggerInput(入力欄())).toMatchObject({ event: REDEMPTION, rewardId: null })
  })

  it('チャンネルポイント交換以外のイベントは、報酬IDを送らない（入力欄に残っていても引きずらない）', () => {
    const draft = 入力欄({ event: FOLLOW, rewardId: '報酬ID-乾杯', message: '{user} さん、ありがとう！' })

    expect(toTriggerInput(draft)).toEqual({
      event: FOLLOW,
      mediaId: 'sozai-1',
      durationSeconds: 5,
      volume: 1,
      message: '{user} さん、ありがとう！',
    })
  })

  it('表示時間が数として読めなければエラーにする（何番目のトリガーかは呼び出し側が添える）', () => {
    expect(() => toTriggerInput(入力欄({ durationSeconds: '' }))).toThrow('表示時間')
  })
})

describe('toDraft', () => {
  it('保存済みのチャンネルポイント交換のトリガーを入力欄の値に戻す（null の報酬は空文字、音量は百分率）', () => {
    const stored = { event: REDEMPTION, rewardId: null, mediaId: 'sozai-1', mediaKind: 'video', durationSeconds: 8, volume: 0.35, message: '乾杯！' } as const

    expect(toDraft(stored)).toEqual({ event: REDEMPTION, rewardId: '', mediaId: 'sozai-1', durationSeconds: '8', volumePercent: '35', message: '乾杯！' })
  })

  it('報酬IDを持たないイベントのトリガーは、報酬の入力欄を「すべての報酬」（空文字）にして戻す', () => {
    const stored = { event: RAID, mediaId: 'sozai-2', mediaKind: 'image', durationSeconds: 5, volume: 1, message: '{user} さんがレイド！' } as const

    expect(toDraft(stored)).toEqual({ event: RAID, rewardId: '', mediaId: 'sozai-2', durationSeconds: '5', volumePercent: '100', message: '{user} さんがレイド！' })
  })
})

describe('eventOptions', () => {
  it('5種類のイベントを、日本語のラベル付きで選べるようにする', () => {
    expect(eventOptions).toEqual([
      { value: REDEMPTION, label: 'チャンネルポイントの交換' },
      { value: FOLLOW, label: 'フォロー' },
      { value: 'channel.subscribe', label: 'サブスク（新規）' },
      { value: 'channel.subscription.message', label: 'サブスク（継続メッセージ）' },
      { value: RAID, label: 'レイド' },
    ])
  })
})

describe('placeholdersFor', () => {
  it.each([
    [REDEMPTION, ['{user}', '{reward}']],
    [FOLLOW, ['{user}']],
    ['channel.subscribe', ['{user}', '{tier}']],
    ['channel.subscription.message', ['{user}', '{tier}', '{months}']],
    [RAID, ['{user}', '{viewers}']],
  ] as const)('%s で使える差し込み語を返す', (event, expected) => {
    expect(placeholdersFor(event)).toEqual(expected)
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
