/**
 * 入力欄と保存形式の変換
 *
 * トリガーは既定メニューの項目（kind）と、その項目が要求するパラメータ1つからなる。配信者はイベント種別と条件を
 * 自由に組み合わせず、メニューから選ぶ（このツールは汎用のノーコード自動化を目指していないため）。
 * 入力欄の値はすべて文字列で、音量は 0〜100 の百分率で見せる。Workerへ送る形（音量は 0〜1、日数は数、
 * 「絞り込まない」は null）との行き来と、OBSに貼るURL・メニューの並び・選択肢や大きさの文言の組み立てを受け持つ。
 * DOMには触れない。
 *
 * 注意: 値の範囲（表示時間は1〜60秒など）の検証はWorkerが行い、問題点をまとめて返す。ここでは数として読めるかだけを確かめる。
 * 注意: メニュー項目ごとのパラメータは、入力欄ではすべて平たく持つ（動作の入力欄と同じ持ち方）。
 *   Workerへ送るのは、選んでいるメニュー項目が要求するものだけである（選び直す前の値を引きずらない）。
 */
import {
  ANNOUNCEMENT_COLORS,
  type ActionInput,
  type AlertEvent,
  type AnnouncementColor,
  type MediaItem,
  type Reward,
  type StoredTrigger,
  type TriggerInput,
  type TriggerKind,
  type TriggerSource,
} from './api'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const CHAT_MESSAGE = 'channel.chat.message'
const AD_BREAK_BEGIN = 'channel.ad_break.begin'
const AD_BREAK_END = 'channel.ad_break.end'
const ALERTS_PATH = '/alerts/'
const PERCENT = 100
const BYTES_PER_UNIT = 1024
/** 報酬を絞り込まない（すべての報酬が対象）ことを表す選択肢の値。Workerへは null として送る */
const ALL_REWARDS = ''
/** 広告を自動・手動で絞り込まないことを表す選択肢の値。Workerへは null として送る */
const ANY_AD_BREAK = ''
/** 新しく足したトリガーと、アラートを外したトリガーの表示時間の既定値（秒） */
const DEFAULT_DURATION_SECONDS = 5
/** 久しぶりの人の発言に入れる日数の既定値（約1か月） */
const DEFAULT_RETURNING_DAYS = 30
/** アナウンスを使わないトリガーの色の既定値（チャンネルの色） */
const DEFAULT_ANNOUNCEMENT_COLOR: AnnouncementColor = 'primary'

/** 素材の種類の日本語のラベル */
export const kindLabels: Readonly<Record<MediaItem['kind'], string>> = { image: '画像', video: '動画', audio: '音声' }

/** アナウンスの色の日本語のラベル */
const COLOR_LABELS: Readonly<Record<AnnouncementColor, string>> = {
  primary: 'チャンネルの色',
  blue: '青',
  green: '緑',
  orange: 'オレンジ',
  purple: '紫',
}

/** アナウンスの色の選択肢 */
export const colorOptions: readonly SelectOption[] = ANNOUNCEMENT_COLORS.map((color) => ({ value: color, label: COLOR_LABELS[color] }))

/**
 * メニュー項目の日本語の名前。
 *
 * 「決まった言葉を含む発言」は部分一致なので、「文面」だけにせず「含む」と書く
 * （「文面」だけでは、発言全体がその文言と同じときに当てはまる（完全一致）と読めてしまう）。
 */
const MENU_LABELS: Readonly<Record<TriggerKind, string>> = {
  newViewer: '初めて来た人の発言',
  comeback: '久しぶりの人の発言',
  welcome: 'その配信で最初の発言',
  everyMessage: 'すべての発言',
  keyword: '決まった言葉を含む発言',
  fromUser: '決まった人の発言',
  reward: 'チャンネルポイントが交換された',
  follow: 'フォローされた',
  subscribe: 'サブスクされた（新規）',
  resubscribe: 'サブスクの継続メッセージが届いた',
  raid: 'レイドされた',
  adBreakBegin: '広告が始まった',
  adBreakEnd: '広告が終わった',
}

