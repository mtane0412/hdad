/**
 * 注目コメント（いま取り上げている1件）の設定
 *
 * 配信中に「今から怖い話をする」と言い出した人が現れたときに、その人の発言だけを大きく映すための設定である
 * （issue #94）。取り上げ方は2通りあり、どちらも同じ1つの保存先で表す。
 * - 人に追従する（viewer）: ログイン名だけを持ち、その人の発言が届くたびにオーバーレイが映すものを差し替える
 * - 発言1件を取り上げる（message）: 発言の中身そのものを持ち、次の発言では差し替わらない
 *
 * 後者は「ある人の発言をテーマに雑談する」使い方のためのもので、配信者が直近の発言から選んで固定する。
 * 選んだ時点の本文をここに写して持つのは、発言の記録（stream_chat_messages）が配信後に消えるためである
 * （人物像を作り終えた材料はその場で消す。worker/stream-chat-store.ts）。
 *
 * 作りは speech-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒む（管理画面で一度に直せるように）。
 * 保存先はKVで、読み出しは管理画面（GET /api/admin/focus）とオーバーレイ（GET /api/overlay/focus）の2つから通る。
 *
 * 注意: ログイン名は小文字に直して保存する。オーバーレイは匿名IRCで届く発言のログイン名と照合するが、
 * Twitchの照合は大文字小文字を区別しないため、保存の時点で形をそろえておく。
 * 注意: 本文は「文字」としてだけ持ち、エモートの絵は持たない。発言の記録に本文しか残っていないためで、
 * 人に追従するときはIRCから届いた断片（エモートの絵を含む）をそのまま映す。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'focus-target'
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

/** いま取り上げているもの。取り上げていなければ null で表す */
export type FocusTarget =
  | {
      /** 人に追従する。その人の発言が届くたびに、映すものが最新の1件へ差し替わる */
      readonly type: 'viewer'
      /** 追従する人のログイン名（小文字） */
      readonly login: string
    }
  | {
      /** 発言1件を取り上げる。次の発言では差し替わらない */
      readonly type: 'message'
      /** Twitchが振ったメッセージのID。モデレーターに消されたときにオーバーレイが映すのをやめる目印になる */
      readonly messageId: string
      /** 発言した人のログイン名（小文字） */
      readonly login: string
      /** 発言した人の表示名 */
      readonly displayName: string
      /** 発言の本文（文字のみ。エモートの絵は持たない） */
      readonly text: string
    }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 取り上げ方の種類。問題点の文面に並べる */
const TARGET_TYPES = ['viewer', 'message'] as const

/**
 * 管理画面から送られてきた内容を検証し、保存用の形にする。
 *
 * @param input { target: 取り上げているもの | null } の形を期待する
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseFocusTarget = (input: unknown): FocusTarget | null => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['設定はオブジェクトで指定してください'])
  const target = input.target
  if (target === null) return null
  if (!isRecord(target)) {
    throw new ConfigError(SUBJECT, ['target: 取り上げているものをオブジェクトで、取り上げていないなら null で指定してください'])
  }

  const problems: string[] = []

  /** ログイン名を読む。照合は大文字小文字を区別しないので、小文字に直して返す */
  const readLogin = (): string => {
    const value = target.login
    if (typeof value === 'string' && LOGIN_PATTERN.test(value)) return value.toLowerCase()
    problems.push('login: Twitchのログイン名（英数字と下線、25文字まで）で指定してください')
    return ''
  }

  /** 文字の項目を読む。空のものと長すぎるものを拒む */
  const readText = (name: 'messageId' | 'displayName' | 'text', maxLength: number): string => {
    const value = target[name]
    if (typeof value === 'string' && value !== '' && value.length <= maxLength) return value
    problems.push(`${name}: 空でない${maxLength}文字までの文字列で指定してください`)
    return ''
  }

  const type = target.type
  if (type !== 'viewer' && type !== 'message') {
    throw new ConfigError(SUBJECT, [`type: ${TARGET_TYPES.join(' か ')} で指定してください`])
  }

  // 呼ぶ順番が、問題点に並ぶ順番になる
  if (type === 'viewer') {
    const login = readLogin()
    if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
    return { type, login }
  }

  const messageId = readText('messageId', MAX_MESSAGE_ID_LENGTH)
  const login = readLogin()
  const displayName = readText('displayName', MAX_DISPLAY_NAME_LENGTH)
  const text = readText('text', MAX_FOCUS_TEXT_LENGTH)
  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { type, messageId, login, displayName, text }
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
