/**
 * チャンネルポイント報酬の入力欄の変換
 *
 * 報酬のページ（reward-page.tsx）の入力欄の値（下書き）と、Workerへ送る内容との変換を受け持つ。
 * DOMも通信も持たないので、ここだけを切り出してテストする（.claude/rules/implementation.md）。
 *
 * 注意: 値の検証はWorkerだけが持つ（worker/reward-input.ts）。画面は必要ポイントの空欄を 0 に丸めず NaN のまま送り、
 * 返ってきた問題点を欄の名前へ読み替えて並べる。
 */
import type { Reward, RewardInput } from './api'

/** 入力欄の値。必要ポイントは入力欄の文字列のまま持つ */
export interface RewardDraft {
  title: string
  cost: string
  prompt: string
  isEnabled: boolean
  isUserInputRequired: boolean
}

/** 新しく作る報酬の下書き。作ったらすぐ交換できる状態から始める */
export const EMPTY_REWARD_DRAFT: RewardDraft = { title: '', cost: '', prompt: '', isEnabled: true, isUserInputRequired: false }

/** 報酬を入力欄の下書きにする */
export const toRewardDraft = (reward: Reward): RewardDraft => ({
  title: reward.title,
  cost: String(reward.cost),
  prompt: reward.prompt,
  isEnabled: reward.isEnabled,
  isUserInputRequired: reward.isUserInputRequired,
})

/**
 * 下書きをWorkerへ送る内容にする。
 *
 * 必要ポイントの空欄は NaN にする（Number('') は 0 になってしまい、空欄のまま「0ポイント」として拒まれて気づきにくいため）。
 * NaN はJSONでは null になり、Workerが「1以上の整数で指定してください」と拒む。
 */
export const toRewardInput = (draft: RewardDraft): RewardInput => ({
  title: draft.title,
  cost: draft.cost.trim() === '' ? Number.NaN : Number(draft.cost),
  prompt: draft.prompt,
  isEnabled: draft.isEnabled,
  isUserInputRequired: draft.isUserInputRequired,
})

/** Workerの問題点に出る項目名と、画面の欄の名前 */
const FIELD_LABELS: Record<string, string> = {
  title: '名前',
  cost: '必要ポイント',
  prompt: '説明',
  isEnabled: '交換できる',
  isUserInputRequired: 'メッセージの入力を求める',
}

/** Workerの問題点（「項目名: 内容」）の項目名を、画面の欄の名前に読み替える。知らない形はそのまま返す */
export const describeRewardProblem = (problem: string): string => {
  const separator = problem.indexOf(': ')
  const label = separator === -1 ? undefined : FIELD_LABELS[problem.slice(0, separator)]
  return label === undefined ? problem : `${label}${problem.slice(separator)}`
}