/** メニュー項目の日本語の名前。画面の見出しと要約で使う */
export const menuLabel = (kind: TriggerKind): string => MENU_LABELS[kind]

export interface MenuPhase {
  kind: TriggerKind
  /**
   * 効果のまとまりに付ける見出し。イベント種別を1つしか持たない項目では null（まとまりを分けない）。
   */
  heading: string | null
  /** 折りたたんだ見出しで、効果のバッジがどちらのときのものかを示す短い名前。heading が null なら null */
  summary: string | null
}

export interface MenuItem {
  /** その項目を代表するイベント種別。一覧の並び順と、絞り込みのパラメータの出し分けに使う */
  kind: TriggerKind
  /**
   * 1つの枠でまとめて設定するイベント種別。ふつうは1つで、広告だけが開始と終了の2つを持つ。
   *
   * 効果は種別ごとに分けて持つが、**絞り込みのパラメータは種別をまたいで共通**である
   * （広告の「自動で入ったものだけ」を開始と終了で別々に選べても、食い違った設定に意味がないため）。
   */
  phases: readonly MenuPhase[]
  label: string
  /** その項目が何をきっかけにするかの補足。一覧の項目に小さく添える */
  description: string
  /**
   * 1つの項目の中に複数の設定を持てるか。addLabel があるかどうかで決まる（食い違わないように導出する）。
   *
   * 絞り込みのパラメータが「別のもの」を指す項目（報酬・ユーザー名・言葉・日数・広告の種別）だけ真になる。
   * 報酬ごとに違う効果を付けるのは主な使い方なので、1行に限ると使えないためである。
   * パラメータを持たない項目は常に1行で、効果をすべて外した状態が「何も起きない」を表す。
   */
  multiple: boolean
  /** 設定を足すボタンに出す文言。複数持てない項目は null */
  addLabel: string | null
}

export interface MenuGroup {
  label: string
  /** その区分の読み方。挨拶が排他であることのような、項目ごとには書けない約束を置く */
  description: string | null
  items: readonly MenuItem[]
}

const item = (kind: TriggerKind, description: string, addLabel: string | null = null): MenuItem => ({
  kind,
  phases: [{ kind, heading: null, summary: null }],
  label: MENU_LABELS[kind],
  description,
  multiple: addLabel !== null,
  addLabel,
})

/**
 * 広告の項目。開始と終了を1つの枠にまとめる。
 *
 * 別々の項目として並べていたころは、同じ絞り込み（自動・手動）を2か所で選ぶことになり、
 * 食い違った設定も作れてしまった。配信者から見れば「広告が入った」という1つの出来事なので、
 * 枠を1つにして、効果だけを始まったとき・終わったときに分ける。
 */
const AD_BREAK_ITEM: MenuItem = {
  kind: 'adBreakBegin',
  phases: [
    { kind: 'adBreakBegin', heading: '広告が始まったときの効果', summary: '開始' },
    { kind: 'adBreakEnd', heading: '広告が終わったときの効果', summary: '終了' },
  ],
  label: '広告',
  description: '配信中に広告が入ったとき。始まり・終わりで別々の効果を付けられる',
  multiple: false,
  addLabel: null,
}

/**
 * 画面に固定で並べるトリガーの一覧。
 *
 * 配信者はトリガーを作るのではなく、**並んでいる出来事に効果を足していく**。
 * そのため項目の増減は配信者の操作では起きず、この一覧がそのまま画面の構成になる。
 *
 * 区分は配信者から見た関心ごと（チャットの書き込みか、それ以外のイベントか）で分ける。
 * 並びは絞り込みの細かいものからにして、「誰かが発言した」はチャットの区分の最後に置く。
 * 当てはまった行はすべて実行されるので動く・動かないは順番に左右されないが、
 * 何にでも当てはまる行が先頭にあると、一覧が読みにくくなるためである。
 */
