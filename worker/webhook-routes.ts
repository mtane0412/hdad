/**
 * EventSubのWebhookの受け口（POST /api/eventsub/webhook）
 *
 * TwitchからWorkerへ直接届く通知を受け、配信の記録（イベントの件数、配信の開始・終了）としてデータベースへ書く。
 * 誰でも呼べるURLなので、署名（EVENTSUB_SECRET によるHMAC）でTwitchからの通知であることを確かめ、古い通知は受け付けない。
 * 同じ通知の再送は、メッセージIDによって二重に数えない（stats-store.ts）。
 *
 * 注意: 2xx 以外を返すとTwitchは再送し、失敗が続くと購読を失効させる。想定しない通知を黙って捨てず、失敗として返す（Fail-Fast）。
 */
import { loadAlertConfig, type StoredAnnounceAction } from './alert-config'
import { announcementFor, chatMessageFor } from './alert-event'
import { announceAsBot, sendAsBot } from './bot-chat'
import { applyReply, findCommand, readChatMessage, type ChatMessage } from './chat-command'
import { loadBotConfig } from './bot-config'
import { punishAsBot } from './bot-moderation'
import { judge, repeatRuleOf } from './chat-moderation'
import { loadModerationConfig } from './moderation-config'
import { consumeCooldown, recordAndCountRecentMessage, reserveChatReply } from './chat-store'
import { CHAT_MESSAGE, COUNTED_EVENT_TYPES, STREAM_OFFLINE, STREAM_ONLINE, UNCOUNTED_EVENT_TYPES, verifyWebhookSignature } from './eventsub-webhook'
import { HttpError, STATUS, type Context } from './http'
import { recordEvent, recordFailure, recordStreamOffline, recordStreamOnline } from './stats-store'
import { loadToken } from './token'

export const WEBHOOK_PATH = '/api/eventsub/webhook'

const HEADER = {
  messageId: 'Twitch-Eventsub-Message-Id',
  timestamp: 'Twitch-Eventsub-Message-Timestamp',
  signature: 'Twitch-Eventsub-Message-Signature',
  messageType: 'Twitch-Eventsub-Message-Type',
} as const

/** これより古い通知は受け付けない（ミリ秒）。盗み見た通知の使い回しへの備えで、Twitchの案内どおり10分 */
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const invalid = (message: string): HttpError => new HttpError(STATUS.badRequest, 'invalid-webhook', message)

const parseBody = (text: string): Record<string, unknown> => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw invalid('通知の本文をJSONとして読めません')
  }
  if (!isRecord(body)) throw invalid('通知の本文がJSONのオブジェクトではありません')
  return body
}

/** 通知の subscription から、イベントの種類と購読の状態を取り出す */
const readSubscription = (body: Record<string, unknown>): { type: string; status: string | null } => {
  const { subscription } = body
  if (!isRecord(subscription) || typeof subscription.type !== 'string') throw invalid('通知に subscription.type がありません')
  return { type: subscription.type, status: typeof subscription.status === 'string' ? subscription.status : null }
}

interface Notification {
  db: Context['env']['DB']
  messageId: string
  /** 通知のタイムスタンプ（ミリ秒） */
  occurredAt: number
  body: Record<string, unknown>
}

const recordNotification = async ({ db, messageId, occurredAt, body }: Notification): Promise<void> => {
  const { type } = readSubscription(body)

  if (type === STREAM_ONLINE) {
    const { event } = body
    const startedAt = isRecord(event) && typeof event.started_at === 'string' ? Date.parse(event.started_at) : Number.NaN
    if (!isRecord(event) || typeof event.id !== 'string' || Number.isNaN(startedAt)) {
      throw invalid('stream.online の通知に event.id・event.started_at が揃っていません')
    }
    await recordStreamOnline(db, { id: event.id, startedAt })
    return
  }
  if (type === STREAM_OFFLINE) {
    await recordStreamOffline(db, occurredAt)
    return
  }
  if (COUNTED_EVENT_TYPES.includes(type)) {
    await recordEvent(db, { id: messageId, type, occurredAt })
    return
  }
  // アラートのために購読しているだけで、件数は数えないイベント（フォロー）。記録することはないが、拒否もしない
  if (UNCOUNTED_EVENT_TYPES.includes(type)) return
  throw new HttpError(STATUS.badRequest, 'unexpected-event', `購読していない種類の通知です: ${type}`)
}

/**
 * 自動モデレーションの判定を行い、処分すべき発言なら処分する。
 *
 * コマンドへの応答より先に呼び、処分した発言にはコマンドの応答をしない。
 * 連投の判定に要る「直近の同じ文面の件数」は、連投のルールが有効なときだけ数える
 * （チャットは件数の桁が違うため、必要なときだけD1の書き込みの枠を使う）。
 *
 * 注意: bot自身の発言は決して処分しない。自分の応答を処分してしまうと、処分と応答の連鎖が止まらなくなる。
 * 注意: 処分すると決めたあとの失敗は、コマンドへの応答と同じく2xxのまま記録に残す
 * （2xx以外だとTwitchが同じ通知を再送し、処分が成功していた場合に二重に処分される）。
 *
 * @returns 処分した（または再送で処分済みだった）なら true
 */
