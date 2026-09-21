/**
 * 入力欄と保存形式の変換
 *
 * 入力欄の値はすべて文字列で、音量は 0〜100 の百分率で見せる。Workerへ送る形（報酬なしは null、音量は 0〜1）との行き来と、
 * OBSに貼るURL・選択肢や大きさの文言の組み立てを受け持つ。DOMには触れない。
 *
 * 入力欄はイベント種別によらず同じ項目を持ち（報酬の欄はチャンネルポイント交換のときだけ画面に出す）、
 * Workerへ送るときにイベント種別ごとの形（union）へ直す。
 *
 * 注意: 値の範囲（表示時間は1〜60秒など）の検証はWorkerが行い、問題点をまとめて返す。ここでは数として読めるかだけを確かめる。
 */
import { ALERT_EVENTS, type ActionInput, type AlertEvent, type Reward, type StoredTrigger, type TriggerInput } from './api'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const ALERTS_PATH = '/alerts/'
const PERCENT = 100
const BYTES_PER_UNIT = 1024
/** 「すべての報酬」を表す選択肢の値（保存時は null になる） */
const ANY_REWARD = ''
/** 新しく足したトリガーと、アラートを外したトリガーの表示時間の既定値（秒） */
const DEFAULT_DURATION_SECONDS = 5

/**
 * トリガー1件分の入力欄の値
 *
 * 動作（アラートを出す・チャットに送る）は、保存する形では配列だが、入力欄では種類ごとに決まった欄を出すほうが分かりやすいため、
 * 「行うかどうか」（alertEnabled・chatEnabled）と、それぞれの欄を平坦に持つ。外した動作の入力欄の値は保存時に送らない。
 */
export interface TriggerDraft {
  event: AlertEvent
  /** 空文字はすべての報酬。チャンネルポイント交換以外では使わない */
  rewardId: string
  /** オーバーレイに素材を出すか */
  alertEnabled: boolean
  mediaId: string
  durationSeconds: string
  /** 0〜100 */
  volumePercent: string
  message: string
  /** botとしてチャットへ送るか */
  chatEnabled: boolean
  chatMessage: string
}

export interface SelectOption {
  value: string
  label: string
}

/** イベント種別の日本語のラベル */
const EVENT_LABELS: Readonly<Record<AlertEvent, string>> = {
  [REDEMPTION]: 'チャンネルポイントの交換',
  'channel.follow': 'フォロー',
  'channel.subscribe': 'サブスク（新規）',
  'channel.subscription.message': 'サブスク（継続メッセージ）',
  'channel.raid': 'レイド',
}

/** イベント種別ごとに、文言で使える差し込み語 */
const EVENT_PLACEHOLDERS: Readonly<Record<AlertEvent, readonly string[]>> = {
  [REDEMPTION]: ['{user}', '{reward}'],
  'channel.follow': ['{user}'],
  'channel.subscribe': ['{user}', '{tier}'],
  'channel.subscription.message': ['{user}', '{tier}', '{months}'],
  'channel.raid': ['{user}', '{viewers}'],
}

/** イベント種別の選択肢 */
export const eventOptions: readonly SelectOption[] = ALERT_EVENTS.map((event) => ({ value: event, label: EVENT_LABELS[event] }))

/** そのイベントの文言で使える差し込み語。選んだイベントに存在しない語は置き換わらないため、画面で知らせる */
export const placeholdersFor = (event: AlertEvent): readonly string[] => EVENT_PLACEHOLDERS[event]

/** OBSのブラウザソースに貼るURL */
export const overlayUrl = (origin: string, overlayKey: string): string => `${origin}${ALERTS_PATH}?key=${encodeURIComponent(overlayKey)}`

/** 入力欄の文字列を数にする。空欄や数でない文字列を 0 や NaN のまま送らない */
const toNumber = (text: string, label: string): number => {
  const value = text.trim() === '' ? Number.NaN : Number(text)
  if (!Number.isFinite(value)) throw new Error(`${label}を数で入力してください`)
  return value
}

/**
 * 入力欄の値を、Workerへ送る動作の一覧にする。外した動作の入力欄の値は送らない（外したのに保存されるのを防ぐ）。
 *
 * @throws 表示時間・音量が数として読めない場合（アラートを出すときだけ確かめる）
 */
const toActions = (draft: TriggerDraft): ActionInput[] => {
  const actions: ActionInput[] = []
  if (draft.alertEnabled) {
    actions.push({
      type: 'alert',
      mediaId: draft.mediaId,
      durationSeconds: toNumber(draft.durationSeconds, '表示時間'),
      volume: toNumber(draft.volumePercent, '音量') / PERCENT,
      message: draft.message,
    })
  }
  if (draft.chatEnabled) actions.push({ type: 'chat', message: draft.chatMessage })
  return actions
}

/**
 * 入力欄の値を、Workerへ送る形にする。報酬IDはチャンネルポイント交換のときだけ送る。
 *
 * 動作が1件もない場合も、そのまま送ってWorkerに問題点を返させる（画面とWorkerで検証を二重に持たないため）。
 *
 * @throws 表示時間・音量が数として読めない場合
 */
export const toTriggerInput = (draft: TriggerDraft): TriggerInput => {
  const actions = toActions(draft)
  if (draft.event === REDEMPTION) return { event: draft.event, rewardId: draft.rewardId === ANY_REWARD ? null : draft.rewardId, actions }
  return { event: draft.event, actions }
}

/** 動作を外したときに入力欄へ残しておく既定値（画面で入れ直さずに済むように、形だけは保つ） */
const DEFAULT_ALERT_DRAFT = { mediaId: '', durationSeconds: String(DEFAULT_DURATION_SECONDS), volumePercent: String(PERCENT), message: '' }

/**
 * 保存済みのトリガーを入力欄の値に戻す。
 *
 * 報酬IDを持たないイベントは「すべての報酬」（空文字）にしておく。持っていない動作の欄は既定値で埋め、行わない印を付ける。
 */
export const toDraft = (trigger: StoredTrigger): TriggerDraft => {
  const alert = trigger.actions.find((action) => action.type === 'alert')
  const chat = trigger.actions.find((action) => action.type === 'chat')

  return {
    event: trigger.event,
    rewardId: trigger.event === REDEMPTION ? (trigger.rewardId ?? ANY_REWARD) : ANY_REWARD,
    alertEnabled: alert !== undefined,
    ...(alert === undefined
      ? DEFAULT_ALERT_DRAFT
      : {
          mediaId: alert.mediaId,
          durationSeconds: String(alert.durationSeconds),
          volumePercent: String(Math.round(alert.volume * PERCENT)),
          message: alert.message,
        }),
    chatEnabled: chat !== undefined,
    chatMessage: chat?.message ?? '',
  }
}

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

/** Workerが問題点の先頭に付ける位置（triggers[0]. や triggers[0].actions[1]. の形。番号は0始まり） */
const PROBLEM_POSITION = /^triggers\[(\d+)\]\.(?:actions\[(\d+)\]\.)?/

/** Workerが返した問題点の位置を、画面に振ってある番号（1始まり）に読み替える */
export const describeProblem = (problem: string): string =>
  problem.replace(PROBLEM_POSITION, (_, trigger: string, action: string | undefined) => {
    const position = `${Number(trigger) + 1}番目のトリガーの `
    return action === undefined ? position : `${position}${Number(action) + 1}つ目の動作の `
  })
