/**
 * チャンネルポイント報酬の入力欄の変換（reward-form.ts）のテスト
 *
 * 確かめること:
 * - 報酬を入力欄の下書きにし、下書きをWorkerへ送る内容に戻せること
 * - 必要ポイントの空欄を 0 に丸めず、Workerに拒ませる値（NaN）にすること
 * - 待機時間・上限回数の空欄は null（制限なし）にすること
 * - Workerの問題点に出る項目名を、画面の欄の名前に読み替えること
 */
import { describe, expect, it } from 'vitest'
import type { Reward } from './api'
import { EMPTY_REWARD_DRAFT, describeRewardProblem, toRewardDraft, toRewardInput } from './reward-form'

const toastReward: Reward = {
  id: '報酬ID-乾杯',
  title: '乾杯する',
  cost: 500,
  prompt: 'おつまみも添えて',
  isEnabled: true,
  isUserInputRequired: false,
  backgroundColor: '#00E5CB',
  shouldRedemptionsSkipRequestQueue: true,
  maxPerStream: null,
  maxPerUserPerStream: 1,
  globalCooldownSeconds: 300,
  imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png',
  manageable: true,
}

describe('toRewardDraft・toRewardInput', () => {
  it('報酬を下書きにして戻すと、Workerへ送る項目だけが元のまま残る', () => {
    expect(toRewardInput(toRewardDraft(toastReward))).toEqual({
      title: '乾杯する',
      cost: 500,
      prompt: 'おつまみも添えて',
      isEnabled: true,
      isUserInputRequired: false,
      backgroundColor: '#00E5CB',
      shouldRedemptionsSkipRequestQueue: true,
      maxPerStream: null,
      maxPerUserPerStream: 1,
      globalCooldownSeconds: 300,
    })
  })

  it('待機時間・上限回数は入力欄の文字列として持ち、制限なし（null）は空欄にする', () => {
    const draft = toRewardDraft(toastReward)
    expect(draft.maxPerStream).toBe('')
    expect(draft.maxPerUserPerStream).toBe('1')
    expect(draft.globalCooldownSeconds).toBe('300')
  })

  it('待機時間・上限回数の空欄は null（制限なし）にする', () => {
    const input = toRewardInput({ ...EMPTY_REWARD_DRAFT, maxPerStream: ' ', maxPerUserPerStream: '', globalCooldownSeconds: '' })
    expect(input).toMatchObject({ maxPerStream: null, maxPerUserPerStream: null, globalCooldownSeconds: null })
  })

  it('待機時間・上限回数が数として扱えない値（1e309 が Infinity になるなど）なら、制限なしとして送らずに投げる', () => {
    // Infinity・NaN はJSONで null（制限なし）になってしまい、Workerでは拒めないため、ここで止める
    expect(() => toRewardInput({ ...EMPTY_REWARD_DRAFT, maxPerStream: '1e309' })).toThrow('1配信あたりの上限回数')
    expect(() => toRewardInput({ ...EMPTY_REWARD_DRAFT, globalCooldownSeconds: 'あ' })).toThrow('待機時間（秒）')
  })

  it('新しく作る報酬の下書きは、Twitchの既定の紫・待ち行列あり・制限なしから始める', () => {
    expect(toRewardInput({ ...EMPTY_REWARD_DRAFT, cost: '100' })).toMatchObject({
      backgroundColor: '#9147FF',
      shouldRedemptionsSkipRequestQueue: false,
      maxPerStream: null,
      maxPerUserPerStream: null,
      globalCooldownSeconds: null,
    })
  })

  it('必要ポイントは入力欄の文字列として持つ', () => {
    expect(toRewardDraft(toastReward).cost).toBe('500')
  })

  it('必要ポイントが空欄なら 0 に丸めず NaN にする（Workerに拒ませて、空欄だと気づけるように）', () => {
    expect(toRewardInput({ ...EMPTY_REWARD_DRAFT, cost: '' }).cost).toBeNaN()
    expect(toRewardInput({ ...EMPTY_REWARD_DRAFT, cost: '  ' }).cost).toBeNaN()
  })

  it('新しく作る報酬の下書きは、交換できる状態から始める', () => {
    expect(EMPTY_REWARD_DRAFT.isEnabled).toBe(true)
  })
})

describe('describeRewardProblem', () => {
  it('Workerの問題点の項目名を、画面の欄の名前に読み替える', () => {
    expect(describeRewardProblem('title: 名前は空でない45文字までの文字列で指定してください')).toBe(
      '名前: 名前は空でない45文字までの文字列で指定してください',
    )
    expect(describeRewardProblem('cost: 必要ポイントは1以上の整数で指定してください')).toBe('必要ポイント: 必要ポイントは1以上の整数で指定してください')
    expect(describeRewardProblem('globalCooldownSeconds: 待機時間は60〜604800秒の整数で指定してください（空欄なら待機なし）')).toBe(
      '待機時間（秒）: 待機時間は60〜604800秒の整数で指定してください（空欄なら待機なし）',
    )
  })

  it('知らない項目名の問題点は、そのまま出す（黙って消さない）', () => {
    expect(describeRewardProblem('報酬の内容はオブジェクトで指定してください')).toBe('報酬の内容はオブジェクトで指定してください')
  })
})
