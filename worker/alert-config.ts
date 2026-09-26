/**
 * アラートの設定
 *
 * 「どのきっかけで、何をするか」（トリガー）の一覧を、管理画面から受け取って検証し、ストア（KV）に保存する。
 * トリガーは「既定メニューの項目」（kind と、そのメニューが要求するパラメータ）と「動作」（actions）からなる。
 * イベント種別と条件の組み合わせはメニュー項目が決めるので、ここでは扱わない（worker/trigger-menu.ts）。
 * 動作は種類ごとに実行者が違う。
 * - alert: オーバーレイが素材を再生する。照合はWorkerが行い（alert-event.ts の alertFor）、素材のURLを付けたアラートを返す
 * - chat: Workerがbotとしてチャットへ送る（オーバーレイには渡さない。オーバーレイに送信の役目を持たせないため）
 * - announce: Workerがbotとしてアナウンス（色の付いた帯）を送る。botがモデレーターにされている必要がある
 * - aiChat: Workerが配信者の指示とその人の記録からLLMに文面を作らせ、botとしてチャットへ送る（worker/ai-chat.ts）
 * - shoutout: Workerがbotとしてシャウトアウト（相手の配信者を紹介するTwitch組み込みの機能）を送る。
 *   紹介する相手が配信者であるレイドのトリガーにだけ置ける
 *
 * メニュー項目は13種類（worker/trigger-menu.ts の TRIGGER_KINDS）で、そのうちチャットの発言を対象にするものは
 * botを接続しているときだけ通知が届く。広告の終了（adBreakEnd）だけはTwitchから届く通知ではなく、
 * 広告の開始の通知に入っている長さからWorkerが作る擬似イベントである（worker/ad-break-timer.ts）。
 *
 * 注意: 検証は最初の1件で止めず、問題点をすべて集めてから拒否する（管理画面で一度に直せるようにする）。
 * 注意: 既定メニューにする前の保存内容（event と conditions を直接持つ形）は読み替えず、読み込みで失敗させる（Fail-Fast）。
 *   トリガーは数件なので、管理画面から入れ直してもらうほうが暗黙の読み替えを増やさずに済む。
 */
import type { KeyValueStore } from './store'
import { expandSource, TRIGGER_KINDS, type AlertEvent, type StoredCondition, type TriggerKind, type TriggerSource } from './trigger-menu'
import { ANNOUNCEMENT_COLORS, type AnnouncementColor } from './twitch'

const CONFIG_KEY = 'alert-config'

/** 動作の種類。同じ種類は1トリガーに1件まで */
export const ACTION_TYPES = ['alert', 'chat', 'announce', 'aiChat', 'shoutout'] as const

export type ActionType = (typeof ACTION_TYPES)[number]

const MAX_TRIGGERS = 100
const MIN_DURATION_SECONDS = 1
const MAX_DURATION_SECONDS = 60
const MAX_ALERT_MESSAGE_LENGTH = 200
/** チャット1通の上限（Twitchの POST /helix/chat/messages の制限）。アナウンスも同じ500文字で、合言葉（keyword）の上限にも使う */
const MAX_CHAT_MESSAGE_LENGTH = 500
/** aiChat の指示（配信者が書く文章）の上限。文面そのものではなく作り方の指示なので、チャット1通より長くてよい */
const MAX_AI_INSTRUCTION_LENGTH = 1000
/** 久しぶりの人（comeback）に指定できる日数の下限（1日）。0日だと毎回当てはまり、絞り込まないのと区別が付かない */
const MIN_RETURNING_DAYS = 1
/** 久しぶりの人（comeback）に指定できる日数の上限（1年）。これより長い間隔は「お久しぶり」として区別する意味が薄い */
const MAX_RETURNING_DAYS = 365
/** Twitchのユーザー名（login）の上限 */
const MAX_LOGIN_LENGTH = 25
/** 色を指定しなかったアナウンスの色（チャンネルの色） */
const DEFAULT_ANNOUNCEMENT_COLOR: AnnouncementColor = 'primary'

