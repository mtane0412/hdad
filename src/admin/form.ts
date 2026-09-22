/**
 * 入力欄と保存形式の変換
 *
 * 入力欄の値はすべて文字列で、音量は 0〜100 の百分率で見せる。Workerへ送る形（音量は 0〜1）との行き来と、
 * OBSに貼るURL・選択肢や大きさの文言の組み立てを受け持つ。DOMには触れない。
 *
 * 絞り込みは「条件のリスト」（conditions）で表し、入力欄でも同じリストのまま持つ（Workerへ送るときも並びを変えない）。
 * 条件はすべてを満たしたときだけ当てはまる（and）ため、条件を1件も持たないトリガーはそのイベントが起きればいつでも当てはまる。
 *
 * 注意: 値の範囲（表示時間は1〜60秒など）の検証はWorkerが行い、問題点をまとめて返す。ここでは数として読めるかだけを確かめる。
 */
import {
  ALERT_EVENTS,
  ANNOUNCEMENT_COLORS,
  CONDITION_KINDS,
  type ActionInput,
  type AlertEvent,
  type AnnouncementColor,
  type ConditionKind,
  type MediaKind,
  type Reward,
  type StoredTrigger,
  type TriggerCondition,
  type TriggerInput,
} from './api'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const CHAT_MESSAGE = 'channel.chat.message'
const ALERTS_PATH = '/alerts/'
const PERCENT = 100
const BYTES_PER_UNIT = 1024
/** 報酬をまだ選べていないことを表す選択肢の値（この値のまま保存するとWorkerが問題点を返す） */
const NO_REWARD = ''
/** 新しく足したトリガーと、アラートを外したトリガーの表示時間の既定値（秒） */
const DEFAULT_DURATION_SECONDS = 5
/** アナウンスを使わないトリガーの色の既定値（チャンネルの色） */
const DEFAULT_ANNOUNCEMENT_COLOR: AnnouncementColor = 'primary'

/** 素材の種類の日本語のラベル */
export const kindLabels: Readonly<Record<MediaKind, string>> = { image: '画像', video: '動画', audio: '音声' }

/** アナウンスの色の日本語のラベル */
const COLOR_LABELS: Readonly<Record<AnnouncementColor, string>> = {
  primary: 'チャンネルの色',
  blue: '青',
  green: '緑',
  orange: 'オレンジ',
  purple: '紫',
}

/** 条件の種類の日本語のラベル */
const CONDITION_LABELS: Readonly<Record<ConditionKind, string>> = { reward: '報酬', user: 'ユーザー', text: '文面' }

/** 条件の種類の日本語のラベル。画面の見出しと要約で使う */
export const conditionLabel = (kind: ConditionKind): string => CONDITION_LABELS[kind]

/** アナウンスの色の選択肢 */
export const colorOptions: readonly SelectOption[] = ANNOUNCEMENT_COLORS.map((color) => ({ value: color, label: COLOR_LABELS[color] }))

/**
 * トリガー1件分の入力欄の値
 *
 * 動作（アラートを出す・チャットに送る）は、保存する形では配列だが、入力欄では種類ごとに決まった欄を出すほうが分かりやすいため、
 * 「行うかどうか」（alertEnabled・chatEnabled）と、それぞれの欄を平坦に持つ。外した動作の入力欄の値は保存時に送らない。
 */
export interface TriggerDraft {
  event: AlertEvent
  /** 絞り込みの条件。すべてを満たしたときだけ当てはまる。同じ種類は1件までにする */
  conditions: TriggerCondition[]
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
  /** botとしてアナウンス（色の付いた帯）を送るか */
  announceEnabled: boolean
  announceMessage: string
  announceColor: AnnouncementColor
}

export interface SelectOption {
  value: string
  label: string
}

/** 条件の種類の選択肢。値を ConditionKind に狭めておき、呼び出し側で型アサーションを使わずに済ませる */
export interface ConditionKindOption {
  value: ConditionKind
  label: string
}

/** イベント種別の日本語のラベル */
const EVENT_LABELS: Readonly<Record<AlertEvent, string>> = {
  [REDEMPTION]: 'チャンネルポイントの交換',
  'channel.follow': 'フォロー',
  'channel.subscribe': 'サブスク（新規）',
  'channel.subscription.message': 'サブスク（継続メッセージ）',
  'channel.raid': 'レイド',
  [CHAT_MESSAGE]: 'チャットの発言',
}

