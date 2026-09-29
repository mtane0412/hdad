/**
 * コメントビューアーの設定
 *
 * コメントビューアー（/comments/）の振る舞いのうち、配信者が配信中に切り替えるものを、管理画面から受け取って
 * 検証し、ストア（KV）に保存する。配信中に変える設定なので URL には入れない（docs/principles.md の3）。
 * 作りは draw-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒む。
 *
 * いま持つのは、しばらく未読のままの発言を目立たせるか（highlightUnread）だけである。何分で目立たせるかは
 * 設定にせず、画面（src/comments/feed.ts の UNREAD_HIGHLIGHT_MS）が決め切る（docs/principles.md の1）。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない（draw-config.ts と同じ）。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'comment-settings'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = 'コメントビューアーの設定'

/** コメントビューアーの設定 */
export interface CommentSettings {
  /** しばらく未読のままの発言を目立たせるか */
  readonly highlightUnread: boolean
}

/** 未保存のときの設定。反応し忘れに気づくための機能なので、最初から効かせておく */
export const DEFAULT_COMMENT_SETTINGS: CommentSettings = { highlightUnread: true }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseCommentSettings = (input: unknown): CommentSettings => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['設定はオブジェクトで指定してください'])

  // 項目が1つだけなので、問題点を集める入れ物は持たずにその場で拒む
  const highlightUnread = input.highlightUnread
  if (typeof highlightUnread !== 'boolean') throw new ConfigError(SUBJECT, ['highlightUnread: true か false で指定してください'])
  // 送り主が足した項目を抱え込まないよう、読めた項目だけを写して持つ
  return { highlightUnread }
}

export const saveCommentSettings = (store: KeyValueStore, settings: CommentSettings): Promise<void> =>
  store.put(CONFIG_KEY, JSON.stringify(settings))

/**
 * 保存済みの設定を読む。一度も保存していなければ既定の設定を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
export const loadCommentSettings = async (store: KeyValueStore): Promise<CommentSettings> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return DEFAULT_COMMENT_SETTINGS
  return JSON.parse(text) as CommentSettings
}
