/**
 * 入力欄と保存形式の変換
 *
 * 入力欄の値はすべて文字列で、音量は 0〜100 の百分率で見せる。Workerへ送る形（報酬なしは null、音量は 0〜1）との行き来と、
 * OBSに貼るURL・選択肢や大きさの文言の組み立てを受け持つ。DOMには触れない。
 *
 * 注意: 値の範囲（表示時間は1〜60秒など）の検証はWorkerが行い、問題点をまとめて返す。ここでは数として読めるかだけを確かめる。
 */
import type { Reward, StoredTrigger, TriggerInput } from './api'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const ALERTS_PATH = '/alerts/'
const PERCENT = 100
const BYTES_PER_UNIT = 1024
/** 「すべての報酬」を表す選択肢の値（保存時は null になる） */
const ANY_REWARD = ''

/** トリガー1件分の入力欄の値 */
export interface TriggerDraft {
  /** 空文字はすべての報酬 */
  rewardId: string
  mediaId: string
  durationSeconds: string
  /** 0〜100 */
  volumePercent: string
  message: string
}

export interface SelectOption {
  value: string
  label: string
}

/** OBSのブラウザソースに貼るURL */
export const overlayUrl = (origin: string, overlayKey: string): string => `${origin}${ALERTS_PATH}?key=${encodeURIComponent(overlayKey)}`

/** 入力欄の文字列を数にする。空欄や数でない文字列を 0 や NaN のまま送らない */
const toNumber = (text: string, label: string): number => {
  const value = text.trim() === '' ? Number.NaN : Number(text)
  if (!Number.isFinite(value)) throw new Error(`${label}を数で入力してください`)
  return value
}

/**
 * 入力欄の値を、Workerへ送る形にする。
 *
 * @throws 表示時間・音量が数として読めない場合
 */
export const toTriggerInput = (draft: TriggerDraft): TriggerInput => ({
  event: REDEMPTION,
  rewardId: draft.rewardId === ANY_REWARD ? null : draft.rewardId,
  mediaId: draft.mediaId,
  durationSeconds: toNumber(draft.durationSeconds, '表示時間'),
  volume: toNumber(draft.volumePercent, '音量') / PERCENT,
  message: draft.message,
})

/** 保存済みのトリガーを入力欄の値に戻す */
export const toDraft = (trigger: StoredTrigger): TriggerDraft => ({
  rewardId: trigger.rewardId ?? ANY_REWARD,
  mediaId: trigger.mediaId,
  durationSeconds: String(trigger.durationSeconds),
  volumePercent: String(Math.round(trigger.volume * PERCENT)),
  message: trigger.message,
})

/**
 * 報酬の選択肢を作る。
 *
 * @param selected いま選ばれている報酬ID。Twitchの一覧にない（削除された）報酬でも、黙って別の報酬に変わらないよう選択肢に残す
 */
export const rewardOptions = (rewards: readonly Reward[], selected: string): SelectOption[] => {
  const options = [{ value: ANY_REWARD, label: 'すべての報酬' }, ...rewards.map((reward) => ({ value: reward.id, label: `${reward.title}（${reward.cost}pt）` }))]
  if (options.some((option) => option.value === selected)) return options
  return [...options, { value: selected, label: `Twitchの一覧にない報酬（${selected}）` }]
}

/** 素材の大きさを読みやすい単位で表す */
export const formatBytes = (size: number): string => {
  if (size < BYTES_PER_UNIT) return `${size} B`
  if (size < BYTES_PER_UNIT ** 2) return `${(size / BYTES_PER_UNIT).toFixed(1)} KB`
  return `${(size / BYTES_PER_UNIT ** 2).toFixed(1)} MB`
}

/** Workerが問題点の先頭に付ける位置（triggers[0]. の形。番号は0始まり） */
const PROBLEM_POSITION = /^triggers\[(\d+)\]\./

/** Workerが返した問題点の位置を、画面に振ってある番号（1始まり）に読み替える */
export const describeProblem = (problem: string): string =>
  problem.replace(PROBLEM_POSITION, (_, index: string) => `${Number(index) + 1}番目のトリガーの `)