export type MediaKind = 'image' | 'video' | 'audio'

/** オーバーレイに素材を出す動作 */
export interface StoredAlertAction {
  type: 'alert'
  mediaId: string
  /** 素材の種類。保存時にサーバーが素材から調べて書き足す（オーバーレイへ渡すたびに素材を調べ直さないため） */
  mediaKind: MediaKind
  durationSeconds: number
  /** 音量（0〜1） */
  volume: number
  /** 表示する文言。イベント種別ごとの差し込み語（{user} など）が置き換わる。空文字なら文言を出さない */
  message: string
}

/** botとしてチャットへ送る動作 */
export interface StoredChatAction {
  type: 'chat'
  /** 送る文言。アラートと違い、送るものがないので空文字は許さない */
  message: string
}

/**
 * botとしてチャットへアナウンス（色の付いた帯で出る発言）を送る動作。
 *
 * 通常のチャット送信と違い、botがこのチャンネルのモデレーターにされていることと、
 * moderator:manage:announcements の認可が要る。
 */
export interface StoredAnnounceAction {
  type: 'announce'
  /** 送る文言。チャットと同じく、送るものがないので空文字は許さない */
  message: string
  /** 帯の色 */
  color: AnnouncementColor
}

/**
 * LLMに文面を作らせて、botとしてチャットへ送る動作。
 *
 * 固定文言の chat と違い、送る文言そのものではなく「どう書くか」の指示を持つ。
 * その人の記録（viewers のメモ・来訪の履歴）と発言の本文を材料に、Workerが実行のたびに文面を作る（worker/ai-chat.ts）。
 * 同じトリガーに chat と並べることは許さない（同じ発言に2通返ってしまうため。parseActions で拒む）。
 */
export interface StoredAiChatAction {
  type: 'aiChat'
  /** 配信者が書く、文面の作り方の指示。空文字では作りようがないので許さない */
  instruction: string
}

/**
 * botとしてシャウトアウト（相手の配信者を紹介するTwitch組み込みの機能）を送る動作。
 *
 * 紹介する相手はイベントの中身から決まる（レイドならレイドしてきた配信者）ので、配信者が決める項目を持たない。
 * 置けるのはレイドのトリガーだけである（ほかのイベントの相手は配信者とは限らず、紹介しても意味を持たない）。
 * アナウンスと同じく、botがこのチャンネルのモデレーターにされていることと moderator:manage:shoutouts の認可が要る。
 */
export interface StoredShoutoutAction {
  type: 'shoutout'
}

export type StoredAction = StoredAlertAction | StoredChatAction | StoredAnnounceAction | StoredAiChatAction | StoredShoutoutAction

/**
 * 保存するトリガー。
 *
 * 既定メニューの項目（kind とそのパラメータ）と、動作の一覧からなる。
 * イベント種別と条件は kind から決まるので保存しない（resolveTrigger が展開する）。
 */
export type StoredTrigger = TriggerSource & { actions: StoredAction[] }

/**
 * 照合に使う形へ展開したトリガー。
 *
 * worker/alert-event.ts の matches はこの形だけを見る。メニュー項目を増やしても照合は書き換えずに済む。
 */
export interface ResolvedTrigger {
  /** どのメニュー項目から展開したか。挨拶の段（GREETING_KINDS）の絞り込みに要る */
  kind: TriggerKind
  event: AlertEvent
  conditions: StoredCondition[]
  actions: StoredAction[]
}

/** 保存したトリガーを、照合に使う形（イベント種別と条件のリスト）へ展開する */
export const resolveTrigger = (trigger: StoredTrigger): ResolvedTrigger => ({
  kind: trigger.kind,
  ...expandSource(trigger),
  actions: trigger.actions,
})

export interface AlertConfig {
  triggers: StoredTrigger[]
}

