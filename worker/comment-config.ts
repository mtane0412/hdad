/**
 * コメントビューアーの設定
 *
 * コメントビューアー（/comments/）の振る舞いのうち、配信者が配信中に切り替えるものを、管理画面から受け取って
 * 検証し、ストア（KV）に保存する。配信中に変える設定なので URL には入れない（docs/principles.md の3）。
 * 作りは draw-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒む。
 *
 * 持つのは次の2つである。
 * - highlightUnread: しばらく未読のままの発言を目立たせるか。何分で目立たせるかは設定にせず、画面
 *   （src/comments/feed.ts の UNREAD_HIGHLIGHT_MS）が決め切る（docs/principles.md の1）
 * - judgeWithJev: 配信者の発話（文字起こし）から、どの発言に反応したかを Jev で判定して既読にするか
 *   （worker/comment-reaction.ts）。OpenRouter の鍵と残高が要るので、既定では切っておく
 *
 * 注意: 読み出すときも検証する。項目を足したので、足す前に保存した設定（judgeWithJev が無い）が残っていることが
 * ある。黙って既定の値で補わず、直し方の分かるエラーにする（alert-config.ts と同じ扱い。docs/principles.md の4）。
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
  /** 配信者の発話から、どの発言に反応したかを Jev で判定して既読にするか */
  readonly judgeWithJev: boolean
}

/**
 * 未保存のときの設定。
 *
 * 目立たせるのは反応し忘れに気づくための機能なので、最初から効かせておく。Jev による判定は OpenRouter の鍵と
 * 残高が要るので、配信者が選んだときだけ効かせる（鍵が無いまま効かせると、発話のたびに失敗が記録される）。
 */
export const DEFAULT_COMMENT_SETTINGS: CommentSettings = { highlightUnread: true, judgeWithJev: false }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseCommentSettings = (input: unknown): CommentSettings => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['設定はオブジェクトで指定してください'])

  const { highlightUnread, judgeWithJev } = input
  const problems: string[] = []
  if (typeof highlightUnread !== 'boolean') problems.push('highlightUnread: true か false で指定してください')
  if (typeof judgeWithJev !== 'boolean') problems.push('judgeWithJev: true か false で指定してください')
  if (typeof highlightUnread !== 'boolean' || typeof judgeWithJev !== 'boolean') throw new ConfigError(SUBJECT, problems)
  // 送り主が足した項目を抱え込まないよう、読めた項目だけを写して持つ
  return { highlightUnread, judgeWithJev }
}

export const saveCommentSettings = (store: KeyValueStore, settings: CommentSettings): Promise<void> =>
  store.put(CONFIG_KEY, JSON.stringify(settings))

/**
 * 保存済みの設定を読む。一度も保存していなければ既定の設定を返す。
 *
 * @throws Error 保存済みの設定が古い形・壊れている場合（黙って既定の値で補わない）
 */
export const loadCommentSettings = async (store: KeyValueStore): Promise<CommentSettings> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return DEFAULT_COMMENT_SETTINGS
  try {
    return parseCommentSettings(JSON.parse(text))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`保存されているコメントビューアーの設定が古い形か、壊れています（${reason}）。KVの ${CONFIG_KEY} を消してから設定し直してください`, {
      cause: error,
    })
  }
}
