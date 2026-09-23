/**
 * チャットのコマンドの判定
 *
 * EventSubの `channel.chat.message` の通知から発言を取り出し、何を送り返すかを決める。
 * 通信を伴わない変換だけをここに置き、購読・送信・記録は呼び出し側（webhook-routes.ts）が受け持つ。
 *
 * コマンドの一覧は引数で受け取る（保存と検証は bot-config.ts が受け持つ）。判定のしくみと、一覧の出どころを切り離しておく。
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
  /** 発言者のログイン名。コマンドの応答文の {user} に入る */
  chatterUserLogin: string
  /** 発言者の表示名。アラートのトリガーの文言の {user} に入る（表示名は本人が変えられるので、条件の照合には使わない） */
  chatterUserName: string
  /** 本文（絵文字などを含まない平文） */
  text: string
  /**
   * 発言者に付いているバッジの種類の名前（`broadcaster`・`moderator`・`vip`・`subscriber` など）。
   * 自動モデレーション（chat-moderation.ts）で、処分の対象外かどうかを見るのに使う
   */
  badges: string[]
}

/** コマンドの先頭に付ける文字 */
const PREFIX = '!'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 通知のバッジ（`{ set_id, id, info }` の配列）から、種類の名前だけを取り出す。
 *
 * バッジが1つも付いていない発言では `badges` が無い、または空の配列で届く。
 * 本文や発言者と違って欠けていても判断に困らない（バッジなしとして扱えばよい）ので、揃っていなくてもエラーにしない。
 */
const readBadgeNames = (badges: unknown): string[] =>
  Array.isArray(badges) ? badges.flatMap((badge: unknown) => (isRecord(badge) && typeof badge.set_id === 'string' ? [badge.set_id] : [])) : []

/**
 * `channel.chat.message` の通知の event（中身）から、必要な項目を取り出す。
 *
 * 通知そのものではなく中身を受け取るのは、アラートのトリガー（alert-event.ts の extract）が
 * イベントごとの中身だけを渡す形になっているため。同じ読み取りを2か所に書かずに済ませる。
 *
 * @param event 通知の event。オブジェクトでなければエラーにする
 * @param toError 問題を伝えるエラーの作り方。呼び出し側が「不正な通知」として扱える形にするために受け取る
 *   （既定では素の Error。Workerの経路からは400になるエラーを渡す）
 * @throws 必要な項目が揃っていない（想定と違う通知を黙って捨てないため）
 */
export const readChatMessage = (event: unknown, toError: (message: string) => Error = (message) => new Error(message)): ChatMessage => {
  if (!isRecord(event)) throw toError('channel.chat.message の通知に event がありません')

  const {
    broadcaster_user_id: broadcasterUserId,
    chatter_user_id: chatterUserId,
    chatter_user_login: chatterUserLogin,
    chatter_user_name: chatterUserName,
    message_id: messageId,
    message,
    badges,
  } = event
  const text = isRecord(message) ? message.text : undefined
  if (
    typeof broadcasterUserId !== 'string' ||
    typeof chatterUserId !== 'string' ||
    typeof chatterUserLogin !== 'string' ||
    typeof chatterUserName !== 'string' ||
    typeof messageId !== 'string' ||
    typeof text !== 'string'
  ) {
    throw toError(
      'channel.chat.message の通知に broadcaster_user_id・chatter_user_id・chatter_user_login・chatter_user_name・message_id・message.text が揃っていません',
    )
  }
  return { broadcasterUserId, messageId, chatterUserId, chatterUserLogin, chatterUserName, text, badges: readBadgeNames(badges) }
}

/**
 * 発言に当てはまるコマンドを探す。当てはまらなければ null。
 *
 * 呼び出し側は、当てはまったときだけクールダウンなどの記録へ進む（当てはまらない発言でデータベースに書かないため）。
 * コマンドの型を保ったまま返すので、クールダウンなどの追加の項目も受け取れる。
 *
 * @param commands 登録されているコマンドの一覧
 * @param botUserId 接続しているbotのユーザーID。これと同じ発言者には応答しない
 */
export const findCommand = <Command extends BotCommand>(
  commands: readonly Command[],
  message: ChatMessage,
  botUserId: string,
): Command | null => {
  // botの応答にbotが応答するのを防ぐ。ここを外すと、1回のコマンドで延々と往復し続ける
  if (message.chatterUserId === botUserId) return null

  const trimmed = message.text.trimStart()
  if (!trimmed.startsWith(PREFIX)) return null

  // 「!コマンド名 そのあとの文字」の形を想定し、最初の語だけをコマンド名として見る
  const name = trimmed.slice(PREFIX.length).split(/\s/)[0]?.toLowerCase() ?? ''
  if (name === '') return null

  return commands.find((candidate) => candidate.name.toLowerCase() === name) ?? null
}

/** 配信の「これまでのあらすじ」（issue #65）に置き換わる差し込み語 */
const SUMMARY_PLACEHOLDER = '{summary}'

/**
 * あらすじがまだ無いときに、その差し込み語に入る文言。
 *
 * 空文字にせず文言を入れるのは、コマンドが無応答に見えないようにするためである。あらすじは cron が
 * 作るものなので、配信の直後や、LLMの無料枠を使い切った日には無いことがある。
 */
const NO_SUMMARY = 'まだあらすじがありません'

/**
 * その応答文があらすじを必要とするか。
 *
 * 呼び出し側（webhook-routes.ts）は、これが true のときだけデータベースからあらすじを読む。
 * 使っていないコマンドのために毎回読みに行かないためである（alert-state.ts の
 * 「条件を使うトリガーが無ければデータベースを触らない」と同じ考え方）。
 */
export const needsStreamSummary = (command: BotCommand): boolean => command.reply.includes(SUMMARY_PLACEHOLDER)

/**
 * コマンドの応答文の差し込み語を、実際の値に置き換える。
 *
 * @param summary 貯めてあるあらすじ。配信していない・まだ作っていない・読む必要がない場合は null
 */
export const applyReply = (command: BotCommand, message: ChatMessage, summary: string | null): string =>
  command.reply.replaceAll('{user}', message.chatterUserLogin).replaceAll(SUMMARY_PLACEHOLDER, summary ?? NO_SUMMARY)

/** 発言に対して送り返す文言。送り返さない場合は null（findCommand と applyReply をまとめたもの） */
export const resolveReply = (
  commands: readonly BotCommand[],
  message: ChatMessage,
  botUserId: string,
  summary: string | null = null,
): string | null => {
  const command = findCommand(commands, message, botUserId)
  return command ? applyReply(command, message, summary) : null
}
