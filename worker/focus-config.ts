/**
 * 注目コメント（いま取り上げている発言1件）の設定
 *
 * 配信者が直近の発言から1件を選び、その人のアイコン・名前と一緒に配信画面へ大きく映すための設定である
 * （issue #94）。選んだ1件は次の発言では差し替わらず、配信者が外すか選び直すまで映り続ける。
 *
 * 選んだ時点の本文をここに写して持つのは、発言の記録（stream_chat_messages）が配信後に消えるためである
 * （人物像を作り終えた材料はその場で消す。worker/stream-chat-store.ts）。
 *
 * 作りは speech-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒む（管理画面で一度に直せるように）。
 * 保存先はKVで、読み出しは管理画面（GET /api/admin/focus）とオーバーレイ（GET /api/overlay/focus）の2つから通る。
 *
 * 注意: アイコンのURLは管理画面から受け取らない（parseFocusPick は捨てる）。保存の前に Worker が
 * Twitch から引いて添える（worker/focus-routes.ts）ので、配信画面に映る画像は Twitch のものに限られる。
 * 注意: ログイン名は小文字に直して保存する。オーバーレイはモデレーターの操作（BAN・タイムアウト）で届く
 * ログイン名と照合するが、Twitchの照合は大文字小文字を区別しないため、保存の時点で形をそろえておく。
 * 注意: 本文は「文字」としてだけ持ち、エモートの絵は持たない。発言の記録に本文しか残っていないためである。
 * 注意: 本文の長さは見た目の文字数（コードポイント）で数える。絵文字はUTF-16の単位では2つぶんを占めるため、
 * 単位のまま数えると上限内の発言まで「長すぎる」と拒んでしまう。
 * 注意: 保存先のキーは focus-comment で、人に追従していたころの focus-target とは分けてある。追従の指定は
 * 映す本文を持たないので、残っていても読まない（キーを分けて、古い形を読む分岐を持たずに済ませる）。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'focus-comment'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = '注目コメントの設定'

/** Twitchのログイン名（英数字と下線、25文字まで） */
const LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/
/** 表示名の長さの上限。Twitchの表示名はログイン名と同じ長さに収まるが、記録から写すので念のため広く取る */
const MAX_DISPLAY_NAME_LENGTH = 40
/** メッセージIDの長さの上限。TwitchはUUIDを振る */
const MAX_MESSAGE_ID_LENGTH = 100
/** 取り上げる本文の長さの上限。Twitchのチャット1件の上限（500文字）と合わせる */
export const MAX_FOCUS_TEXT_LENGTH = 500

/** 管理画面が選んで送ってくる発言1件 */
export interface FocusPick {
  /** Twitchが振ったメッセージのID。モデレーターに消されたときにオーバーレイが映すのをやめる目印になる */
  readonly messageId: string
  /** 発言した人のログイン名（小文字） */
  readonly login: string
  /** 発言した人の表示名 */
  readonly displayName: string
  /** 発言の本文（文字のみ。エモートの絵は持たない） */
  readonly text: string
}

/** いま取り上げている発言1件。取り上げていなければ null で表す */
export interface FocusTarget extends FocusPick {
  /** 発言した人のアイコン画像のURL。取り上げた時点で Worker が Twitch から引いたもの */
  readonly profileImageUrl: string
}

/** 見た目の文字数（コードポイント）。絵文字などサロゲートペアの文字を2文字と数えないために使う */
const countCodePoints = (value: string): number => [...value].length

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた内容を検証し、取り上げる発言1件の形にする。
 *
 * アイコンのURLは送られてきても読まない（保存の前に Worker が Twitch から引く）。
 *
 * @param input { target: 取り上げる発言 | null } の形を期待する
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseFocusPick = (input: unknown): FocusPick | null => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['設定はオブジェクトで指定してください'])
  const target = input.target
  if (target === null) return null
  if (!isRecord(target)) {
    throw new ConfigError(SUBJECT, ['target: 取り上げる発言をオブジェクトで、取り上げていないなら null で指定してください'])
  }

  const problems: string[] = []

  /** ログイン名を読む。照合は大文字小文字を区別しないので、小文字に直して返す */
  const readLogin = (): string => {
    const value = target.login
    if (typeof value === 'string' && LOGIN_PATTERN.test(value)) return value.toLowerCase()
    problems.push('login: Twitchのログイン名（英数字と下線、25文字まで）で指定してください')
    return ''
  }

  /**
   * 文字の項目を読む。空のものと長すぎるものを拒む。
   *
   * @param countLength 長さの数え方。既定は UTF-16 の単位（文字列の length）で、本文だけは
   *   見た目の文字数（コードポイント）で数える（countCodePoints）。絵文字はサロゲートペアで
   *   2単位ぶんを占めるので、単位のまま数えると上限内の発言まで拒んでしまう。表示側
   *   （src/focus/view.ts の bodyLengthOf）も同じ数え方をする
   */
  const readText = (
    name: 'messageId' | 'displayName' | 'text',
    maxLength: number,
    countLength: (value: string) => number = (value) => value.length,
  ): string => {
    const value = target[name]
    if (typeof value === 'string' && value !== '' && countLength(value) <= maxLength) return value
    problems.push(`${name}: 空でない${maxLength}文字までの文字列で指定してください`)
    return ''
  }

  // 呼ぶ順番が、問題点に並ぶ順番になる
  const messageId = readText('messageId', MAX_MESSAGE_ID_LENGTH)
  const login = readLogin()
  const displayName = readText('displayName', MAX_DISPLAY_NAME_LENGTH)
  const text = readText('text', MAX_FOCUS_TEXT_LENGTH, countCodePoints)
  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { messageId, login, displayName, text }
}

export const saveFocusTarget = (store: KeyValueStore, target: FocusTarget | null): Promise<void> =>
  store.put(CONFIG_KEY, JSON.stringify({ target }))

/**
 * 保存済みの「いま取り上げているもの」を読む。一度も保存していなければ null（取り上げていない）を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない（speech-config.ts と同じ）。
 */
export const loadFocusTarget = async (store: KeyValueStore): Promise<FocusTarget | null> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return null
  return (JSON.parse(text) as { target: FocusTarget | null }).target
}