export const EMPTY_CONFIG: AlertConfig = { triggers: [] }

/**
 * 設定の内容に問題がある。problems にすべての問題点を持つ。
 *
 * アラートの設定とチャットボットのコマンドの設定で使い回すため、何の設定かを subject で受け取る。
 */
export class ConfigError extends Error {
  override name = 'ConfigError'

  /** @param subject 何の設定か（例: アラートの設定） */
  constructor(
    readonly subject: string,
    readonly problems: readonly string[],
  ) {
    super(`${subject}に問題があります: ${problems.join(' / ')}`)
  }
}

/** このファイルが扱う設定の名前 */
const SUBJECT = 'アラートの設定'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isActionType = (value: unknown): value is ActionType => ACTION_TYPES.some((type) => type === value)

const isTriggerKind = (value: unknown): value is TriggerKind => TRIGGER_KINDS.some((kind) => kind === value)

const isAnnouncementColor = (value: unknown): value is AnnouncementColor => ANNOUNCEMENT_COLORS.some((color) => color === value)

const isNumberBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

const isIntegerWithin = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

const isStringWithin = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== ''

/**
 * トリガーのきっかけ（既定メニューの項目とそのパラメータ）を検証して保存用の形にする。
 *
 * メニュー項目ごとに要求するパラメータが違うので、kind で分けて確かめる。
 * パラメータを持たない項目（フォローされた・レイドされたなど）は、kind が合っていればそのまま通す。
 *
 * @param at 問題点に付ける位置（例: triggers[0]）
 * @param problems 見つけた問題点の記録先（最初の1件で止めず、すべて集めるため呼び出し側と共有する）
 * @returns 問題があれば null
 */
const parseSource = (candidate: Record<string, unknown>, at: string, problems: string[]): TriggerSource | null => {
  const { kind } = candidate
  if (!isTriggerKind(kind)) {
    problems.push(`${at}.kind: ${TRIGGER_KINDS.join(' / ')} のいずれかを指定してください`)
    return null
  }

  switch (kind) {
    // パラメータを持たないメニュー項目。そのイベントが起きればいつでも当てはまる
    case 'newViewer':
    case 'welcome':
    case 'everyMessage':
    case 'follow':
    case 'subscribe':
    case 'resubscribe':
    case 'raid':
      return { kind }
    case 'comeback': {
      const { days } = candidate
      // 日数は整数で受け取る（画面の入力欄も日数なので、時間単位の細かさは持たせない）
      if (!isIntegerWithin(days, MIN_RETURNING_DAYS, MAX_RETURNING_DAYS)) {
        problems.push(`${at}.days: ${MIN_RETURNING_DAYS}〜${MAX_RETURNING_DAYS}の整数（日数）で指定してください`)
        return null
      }
      return { kind, days }
    }
    case 'fromUser': {
      const { login } = candidate
      if (!isStringWithin(login, 1, MAX_LOGIN_LENGTH)) {
        problems.push(`${at}.login: 1〜${MAX_LOGIN_LENGTH}文字のTwitchのユーザー名で指定してください`)
        return null
      }
      return { kind, login }
    }
    case 'keyword': {
      const { contains } = candidate
      // 空文字はすべての発言に当てはまってしまう（絞り込みにならない）ので、1文字以上を求める
      if (!isStringWithin(contains, 1, MAX_CHAT_MESSAGE_LENGTH)) {
        problems.push(`${at}.contains: 1〜${MAX_CHAT_MESSAGE_LENGTH}文字の文字列で指定してください`)
        return null
      }
      return { kind, contains }
    }
    case 'reward': {
      const { rewardId } = candidate
      // null は「すべての報酬」を表す。空文字は報酬を選べていない状態なので拒否する
      if (rewardId !== null && !isNonEmptyString(rewardId)) {
        problems.push(`${at}.rewardId: 報酬IDの文字列か、すべての報酬を対象にする null で指定してください`)
        return null
      }
      return { kind, rewardId }
    }
    case 'adBreakBegin':
    case 'adBreakEnd': {
      const { automatic } = candidate
      // null は「自動・手動のどちらでも」を表す
      if (automatic !== null && typeof automatic !== 'boolean') {
        problems.push(`${at}.automatic: true（自動で入った広告）か false（手動で打った広告）、または自動・手動を問わない null で指定してください`)
        return null
      }
      return { kind, automatic }
    }
  }
}