/** イベント種別ごとに、文言で使える差し込み語 */
const EVENT_PLACEHOLDERS: Readonly<Record<AlertEvent, readonly string[]>> = {
  [REDEMPTION]: ['{user}', '{reward}'],
  'channel.follow': ['{user}'],
  'channel.subscribe': ['{user}', '{tier}'],
  'channel.subscription.message': ['{user}', '{tier}', '{months}'],
  'channel.raid': ['{user}', '{viewers}'],
  [CHAT_MESSAGE]: ['{user}', '{message}'],
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
  if (draft.announceEnabled) actions.push({ type: 'announce', message: draft.announceMessage, color: draft.announceColor })
  return actions
}

/**
 * 入力欄の値を、Workerへ送る形にする。条件は並びを変えずにそのまま送る。
 *
 * 動作が1件もない場合や、報酬を選べていない場合も、そのまま送ってWorkerに問題点を返させる
 * （画面とWorkerで検証を二重に持たないため）。
 *
 * @throws 表示時間・音量が数として読めない場合
 */
export const toTriggerInput = (draft: TriggerDraft): TriggerInput => ({
  event: draft.event,
  conditions: draft.conditions,
  actions: toActions(draft),
})

/**
 * その条件の種類を、このイベント種別に付けられるか。
 *
 * reward はチャンネルポイントの交換（報酬IDを持つ）、text はチャットの発言（本文を持つ）にしか意味を持たない。
 * Workerの検証（worker/alert-config.ts の parseCondition）と同じ判定を画面側でも持ち、付けられない種類を選択肢に出さない。
 */
const isConditionKindFor = (kind: ConditionKind, event: AlertEvent): boolean => {
  switch (kind) {
    case 'reward':
      return event === REDEMPTION
    case 'text':
      return event === CHAT_MESSAGE
    case 'user':
      return true
  }
}

/**
 * まだ足していない条件の種類の選択肢。
 *
 * 同じ種類は1件までなので、すでに足してある種類は出さない。
 * reward はチャンネルポイントの交換に、text はチャットの発言にしか付けられない（ほかのイベントではWorkerが保存を拒否する）ので、
 * そのイベントのときだけ出す。
 */
export const addableConditionKinds = (draft: TriggerDraft): readonly ConditionKindOption[] =>
  CONDITION_KINDS.filter((kind) => !draft.conditions.some((condition) => condition.kind === kind) && isConditionKindFor(kind, draft.event)).map((kind) => ({
    value: kind,
    label: CONDITION_LABELS[kind],
  }))

/**
 * 足したばかりの条件1件の値。
 *
 * 報酬は、選択欄が見せているとおりの値（置いてある報酬の先頭）を選んでおく。
 * そうしないと、選択欄には最初の報酬が見えているのに保存時に拒まれる。報酬が1つもなければ選べていない状態にする。
 */
export const createCondition = (kind: ConditionKind, rewards: readonly Reward[]): TriggerCondition => {
  switch (kind) {
    case 'reward':
      return { kind, rewardId: rewards[0]?.id ?? NO_REWARD }
    case 'text':
      return { kind, contains: '' }
    case 'user':
      return { kind, login: '' }
  }
}

/**
 * イベント種別を変える。
 *
 * 変えた先のイベントに付けられない条件（チャンネルポイントの交換以外の reward、チャットの発言以外の text）は外す。
 * 残したままでは保存がWorkerに拒否され、画面上は条件が見えているのに直し方が分からなくなるため。
 */
export const changeEvent = (draft: TriggerDraft, event: AlertEvent): TriggerDraft => ({
  ...draft,
  event,
  conditions: draft.conditions.filter((condition) => isConditionKindFor(condition.kind, event)),
})

/** 動作を外したときに入力欄へ残しておく既定値（画面で入れ直さずに済むように、形だけは保つ） */
const DEFAULT_ALERT_DRAFT = { mediaId: '', durationSeconds: String(DEFAULT_DURATION_SECONDS), volumePercent: String(PERCENT), message: '' }

/**
 * 保存済みのトリガーを入力欄の値に戻す。
 *
 * 条件は並びを変えずにそのまま持つ（配列は画面で書き換えるので、保存済みの配列と共有しないよう写しを作る）。
 * 持っていない動作の欄は既定値で埋め、行わない印を付ける。
 */
