/**
 * EventSubのWebhookの受け口（POST /api/eventsub/webhook）
 *
 * TwitchからWorkerへ直接届く通知を受け、配信の記録（イベントの件数、配信の開始・終了）としてデータベースへ書く。
 * 誰でも呼べるURLなので、署名（EVENTSUB_SECRET によるHMAC）でTwitchからの通知であることを確かめ、古い通知は受け付けない。
 * 同じ通知の再送は、メッセージIDによって二重に数えない（stats-store.ts）。
 *
 * 注意: 2xx 以外を返すとTwitchは再送し、失敗が続くと購読を失効させる。想定しない通知を黙って捨てず、失敗として返す（Fail-Fast）。
 */
import { applyReply, findCommand, readChatMessage } from './chat-command'
import { loadBotConfig } from './bot-config'
import { consumeCooldown, reserveChatReply } from './chat-store'
import { CHAT_MESSAGE, COUNTED_EVENT_TYPES, STREAM_OFFLINE, STREAM_ONLINE, verifyWebhookSignature } from './eventsub-webhook'
import { HttpError, STATUS, type Context } from './http'
import { recordEvent, recordFailure, recordStreamOffline, recordStreamOnline } from './stats-store'
import { getAccessToken, loadToken } from './token'

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
  throw new HttpError(STATUS.badRequest, 'unexpected-event', `購読していない種類の通知です: ${type}`)
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
  const { env, twitch, now } = context
  // 通知の中身が想定と違えば、黙って捨てずに「不正な通知」として400で返す（Workerの不具合を表す500と区別する）
  const message = readChatMessage(body, invalid)

  // このWorkerが扱う配信者以外のチャンネルのチャットには応答しない。
  // 応答先は常に TWITCH_BROADCASTER_ID なので、古い購読が残っていると、他人のチャットの発言に対して
  // こちらのチャンネルで応答してしまう。受け取り自体は成功として返す（2xx以外だとTwitchが再送し続ける）
  if (message.broadcasterUserId !== env.TWITCH_BROADCASTER_ID) return

  // botを切断した直後など、購読が残っていても応答できないことがある。その場合は受け取るだけにする
  const bot = await loadToken(env.STORE, 'bot')
  if (!bot) return

  // コマンドに一致しない発言では、ここから先へ進まない（チャットの全件をD1に書かないため）
  const { commands } = await loadBotConfig(env.STORE)
  const command = findCommand(commands, message, bot.userId)
  if (!command) return

  // 鍵の確保はクールダウンの判定より先に行う。逆にすると、再送のたびに最後に使った時刻が更新され、いつまでも応答できなくなる
  if (!(await reserveChatReply(env.DB, message.messageId, now))) return
  if (!(await consumeCooldown(env.DB, command.name, command.cooldownSeconds, now))) return

  const reply = applyReply(command, message)
  try {
    const token = await getAccessToken(env.STORE, 'bot', twitch, now)
    await twitch.sendChatMessage(token.accessToken, {
      broadcasterId: env.TWITCH_BROADCASTER_ID,
      senderId: token.userId,
      message: reply,
    })
  } catch (error) {
    await recordFailure(env.DB, 'chat-reply-failed', error instanceof Error ? error.message : String(error), now)
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
      // チャットは記録せず応答に回す。ほかのイベントは配信の記録として数える
      if (readSubscription(body).type === CHAT_MESSAGE) await replyToChatMessage(context, body)
      else await recordNotification({ db: env.DB, messageId, occurredAt, body })
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