/**
 * 動作1件を検証して保存用の形にする。
 *
 * @param at 問題点に付ける位置（例: triggers[0].actions[1]）
 * @param problems 見つけた問題点の記録先（最初の1件で止めず、すべて集めるため呼び出し側と共有する）
 * @returns 問題があれば null
 */
const parseAction = (
  candidate: unknown,
  at: string,
  kindOfMedia: (mediaId: string) => MediaKind | null,
  problems: string[],
): StoredAction | null => {
  if (!isRecord(candidate)) {
    problems.push(`${at}: オブジェクトで指定してください`)
    return null
  }
  const { type } = candidate
  if (!isActionType(type)) {
    problems.push(`${at}.type: ${ACTION_TYPES.join(' / ')} のいずれかを指定してください`)
    return null
  }

  // シャウトアウトは配信者が決める項目を持たないので、種類が分かれば読み取れる
  // （レイドのトリガーにだけ置けるという決まりは、きっかけも見える parseAlertConfig で確かめる）
  if (type === 'shoutout') return { type }

  if (type === 'aiChat') {
    const { instruction } = candidate
    if (!isStringWithin(instruction, 1, MAX_AI_INSTRUCTION_LENGTH)) {
      problems.push(`${at}.instruction: 1〜${MAX_AI_INSTRUCTION_LENGTH}文字の文字列で指定してください`)
      return null
    }
    return { type, instruction }
  }

  if (type === 'chat' || type === 'announce') {
    const { message } = candidate
    const messageOk = isStringWithin(message, 1, MAX_CHAT_MESSAGE_LENGTH)
    if (!messageOk) problems.push(`${at}.message: 1〜${MAX_CHAT_MESSAGE_LENGTH}文字の文字列で指定してください`)
    if (type === 'chat') return messageOk ? { type, message } : null

    // 色は省略できる（既定はチャンネルの色）。指定があればTwitchが受け付ける5色に限る
    const { color } = candidate
    const colorOk = color === undefined || isAnnouncementColor(color)
    if (!colorOk) problems.push(`${at}.color: ${ANNOUNCEMENT_COLORS.join(' / ')} のいずれかを指定してください`)

    if (messageOk && colorOk) return { type, message, color: color ?? DEFAULT_ANNOUNCEMENT_COLOR }
    return null
  }

  const { mediaId, durationSeconds, volume, message } = candidate
  const mediaKind = typeof mediaId === 'string' ? kindOfMedia(mediaId) : null

  // 判定結果を変数に置くのは、問題点の記録と、下の if での型の絞り込みの両方に使うため
  const mediaOk = typeof mediaId === 'string' && mediaKind !== null
  const durationOk = isNumberBetween(durationSeconds, MIN_DURATION_SECONDS, MAX_DURATION_SECONDS)
  const volumeOk = isNumberBetween(volume, 0, 1)
  const messageOk = isStringWithin(message, 0, MAX_ALERT_MESSAGE_LENGTH)

  if (!mediaOk) problems.push(`${at}.mediaId: 素材「${String(mediaId)}」が存在しません`)
  if (!durationOk) problems.push(`${at}.durationSeconds: ${MIN_DURATION_SECONDS}〜${MAX_DURATION_SECONDS} の数値で指定してください`)
  if (!volumeOk) problems.push(`${at}.volume: 0〜1 の数値で指定してください`)
  if (!messageOk) problems.push(`${at}.message: ${MAX_ALERT_MESSAGE_LENGTH}文字以内の文字列で指定してください`)

  if (mediaOk && durationOk && volumeOk && messageOk) return { type, mediaId, mediaKind, durationSeconds, volume, message }
  return null
}