const moderateChatMessage = async (context: Context, message: ChatMessage, botUserId: string): Promise<boolean> => {
  const { env, now } = context
  if (message.chatterUserId === botUserId) return false

  const config = await loadModerationConfig(env.STORE)
  const repeat = repeatRuleOf(config)
  const recentSameTextCount = repeat
    ? await recordAndCountRecentMessage(
        env.DB,
        { messageId: message.messageId, chatterUserId: message.chatterUserId, text: message.text, windowSeconds: repeat.windowSeconds },
        now,
      )
    : 1

  const punishment = judge(config, message, recentSameTextCount)
  if (punishment === null) return false

  // 鍵に動作の種類を混ぜるのは、同じ発言でコマンドの応答とも鍵を取り合わないようにするため（アラートの送信と同じ）
  if (!(await reserveChatReply(env.DB, `${message.messageId}:moderation`, now))) return true

  try {
    await punishAsBot(context, punishment, { messageId: message.messageId, userId: message.chatterUserId })
  } catch (error) {
    await recordFailure(env.DB, 'moderation-failed', error instanceof Error ? error.message : String(error), now)
  }
  return true
}

/**
 * チャットの通知に応答する。
 *
 * 配信の記録（D1）には書かない。チャットは件数の桁が違い、1通ごとに書くと配信の記録と書き込みの枠を食い合うため。
 *
 * 注意: 応答を送ると決めたあとの失敗は、Twitchへの応答を2xxのままにして記録に残す。
 * 2xx以外を返すとTwitchは同じ通知を再送するので、送信が成功していた場合に二重投稿になってしまう。
 * 黙って無視するのではなく収集の失敗として残し、管理画面（/api/admin/stats/failures）から気づけるようにする。
 */
const replyToChatMessage = async (context: Context, body: Record<string, unknown>): Promise<void> => {
  const { env, now } = context
  // 通知の中身が想定と違えば、黙って捨てずに「不正な通知」として400で返す（Workerの不具合を表す500と区別する）
  const message = readChatMessage(body, invalid)

  // このWorkerが扱う配信者以外のチャンネルのチャットには応答しない。
  // 応答先は常に TWITCH_BROADCASTER_ID なので、古い購読が残っていると、他人のチャットの発言に対して
  // こちらのチャンネルで応答してしまう。受け取り自体は成功として返す（2xx以外だとTwitchが再送し続ける）
  if (message.broadcasterUserId !== env.TWITCH_BROADCASTER_ID) return

  // botを切断した直後など、購読が残っていても応答できないことがある。その場合は受け取るだけにする
  const bot = await loadToken(env.STORE, 'bot')
  if (!bot) return

  // 自動モデレーションはコマンドの応答より先に判定する。処分した発言には応答しない
  if (await moderateChatMessage(context, message, bot.userId)) return

  // コマンドに一致しない発言では、ここから先へ進まない（チャットの全件をD1に書かないため）
  const { commands } = await loadBotConfig(env.STORE)
  const command = findCommand(commands, message, bot.userId)
  if (!command) return

  // 鍵の確保はクールダウンの判定より先に行う。逆にすると、再送のたびに最後に使った時刻が更新され、いつまでも応答できなくなる
  if (!(await reserveChatReply(env.DB, message.messageId, now))) return
  if (!(await consumeCooldown(env.DB, command.name, command.cooldownSeconds, now))) return

  const reply = applyReply(command, message)
  try {
    await sendAsBot(context, reply)
  } catch (error) {
    await recordFailure(env.DB, 'chat-reply-failed', error instanceof Error ? error.message : String(error), now)
  }
}

/**
 * アラートのトリガーに当てはまる通知なら、botとしてチャット・アナウンスを送る。
 *
 * アラートのトリガーは「条件」と「動作」からなり、動作の種類ごとに実行者が違う。素材の再生はオーバーレイが受け持ち、
 * チャットとアナウンスの送信はここ（Worker）が受け持つ。オーバーレイを開いていなくても送れるのはこのためである。
 *
 * 注意: 送ると決めたあとの失敗は、コマンドへの応答と同じく2xxのまま記録に残す
 * （2xx以外だとTwitchが同じ通知を再送し、送信が成功していた場合に二重投稿になる）。
 *
 * 注意: チャットとアナウンスを続けて送るが、この2回でTwitchのレート制限には当たらない。
 * チャット送信（POST /helix/chat/messages）の「1チャンネルにつき1秒1通」は送り主が配信者・モデレーター・VIPでない場合の制限で、
 * アナウンスを送れるbotは必ずそのチャンネルのモデレーターなので当てはまらない（モデレーターの枠は30秒100通）。
 * アナウンス（POST /helix/chat/announcements）の「2秒に1回」はこのエンドポイント自身の制限で、チャット送信とは枠を共有しない。
 * そのため間隔を空ける必要はない。ただし別々の通知が2秒以内に続き、そのどちらもアナウンスを送る場合は
 * 2通目が429になり得る（その場合は下の sendAndRecordFailure が失敗として記録する）。
 *
 * @param messageId 通知のメッセージID。再送で二度送らないための鍵に使う
 * @throws HttpError イベントの中身が想定と違う場合（400。黙って捨てない）
 */