export const menuGroups: readonly MenuGroup[] = [
  {
    label: 'チャット',
    // 上の3つは「挨拶」で、ひとつの発言に当てはまるのは最も上のものだけである
    // （初めて来た人の発言は必ず「その配信で最初の発言」でもあるため、そうしないと挨拶が二重に飛ぶ）
    description: '上の3つ（初めて来た人・久しぶりの人・その配信で最初）は、当てはまるうち一番上のものだけが動く。',
    items: [
      item('newViewer', 'このチャンネルで初めての発言'),
      item('comeback', '決めた日数以上ぶりの発言'),
      item('welcome', 'その配信での1回目の発言'),
      item('everyMessage', '発言があるたび。挨拶とも同時に動く'),
      item('keyword', '決めた言葉を含む発言', '言葉を足す'),
      item('fromUser', '決めた人の発言', 'ユーザーを足す'),
    ],
  },
  {
    label: 'イベント',
    description: null,
    items: [
      item('reward', 'チャンネルポイントの交換。報酬ごとに違う効果を付けられる', '報酬を足す'),
      item('follow', '新しくフォローされたとき'),
      item('subscribe', '新しくサブスクされたとき'),
      item('resubscribe', '継続のサブスクがメッセージ付きで届いたとき'),
      item('raid', 'ほかの配信からレイドで来たとき'),
      AD_BREAK_ITEM,
    ],
  },
]

/** 一覧に並ぶ順のメニュー項目（区分をまたいで平らにしたもの） */
const MENU_ITEMS: readonly MenuItem[] = menuGroups.flatMap((group) => group.items)

/**
 * トリガー1件分の入力欄の値。
 *
 * メニュー項目のパラメータ（日数・ユーザー名・言葉・報酬・広告の絞り込み）と、動作の入力欄を平たく持つ。
 * 選んでいるメニュー項目が使わないパラメータも値を保っておき、選び直しても入れ直さずに済むようにする
 * （Workerへ送るのは、選んでいる項目が要求するものだけである）。
 * 日数を文字列で持つのは、数で持つと入力欄を空にした瞬間に 0 日へ変わってしまい、配信者が入れ直せなくなるため
 * （表示時間・音量の入力欄を文字列で持っているのと同じ理由）。
 */
export interface TriggerDraft {
  kind: TriggerKind
  /** 対象の報酬ID。空文字はすべての報酬（絞り込まない） */
  rewardId: string
  /** 対象のTwitchのユーザー名 */
  login: string
  /** 発言に含まれる言葉 */
  contains: string
  /** 前の発言から空いた日数 */
  days: string
  /** 広告の絞り込み。'true'（自動）・'false'（手動）・空文字（どちらでも） */
  automatic: string
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
  /** LLMに文面を作らせて、botとしてチャットへ送るか（固定文言の chatEnabled とは同時に選べない） */
  aiChatEnabled: boolean
  /** 配信者が書く、文面の作り方の指示 */
  aiChatInstruction: string
  /** botとしてシャウトアウト（相手の配信者を紹介する）を送るか。レイドの項目でだけ選べる */
  shoutoutEnabled: boolean
}

/**
 * その項目にシャウトアウトを置けるか。
 *
 * 置けるのはレイドだけである（Workerも保存時にそれ以外を拒む）。ほかのイベントの相手は配信者とは限らず、
 * 紹介しても意味を持たないためで、すべての項目に出すと意味のない組み合わせを作れてしまう。
 */
export const supportsShoutout = (kind: TriggerKind): boolean => kind === 'raid'

export interface SelectOption {
  value: string
  label: string
}

/** メニュー項目が対象にするイベント種別。差し込み語がどれになるかはこれで決まる（worker/trigger-menu.ts と同じ対応） */
const EVENT_OF_KIND: Readonly<Record<TriggerKind, AlertEvent>> = {
  newViewer: CHAT_MESSAGE,
  comeback: CHAT_MESSAGE,
  welcome: CHAT_MESSAGE,
  everyMessage: CHAT_MESSAGE,
  keyword: CHAT_MESSAGE,
  fromUser: CHAT_MESSAGE,
  reward: REDEMPTION,
  follow: 'channel.follow',
  subscribe: 'channel.subscribe',
  resubscribe: 'channel.subscription.message',
  raid: 'channel.raid',
  adBreakBegin: AD_BREAK_BEGIN,
  adBreakEnd: AD_BREAK_END,
}

