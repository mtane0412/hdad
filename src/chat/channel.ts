/**
 * 接続先チャンネルの取得
 *
 * チャットボックスは、このWorkerが扱う配信者のチャンネルだけを映す（URLにチャンネル名を書かない）。
 * 接続先の名前とIDは、Workerの公開API（/api/chat/channel）から受け取る。
 *
 * 注意: 応答が想定した形でなければエラーにする（Fail-Fast）。空のチャンネル名でIRCに接続すると、
 * 何も起きないまま「つながっているように見える」状態になってしまう。
 */
import { createCaller, isRecord } from '../core/api'

/** 接続先のチャンネル */
export interface ChatChannel {
  /** IRCの JOIN に使うログイン名（小文字） */
  readonly login: string
}

/**
 * 接続先のチャンネルを取得する。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const loadChannel = async (fetchImpl: typeof fetch): Promise<ChatChannel> => {
  const body = await createCaller(fetchImpl)('/api/chat/channel')
  const login = isRecord(body) && typeof body.login === 'string' ? body.login : ''
  if (login === '') throw new Error('Workerの応答に login がありません')
  // IRCのチャンネル名は小文字で指定する必要がある
  return { login: login.toLowerCase() }
}