export const toDraft = (trigger: StoredTrigger): TriggerDraft => {
  const alert = trigger.actions.find((action) => action.type === 'alert')
  const chat = trigger.actions.find((action) => action.type === 'chat')
  const announce = trigger.actions.find((action) => action.type === 'announce')

  return {
    event: trigger.event,
    conditions: [...trigger.conditions],
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
    announceEnabled: announce !== undefined,
    announceMessage: announce?.message ?? '',
    announceColor: announce?.color ?? DEFAULT_ANNOUNCEMENT_COLOR,
  }
}

/**
 * 報酬の選択肢を作る。
 *
 * @param selected いま選ばれている報酬ID。Twitchの一覧にない（削除された）報酬でも、黙って別の報酬に変わらないよう選択肢の先頭に残す。
 *   報酬の一覧を取得できなかったときや、報酬が1つもないときは空文字が選ばれているので、選ぶよう促す選択肢を先頭に置く
 */
export const rewardOptions = (rewards: readonly Reward[], selected: string): SelectOption[] => {
  const options = rewards.map((reward) => ({ value: reward.id, label: `${reward.title}（${reward.cost}pt）` }))
  if (options.some((option) => option.value === selected)) return options
  const label = selected === NO_REWARD ? '報酬を選んでください' : `Twitchの一覧にない報酬（${selected}）`
  return [{ value: selected, label }, ...options]
}

/**
 * 条件1件を要約の中に出す文言。
 *
 * Twitchの一覧にない報酬は、黙って省略せずに報酬IDをそのまま出す（設定を取り違えないため）。
 */
const conditionSummary = (condition: TriggerCondition, rewards: readonly Reward[]): string => {
  switch (condition.kind) {
    case 'reward':
      return `報酬「${rewards.find((reward) => reward.id === condition.rewardId)?.title ?? condition.rewardId}」`
    case 'user':
      return `ユーザー「${condition.login}」`
    case 'text':
      return `文面「${condition.contains}」`
  }
}

/**
 * 折りたたんだトリガーの見出しに出す要約。「イベント（条件）→ 行う動作」の形にする。
 *
 * 条件が2つ以上あるときは「かつ」でつないで、すべてを満たす必要があることが分かるようにする。
 * 条件が1件もなければ、そのイベントならいつでも当てはまるのでイベントの名前だけを出す。
 */
export const triggerSummary = (draft: TriggerDraft, rewards: readonly Reward[]): string => {
  const conditions = draft.conditions.map((condition) => conditionSummary(condition, rewards)).join('かつ')
  const actions = [
    draft.alertEnabled ? 'アラート' : null,
    draft.chatEnabled ? 'チャット' : null,
    draft.announceEnabled ? 'アナウンス' : null,
  ].filter((label) => label !== null)
  // 条件を添えるときは（）が区切りになるので、矢印の前に空白を入れない
  const head = conditions === '' ? `${EVENT_LABELS[draft.event]} ` : `${EVENT_LABELS[draft.event]}（${conditions}）`
  return `${head}→ ${actions.length === 0 ? '動作なし' : actions.join('・')}`
}

/** 素材の大きさを読みやすい単位で表す */
export const formatBytes = (size: number): string => {
  if (size < BYTES_PER_UNIT) return `${size} B`
  if (size < BYTES_PER_UNIT ** 2) return `${(size / BYTES_PER_UNIT).toFixed(1)} KB`
  return `${(size / BYTES_PER_UNIT ** 2).toFixed(1)} MB`
}

/**
 * Workerが問題点の先頭に付ける位置（triggers[0]. や triggers[0].actions[1]. の形。番号は0始まり）。
 *
 * 条件そのものへの問題点（triggers[0].conditions[0]: …）は項目名が続かないので、後ろの . は付かないこともある。
 */
const PROBLEM_POSITION = /^triggers\[(\d+)\]\.(?:(actions|conditions)\[(\d+)\](\.)?)?/

/** 入れ子の位置（actions・conditions）の日本語の呼び名 */
const NESTED_LABELS: Readonly<Record<string, string>> = { actions: '動作', conditions: '条件' }

/** Workerが返した問題点の位置を、画面に振ってある番号（1始まり）に読み替える */
export const describeProblem = (problem: string): string =>
  problem.replace(PROBLEM_POSITION, (_, trigger: string, nested: string | undefined, index: string | undefined, dot: string | undefined) => {
    const position = `${Number(trigger) + 1}番目のトリガーの `
    if (nested === undefined || index === undefined) return position
    // 項目名が続く（. があった）ときだけ、読みやすさのために「の」で続ける
    return `${position}${Number(index) + 1}つ目の${NESTED_LABELS[nested]}${dot === undefined ? '' : 'の '}`
  })