const sendAlertMessages = async (context: Context, subscriptionType: string, body: Record<string, unknown>, messageId: string): Promise<void> => {
  const { env } = context

  const config = await loadAlertConfig(env.STORE)
  // 中身の形が違えば「不正な通知」として400で返す（Workerの不具合を表す500と区別する）
  const [message, announcement] = ((): [string | null, StoredAnnounceAction | null] => {
    try {
      return [chatMessageFor(config, subscriptionType, body.event), announcementFor(config, subscriptionType, body.event)]
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  if (message === null && announcement === null) return

  // botを切断していれば送る先がない。受け取り自体は成功として返す
  if (!(await loadToken(env.STORE, 'bot'))) return

  if (message !== null) await sendAndRecordFailure(context, messageId, 'chat', 'alert-chat-failed', () => sendAsBot(context, message))
  if (announcement !== null) {
    await sendAndRecordFailure(context, messageId, 'announce', 'alert-announce-failed', () => announceAsBot(context, announcement))
  }
}

/**
 * 鍵を確保してから送り、失敗は記録に残す（通知の受け取り自体は成功として返す）。
 *
 * 鍵の確保を送信より先に行うのは、Twitchの再送で同じお礼を二度送らないため。
 * 鍵に動作の種類を混ぜるのは、同じ通知でチャットとアナウンスの両方を送るときに、片方が鍵を取って
 * もう片方が送れなくなるのを防ぐため。
 */
const sendAndRecordFailure = async (
  context: Context,
  messageId: string,
  actionType: 'chat' | 'announce',
  failureCode: string,
  send: () => Promise<void>,
): Promise<void> => {
  const { env, now } = context
  if (!(await reserveChatReply(env.DB, `${messageId}:${actionType}`, now))) return

  try {
    await send()
  } catch (error) {
    await recordFailure(env.DB, failureCode, error instanceof Error ? error.message : String(error), now)
  }
}

export const eventsubWebhook = async (context: Context): Promise<Response> => {
  const { request, env, now } = context
  const messageId = request.headers.get(HEADER.messageId)
  const timestamp = request.headers.get(HEADER.timestamp)
  const signature = request.headers.get(HEADER.signature)
  const messageType = request.headers.get(HEADER.messageType)
  if (!messageId || !timestamp || !signature || !messageType) throw invalid('Twitch-Eventsub-Message-* のヘッダーが揃っていません')

  // 署名は届いた文字列そのものに対して確かめる。中身を読むのはそのあと
  const text = await request.text()
  if (!(await verifyWebhookSignature({ messageId, timestamp, body: text, signature, secret: env.EVENTSUB_SECRET }))) {
    throw new HttpError(STATUS.forbidden, 'invalid-signature', '通知の署名が正しくありません')
  }

  const occurredAt = Date.parse(timestamp)
  if (Number.isNaN(occurredAt)) throw invalid(`通知のタイムスタンプ（${timestamp}）を日時として読めません`)
  if (occurredAt < now - MAX_MESSAGE_AGE_MS) throw new HttpError(STATUS.badRequest, 'stale-message', '通知が古すぎます')

  const body = parseBody(text)
  switch (messageType) {
    case 'webhook_callback_verification': {
      // 購読を登録した直後に、このURLが本当に受け口であることをTwitchが確かめに来る。渡された文字列をそのまま返す
      if (typeof body.challenge !== 'string') throw invalid('購読の確認の通知に challenge がありません')
      return new Response(body.challenge, { status: STATUS.ok, headers: { 'Content-Type': 'text/plain' } })
    }
    case 'notification': {
      // チャットは記録せず応答に回す。ほかのイベントは配信の記録として数えたうえで、アラートのトリガーにかける
      const { type } = readSubscription(body)
      if (type === CHAT_MESSAGE) await replyToChatMessage(context, body)
      else {
        await recordNotification({ db: env.DB, messageId, occurredAt, body })
        await sendAlertMessages(context, type, body, messageId)
      }
      return new Response(null, { status: STATUS.noContent })
    }
    case 'revocation': {
      // 購読が失効すると以後のイベントを数えられない。管理画面から気づけるよう、収集の失敗として残す
      const { type, status } = readSubscription(body)
      await recordFailure(env.DB, 'subscription-revoked', `EventSubの購読 ${type} が失効しました（${status ?? '理由不明'}）。ログインし直すと登録し直します`, now)
      return new Response(null, { status: STATUS.noContent })
    }
    default:
      throw invalid(`想定していない種類のメッセージです: ${messageType}`)
  }
}
