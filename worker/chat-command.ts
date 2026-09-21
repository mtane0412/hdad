/**
 * チャットのコマンドの判定
 *
 * EventSubの `channel.chat.message` の通知から発言を取り出し、何を送り返すかを決める。
 * 通信を伴わない変換だけをここに置き、購読・送信・記録は呼び出し側（webhook-routes.ts）が受け持つ。
 *
 * コマンドの一覧は引数で受け取る。いまは組み込みの定数（BUILT_IN_COMMANDS）を渡しているが、
 * 後の段階でストア（KV）から読んだものに差し替えられるよう、判定のしくみとは切り離しておく。
 *
 * 注意: bot自身の発言には決して応答しない。応答すると、その応答にまたbotが応答して止まらなくなる。
 */

/** コマンド1つぶんの定義 */
export interface BotCommand {
  /** `!` を除いたコマンド名（小文字で比べる） */
  name: string
  /** 送り返す文言。差し込み語 {user} が発言者のログイン名に置き換わる */
  reply: string
}

/** 通知から取り出した、1件の発言 */
export interface ChatMessage {
  /** 発言があったチャンネルの持ち主のユーザーID。このWorkerが扱う配信者のものかを確かめるのに使う */
  broadcasterUserId: string
  /** Twitchが振ったメッセージのID */
  messageId: string
  /** 発言者のユーザーID。bot自身かどうかの判別に使う */
  chatterUserId: string
  /** 発言者のログイン名。応答文の {user} に入る */
  chatterUserLogin: string
  /** 本文（絵文字などを含まない平文） */
  text: string
}

/** コマンドの先頭に付ける文字 */
const PREFIX = '!'

/**
 * 組み込みのコマンド。
 *
 * いまは動作確認のための最小限だけを持つ。配信者が自分で増やせるようにするのは後の段階で、
 * そのときはこの定数の代わりにストアから読んだ一覧を resolveReply へ渡す。
 */
export const BUILT_IN_COMMANDS: readonly BotCommand[] = [{ name: 'ping', reply: '@{user} pong' }]

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * `channel.chat.message` の通知から、必要な項目を取り出す。
 *
 * @param toError 問題を伝えるエラーの作り方。呼び出し側が「不正な通知」として扱える形にするために受け取る
 *   （既定では素の Error。Workerの経路からは400になるエラーを渡す）
 * @throws 必要な項目が揃っていない（想定と違う通知を黙って捨てないため）
 */
export const readChatMessage = (body: Record<string, unknown>, toError: (message: string) => Error = (message) => new Error(message)): ChatMessage => {
  const { event } = body
  if (!isRecord(event)) throw toError('channel.chat.message の通知に event がありません')

  const {
    broadcaster_user_id: broadcasterUserId,
    chatter_user_id: chatterUserId,
    chatter_user_login: chatterUserLogin,
    message_id: messageId,
    message,
  } = event
  const text = isRecord(message) ? message.text : undefined
  if (
    typeof broadcasterUserId !== 'string' ||
    typeof chatterUserId !== 'string' ||
    typeof chatterUserLogin !== 'string' ||
    typeof messageId !== 'string' ||
    typeof text !== 'string'
  ) {
    throw toError('channel.chat.message の通知に broadcaster_user_id・chatter_user_id・chatter_user_login・message_id・message.text が揃っていません')
  }
  return { broadcasterUserId, messageId, chatterUserId, chatterUserLogin, text }
}

/**
 * 発言に対して送り返す文言を決める。送り返さない場合は null。
 *
 * @param commands 登録されているコマンドの一覧
 * @param botUserId 接続しているbotのユーザーID。これと同じ発言者には応答しない
 */
export const resolveReply = (commands: readonly BotCommand[], message: ChatMessage, botUserId: string): string | null => {
  // botの応答にbotが応答するのを防ぐ。ここを外すと、1回のコマンドで延々と往復し続ける
  if (message.chatterUserId === botUserId) return null

  const trimmed = message.text.trimStart()
  if (!trimmed.startsWith(PREFIX)) return null

  // 「!コマンド名 そのあとの文字」の形を想定し、最初の語だけをコマンド名として見る
  const name = trimmed.slice(PREFIX.length).split(/\s/)[0]?.toLowerCase() ?? ''
  if (name === '') return null

  const command = commands.find((candidate) => candidate.name.toLowerCase() === name)
  if (!command) return null
  return command.reply.replaceAll('{user}', message.chatterUserLogin)
}