/**
 * 動作の一覧を検証して保存用の形にする。1件以上あり、同じ種類が重複しないことを確かめる。
 *
 * 同じ種類を1件までにするのは、オーバーレイへは「1トリガー = 1アラート」の平坦な形で渡すため
 * （オーバーレイは最初に一致したトリガーだけを再生するので、2件目は出ないまま設定だけが残ってしまう）。
 *
 * @returns 問題があれば null
 */
const parseActions = (candidate: unknown, at: string, kindOfMedia: (mediaId: string) => MediaKind | null, problems: string[]): StoredAction[] | null => {
  if (!Array.isArray(candidate) || candidate.length === 0) {
    problems.push(`${at}.actions: 1件以上の配列で指定してください`)
    return null
  }

  const actions = candidate.flatMap((action: unknown, index): StoredAction[] => {
    const parsed = parseAction(action, `${at}.actions[${index}]`, kindOfMedia, problems)
    return parsed === null ? [] : [parsed]
  })

  const duplicated = ACTION_TYPES.filter((type) => actions.filter((action) => action.type === type).length > 1)
  for (const type of duplicated) problems.push(`${at}.actions: 同じ種類の動作（${type}）は1件までにしてください`)

  // 固定文言（chat）とLLMの文面（aiChat）はどちらもbotの発言として送られるので、並べると同じ発言に2通返ってしまう
  const conflicting = actions.some((action) => action.type === 'chat') && actions.some((action) => action.type === 'aiChat')
  if (conflicting) problems.push(`${at}.actions: chat と aiChat は同じトリガーに並べられません（同じ発言に2通返ってしまうため）、どちらか一方にしてください`)

  return actions.length === candidate.length && duplicated.length === 0 && !conflicting ? actions : null
}

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @param kindOfMedia 素材IDから種類を引く。素材が存在しなければ null
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseAlertConfig = (input: unknown, kindOfMedia: (mediaId: string) => MediaKind | null): AlertConfig => {
  if (!isRecord(input) || !Array.isArray(input.triggers)) throw new ConfigError(SUBJECT, ['triggers: 配列で指定してください'])
  if (input.triggers.length > MAX_TRIGGERS) throw new ConfigError(SUBJECT, [`triggers: ${MAX_TRIGGERS}件以内にしてください`])

  const problems: string[] = []
  const triggers = input.triggers.flatMap((candidate: unknown, index): StoredTrigger[] => {
    const at = `triggers[${index}]`
    if (!isRecord(candidate)) {
      problems.push(`${at}: オブジェクトで指定してください`)
      return []
    }
    // きっかけと動作の両方を確かめてから組み立てる（片方で止めず、問題点をすべて集めるため）
    const source = parseSource(candidate, at, problems)
    const actions = parseActions(candidate.actions, at, kindOfMedia, problems)

    // シャウトアウトは相手が配信者であることを前提にするので、レイド以外のきっかけには置かせない
    const hasShoutout = actions !== null && actions.some((action) => action.type === 'shoutout')
    const shoutoutOk = !hasShoutout || source === null || source.kind === 'raid'
    if (!shoutoutOk) problems.push(`${at}.actions: シャウトアウト（shoutout）はレイドのトリガーにだけ置けます`)

    if (source !== null && actions !== null && shoutoutOk) return [{ ...source, actions }]
    return []
  })

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { triggers }
}

export const saveAlertConfig = (store: KeyValueStore, config: AlertConfig): Promise<void> => store.put(CONFIG_KEY, JSON.stringify(config))

/**
 * 保存されているトリガーが、いまの形（既定メニューの項目と動作のリストを持つ）かどうか。
 *
 * 保存時に検証済みの内容しか書き込まないため、ここではメニュー項目の名前と動作の形だけを確かめる。
 * 既定メニューにする前の形（event と conditions を直接持つ）や、動作に分ける前の形はここで弾かれる。
 */
