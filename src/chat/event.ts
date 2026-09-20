/**
 * IRCメッセージから、チャット欄の表示に関わるイベントへの変換
 *
 * 接続処理（connection.ts）は、届いた行をここでイベントに変えてから処理する。
 * 通信を伴わない変換だけをここに置き、単体でテストできるようにしている。
 */
import type { IrcMessage } from './irc'
import { toChatMessage, type ChatMessage } from './message'

export type ChatEvent =
  /** 視聴者の書き込み */
  | { readonly type: 'message'; readonly message: ChatMessage }
  /** BAN・タイムアウトされたユーザーの書き込みをすべて消す */
  | { readonly type: 'clear-user'; readonly login: string }
  /** /clear によりすべての書き込みを消す */
  | { readonly type: 'clear-all' }
  /** モデレーターが削除した1件を消す */
  | { readonly type: 'delete'; readonly id: string }
  /** 入室したチャンネルのID */
  | { readonly type: 'room'; readonly roomId: string }
  /** 生存確認。同じ payload で PONG を返す */
  | { readonly type: 'ping'; readonly payload: string }
  /** Twitchからの再接続要求 */
  | { readonly type: 'reconnect' }
  /** Twitchからの通知（チャンネルが停止中など） */
  | { readonly type: 'notice'; readonly text: string }

/**
 * @returns 表示に関係しないコマンドの場合は undefined
 * @throws PRIVMSG の内容が読めない場合
 */
export const toChatEvent = (irc: IrcMessage): ChatEvent | undefined => {
  switch (irc.command) {
    case 'PRIVMSG':
      return { type: 'message', message: toChatMessage(irc) }
    case 'CLEARCHAT': {
      const login = irc.params[1]
      return login === undefined ? { type: 'clear-all' } : { type: 'clear-user', login }
    }
    case 'CLEARMSG': {
      const id = irc.tags['target-msg-id']
      return id === undefined ? undefined : { type: 'delete', id }
    }
    case 'ROOMSTATE': {
      const roomId = irc.tags['room-id']
      return roomId === undefined ? undefined : { type: 'room', roomId }
    }
    case 'PING':
      return { type: 'ping', payload: irc.params[0] ?? '' }
    case 'RECONNECT':
      return { type: 'reconnect' }
    case 'NOTICE':
      return { type: 'notice', text: irc.params[1] ?? '' }
    default:
      return undefined
  }
}