/**
 * イベント種別によらず使える差し込み語。
 *
 * 配信の「これまでのあらすじ」は通知の中身ではなく配信の状態から決まるので、どのトリガーの文言にも書ける
 * （差し込みは worker/alert-event.ts の fillMessage）。
 */
const COMMON_PLACEHOLDERS = ['{summary}'] as const

/** イベント種別ごとに、文言で使える差し込み語 */
const EVENT_PLACEHOLDERS: Readonly<Record<AlertEvent, readonly string[]>> = {
  [REDEMPTION]: ['{user}', '{reward}', ...COMMON_PLACEHOLDERS],
  'channel.follow': ['{user}', ...COMMON_PLACEHOLDERS],
  'channel.subscribe': ['{user}', '{tier}', ...COMMON_PLACEHOLDERS],
  'channel.subscription.message': ['{user}', '{tier}', '{months}', ...COMMON_PLACEHOLDERS],
  'channel.raid': ['{user}', '{viewers}', ...COMMON_PLACEHOLDERS],
  [CHAT_MESSAGE]: ['{user}', '{message}', ...COMMON_PLACEHOLDERS],
  // {duration} は広告の長さ（秒）。{user} は広告を打った人で、自動で入った広告では配信者自身になる
  [AD_BREAK_BEGIN]: ['{user}', '{duration}', ...COMMON_PLACEHOLDERS],
  [AD_BREAK_END]: ['{user}', '{duration}', ...COMMON_PLACEHOLDERS],
}

/** そのメニュー項目の文言で使える差し込み語。選んだ項目に存在しない語は置き換わらないため、画面で知らせる */
export const placeholdersFor = (kind: TriggerKind): readonly string[] => EVENT_PLACEHOLDERS[EVENT_OF_KIND[kind]]

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
  if (draft.aiChatEnabled) actions.push({ type: 'aiChat', instruction: draft.aiChatInstruction })
  if (draft.shoutoutEnabled) actions.push({ type: 'shoutout' })
  return actions
}

/**
 * 入力欄の値を、Workerへ送るきっかけの形にする。選んでいるメニュー項目が要求するパラメータだけを送る。
 *
 * @throws 日数が数として読めない場合（空欄のまま保存しようとしたときなど）
 */
const toSource = (draft: TriggerDraft): TriggerSource => {
  switch (draft.kind) {
    case 'comeback':
      return { kind: draft.kind, days: toNumber(draft.days, '日数') }
    case 'fromUser':
      return { kind: draft.kind, login: draft.login }
    case 'keyword':
      return { kind: draft.kind, contains: draft.contains }
    case 'reward':
      return { kind: draft.kind, rewardId: draft.rewardId === ALL_REWARDS ? null : draft.rewardId }
    case 'adBreakBegin':
    case 'adBreakEnd':
      return { kind: draft.kind, automatic: draft.automatic === ANY_AD_BREAK ? null : draft.automatic === 'true' }
    // パラメータを持たないメニュー項目
    default:
      return { kind: draft.kind }
  }
}

/**
 * 入力欄の値を、Workerへ送る形にする。
 *
 * 動作が1件もない場合も、そのまま送ってWorkerに問題点を返させる（画面とWorkerで検証を二重に持たないため）。
 *
 * @throws 表示時間・音量・日数が数として読めない場合
 */
export const toTriggerInput = (draft: TriggerDraft): TriggerInput => ({ ...toSource(draft), actions: toActions(draft) })

/** 動作を選んでいないときに入力欄へ残しておく既定値（画面で入れ直さずに済むように、形だけは保つ） */
const DEFAULT_ALERT_DRAFT = { mediaId: '', durationSeconds: String(DEFAULT_DURATION_SECONDS), volumePercent: String(PERCENT), message: '' }