const hasCurrentShape = (value: unknown): value is StoredTrigger => isRecord(value) && isTriggerKind(value.kind) && Array.isArray(value.actions)

/**
 * 読めなかったトリガーの問題点。何が保存されているのかを読み取れるよう、見つかった項目の名前を並べる。
 *
 * 復旧の手だても添える。管理画面（GET /api/admin/config）もこの読み出しを通るため、画面から直せない
 * （KVの設定を消せば、トリガーなしの状態から入れ直せる）。
 */
const unreadableProblem = (candidate: unknown, at: string): string => {
  const found = isRecord(candidate) ? Object.keys(candidate).join('・') : typeof candidate
  return `${at}: 保存されているトリガーが古い形です（見つかった項目: ${found}）。KVの ${CONFIG_KEY} を消してから入れ直してください`
}

/**
 * 保存済みの設定を読む。未保存ならトリガーなしの設定を返す。
 *
 * 注意: 古い形で保存されていたら、黙って読み替えずにエラーにする（Fail-Fast）。開発中で後方互換を保つ必要がないため、
 * 暗黙の読み替えを増やさず、KVの設定を消して入れ直す方針を採る。
 *
 * @throws ConfigError 保存されている内容がいまの形でない場合
 */
export const loadAlertConfig = async (store: KeyValueStore): Promise<AlertConfig> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return EMPTY_CONFIG

  const config: unknown = JSON.parse(text)
  if (!isRecord(config) || !Array.isArray(config.triggers)) throw new ConfigError(SUBJECT, ['保存されている設定に triggers の配列がありません'])

  const triggers = config.triggers.map((candidate: unknown, index): StoredTrigger => {
    if (!hasCurrentShape(candidate)) throw new ConfigError(SUBJECT, [unreadableProblem(candidate, `triggers[${index}]`)])
    return candidate
  })
  return { triggers }
}

/**
 * 動作を取り出せるトリガー。
 *
 * 動作の取り出しは、保存した形（既定メニューの項目を持つ）と展開した形（イベント種別と条件を持つ）の
 * どちらからも行うので、両方を受け取れるようにする。
 */
type WithActions = StoredTrigger | ResolvedTrigger

/** トリガーからチャットに送る動作を取り出す。なければ null */
export const chatActionOf = (trigger: WithActions): StoredChatAction | null =>
  trigger.actions.find((action): action is StoredChatAction => action.type === 'chat') ?? null

/** トリガーからLLMに文面を作らせてチャットへ送る動作を取り出す。なければ null */
export const aiChatActionOf = (trigger: WithActions): StoredAiChatAction | null =>
  trigger.actions.find((action): action is StoredAiChatAction => action.type === 'aiChat') ?? null

/** トリガーからアナウンスを送る動作を取り出す。なければ null */
export const announceActionOf = (trigger: WithActions): StoredAnnounceAction | null =>
  trigger.actions.find((action): action is StoredAnnounceAction => action.type === 'announce') ?? null

/** トリガーからシャウトアウトを送る動作を取り出す。なければ null */
export const shoutoutActionOf = (trigger: WithActions): StoredShoutoutAction | null =>
  trigger.actions.find((action): action is StoredShoutoutAction => action.type === 'shoutout') ?? null

/** トリガーからアラートを出す動作を取り出す。なければ null */
export const alertActionOf = (trigger: WithActions): StoredAlertAction | null =>
  trigger.actions.find((action): action is StoredAlertAction => action.type === 'alert') ?? null

/** 素材をオーバーレイから読むためのパス。キーが違えばWorkerが拒否する */
export const mediaPath = (mediaId: string, overlayKey: string): string =>
  `/api/media/${encodeURIComponent(mediaId)}?key=${encodeURIComponent(overlayKey)}`