/** どのメニュー項目でも使わないパラメータの既定値 */
const DEFAULT_PARAMS = { rewardId: ALL_REWARDS, login: '', contains: '', days: String(DEFAULT_RETURNING_DAYS), automatic: ANY_AD_BREAK }

/** 絞り込みのパラメータだけを取り出す。1つの項目が複数のイベント種別を持つとき、行をまたいで同じ値にするために使う */
const paramsOf = (draft: TriggerDraft): typeof DEFAULT_PARAMS => ({
  rewardId: draft.rewardId,
  login: draft.login,
  contains: draft.contains,
  days: draft.days,
  automatic: draft.automatic,
})

/** 保存済みのパラメータを入力欄の値に戻す。「絞り込まない」を表す null は空文字にする */
const toParams = (trigger: StoredTrigger): Partial<typeof DEFAULT_PARAMS> => {
  switch (trigger.kind) {
    case 'comeback':
      return { days: String(trigger.days) }
    case 'fromUser':
      return { login: trigger.login }
    case 'keyword':
      return { contains: trigger.contains }
    case 'reward':
      return { rewardId: trigger.rewardId ?? ALL_REWARDS }
    case 'adBreakBegin':
    case 'adBreakEnd':
      return { automatic: trigger.automatic === null ? ANY_AD_BREAK : String(trigger.automatic) }
    default:
      return {}
  }
}

/**
 * 保存済みのトリガーを入力欄の値に戻す。
 *
 * そのメニュー項目が使わないパラメータと、持っていない動作の欄は既定値で埋め、行わない印を付ける。
 */
export const toDraft = (trigger: StoredTrigger): TriggerDraft => {
  const alert = trigger.actions.find((action) => action.type === 'alert')
  const chat = trigger.actions.find((action) => action.type === 'chat')
  const announce = trigger.actions.find((action) => action.type === 'announce')
  const aiChat = trigger.actions.find((action) => action.type === 'aiChat')
  const shoutout = trigger.actions.find((action) => action.type === 'shoutout')

  return {
    kind: trigger.kind,
    ...DEFAULT_PARAMS,
    ...toParams(trigger),
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
    aiChatEnabled: aiChat !== undefined,
    aiChatInstruction: aiChat?.instruction ?? '',
    shoutoutEnabled: shoutout !== undefined,
  }
}

/**
 * メニューから選んだ項目で、新しいトリガーの入力欄の値を作る。
 *
 * 素材が1つでもあればアラートを出す動作を選んだ状態にし、選択欄が見せているとおりの素材（先頭）を選んでおく
 * （選んでいない状態で保存すると、選択欄には素材が見えているのにWorkerが拒む）。素材が1つもなければ、
 * アラートは出せないのでチャットに送る動作を選んだ状態にする。
 *
 * 報酬は絞り込まない状態（すべての報酬）で作る。どの報酬に絞るかは配信者にしか決められないうえ、
 * 先頭の報酬を勝手に選ぶと、選んだつもりのない報酬だけで動くトリガーができてしまう。
 */
export const createDraft = (kind: TriggerKind, media: readonly MediaItem[]): TriggerDraft => {
  const first = media[0]
  return {
    kind,
    ...DEFAULT_PARAMS,
    // 手で打った広告は配信者が自分で告知できるので、告知したいのはふつう自動で入った広告のほうである
    ...(kind === 'adBreakBegin' || kind === 'adBreakEnd' ? { automatic: 'true' } : {}),
    alertEnabled: first !== undefined,
    mediaId: first?.id ?? '',
    durationSeconds: String(DEFAULT_DURATION_SECONDS),
    volumePercent: String(PERCENT),
    message: '',
    chatEnabled: first === undefined,
    chatMessage: '',
    announceEnabled: false,
    announceMessage: '',
    announceColor: DEFAULT_ANNOUNCEMENT_COLOR,
    aiChatEnabled: false,
    aiChatInstruction: '',
    shoutoutEnabled: false,
  }
}

/**
 * 効果をひとつも持たない行を作る。
 *
 * パラメータを持たない項目は効果がなくても一覧に並ぶので、その行の初期値に使う。
 * 効果がひとつもない行は保存しないので（toTriggerInputs が外す）、「何も起きない」を表す。
 */
export const emptyDraft = (kind: TriggerKind): TriggerDraft => ({
  kind,
  ...DEFAULT_PARAMS,
  alertEnabled: false,
  ...DEFAULT_ALERT_DRAFT,
  chatEnabled: false,
  chatMessage: '',
  announceEnabled: false,
  announceMessage: '',
  announceColor: DEFAULT_ANNOUNCEMENT_COLOR,
  aiChatEnabled: false,
  aiChatInstruction: '',
  shoutoutEnabled: false,
})

/** その行が効果をひとつでも持つか。持たない行は何も起きないので保存しない */
export const hasAnyAction = (draft: TriggerDraft): boolean =>
  draft.alertEnabled || draft.chatEnabled || draft.announceEnabled || draft.aiChatEnabled || draft.shoutoutEnabled

/**
 * 保存済みの行に、パラメータを持たない項目の行を足し、一覧の並び順にそろえる。
 *
 * 画面の一覧は固定なので、効果がひとつも付いていない項目も行として並べる必要がある。
 * パラメータを持つ項目（報酬・ユーザー名・言葉・日数・広告）は配信者が足したぶんだけ並ぶので、ここでは足さない。
 * 同じ項目の中の並びは変えない（配信者が足した順に出す）。
 */
export const withFixedRows = (drafts: readonly TriggerDraft[]): TriggerDraft[] =>
  MENU_ITEMS.flatMap((menuItem) => {
    // 広告のように1つの項目が2つのイベント種別を持つことがあるので、種別ごとに行をそろえる
    const byPhase = menuItem.phases.map((phase) => drafts.filter((draft) => draft.kind === phase.kind))
    // 絞り込みは項目の中で共通なので、足りない種別の行を作るときは保存済みの行から引き継ぐ。
    // 既定値のまま作ると、広告の終了だけが保存されていたときに開始の行と食い違ったまま画面に出てしまう
    const stored = byPhase.flat()[0]
    return menuItem.phases.flatMap((phase, index) => {
      const rows = byPhase[index] ?? []
      if (rows.length > 0) return rows
      if (menuItem.multiple) return []
      const empty = emptyDraft(phase.kind)
      return [stored === undefined ? empty : { ...empty, ...paramsOf(stored) }]
    })
  })

/**
 * 画面の行を、Workerへ送るトリガーの一覧にする。効果をひとつも持たない行は送らない。
 *
 * 一覧は固定なので「何番目の行か」では場所が伝わらない。どの項目の設定かを文言に添える。
 *
 * @throws 表示時間・音量・日数が数として読めない場合
 */
export const toTriggerInputs = (drafts: readonly TriggerDraft[]): TriggerInput[] =>
  drafts.filter(hasAnyAction).map((draft) => {
    try {
      return toTriggerInput(draft)
    } catch (error) {
      throw new Error(`「${MENU_LABELS[draft.kind]}」の設定: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  })

/**
 * 報酬の選択肢を作る。
 *
 * 先頭は「すべての報酬」（絞り込まない）で、これが新しいトリガーの既定になる。
 *
 * @param selected いま選ばれている報酬ID。Twitchの一覧にない（削除された）報酬でも、黙って別の報酬に変わらないよう選択肢の先頭に残す
 */
export const rewardOptions = (rewards: readonly Reward[], selected: string): SelectOption[] => {
  const options = [
    { value: ALL_REWARDS, label: 'すべての報酬' },
    ...rewards.map((reward) => ({ value: reward.id, label: `${reward.title}（${reward.cost}pt）` })),
  ]
  if (options.some((option) => option.value === selected)) return options
  return [{ value: selected, label: `Twitchの一覧にない報酬（${selected}）` }, ...options]
}

/**
 * 折りたたんだ行の見出しに出す、メニュー項目のパラメータの文言。絞り込んでいなければ null（何も添えない）。
 *
 * メニュー項目の名前は添えない（項目の枠の見出しにすでに出ているため）。
 * Twitchの一覧にない報酬は、黙って省略せずに報酬IDをそのまま出す（設定を取り違えないため）。
 */
export const rowParamSummary = (draft: TriggerDraft, rewards: readonly Reward[]): string | null => {
  switch (draft.kind) {
    case 'reward':
      if (draft.rewardId === ALL_REWARDS) return 'すべての報酬'
      return rewards.find((reward) => reward.id === draft.rewardId)?.title ?? draft.rewardId
    case 'fromUser':
      return draft.login
    case 'keyword':
      return draft.contains
    // 日数は言葉を添えないと「30日」が間隔なのか回数なのか読み取れないので、単位ごと書く
    case 'comeback':
      return `${draft.days}日以上`
    // 真偽値そのままでは「自動: true」と読めてしまうので、どちらの広告かを言葉で書く
    case 'adBreakBegin':
    case 'adBreakEnd':
      if (draft.automatic === ANY_AD_BREAK) return null
      return draft.automatic === 'true' ? '自動で入った広告' : '配信者が手動で打った広告'
    default:
      return null
  }
}

/**
 * その行が持つ効果の名前。付けている順ではなく、いつも同じ並びで返す。
 *
 * 画面ではバッジとして1つずつ出し、絞り込みの文言（rowParamSummary）と見た目で分ける
 * （ひと続きの文にすると、効果が付いているかどうかを読み取るのに文末まで読むことになる）。
 * ひとつも持たない行は保存されず何も起きないので、空の配列を返して呼び出し側に「効果なし」と出させる。
 */
export const rowActionLabels = (draft: TriggerDraft): readonly string[] =>
  [
    draft.alertEnabled ? 'アラート' : null,
    draft.chatEnabled ? 'チャット' : null,
    draft.announceEnabled ? 'アナウンス' : null,
    draft.aiChatEnabled ? 'AIチャット' : null,
    draft.shoutoutEnabled ? 'シャウトアウト' : null,
  ].filter((label) => label !== null)

/** 素材の大きさを読みやすい単位で表す */
export const formatBytes = (size: number): string => {
  if (size < BYTES_PER_UNIT) return `${size} B`
  if (size < BYTES_PER_UNIT ** 2) return `${(size / BYTES_PER_UNIT).toFixed(1)} KB`
  return `${(size / BYTES_PER_UNIT ** 2).toFixed(1)} MB`
}

/**
 * Workerが問題点の先頭に付ける位置（triggers[0]. や triggers[0].actions[1]. の形。番号は0始まり）。
 *
 * 動作そのものへの問題点（triggers[0].actions: …）は項目名が続かないので、後ろの . は付かないこともある。
 */
const PROBLEM_POSITION = /^triggers\[(\d+)\]\.(?:(actions)\[(\d+)\](\.)?)?/

/**
 * Workerが返した問題点の位置を、画面で分かる呼び名に読み替える。
 *
 * 一覧が固定なので「何番目のトリガー」では場所が伝わらない。送った順の項目の名前を受け取って添える。
 *
 * @param labels 送ったトリガーの項目の名前（送った順）。足りなければ番号のままにする
 */
export const describeProblem = (problem: string, labels: readonly string[] = []): string =>
  problem.replace(PROBLEM_POSITION, (_, trigger: string, nested: string | undefined, index: string | undefined, dot: string | undefined) => {
    const label = labels[Number(trigger)]
    const position = label === undefined ? `${Number(trigger) + 1}番目のトリガーの ` : `「${label}」の設定の `
    if (nested === undefined || index === undefined) return position
    // 項目名が続く（. があった）ときだけ、読みやすさのために「の」で続ける
    return `${position}${Number(index) + 1}つ目の動作${dot === undefined ? '' : 'の '}`
  })
