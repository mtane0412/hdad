/**
 * EventSubのWebhookの受け口（POST /api/eventsub/webhook）
 *
 * TwitchからWorkerへ直接届く通知を受け、配信の記録（イベントの件数、配信の開始・終了）としてデータベースへ書く。
 * 誰でも呼べるURLなので、署名（EVENTSUB_SECRET によるHMAC）でTwitchからの通知であることを確かめ、古い通知は受け付けない。
 * 同じ通知の再送は、メッセージIDによって二重に数えない（stats-store.ts）。
 *
 * 注意: 2xx 以外を返すとTwitchは再送し、失敗が続くと購読を失効させる。想定しない通知を黙って捨てず、失敗として返す（Fail-Fast）。
 */
import { loadAlertConfig, type AlertConfig, type StoredAnnounceAction } from './alert-config'
import { pushAlert } from './alert-channel'
import { generateChatMessage } from './ai-chat'
import { aiChatFor, alertFor, announcementFor, chatMessageFor, hasAlertAction } from './alert-event'
import { resolveConditionState } from './alert-state'
import type { ConditionState } from './alert-event'
import { announceAsBot, sendAsBot } from './bot-chat'
import { applyReply, findCommand, readChatMessage, type ChatMessage } from './chat-command'
import { loadBotConfig } from './bot-config'
import { punishAsBot } from './bot-moderation'
import { judge, repeatRuleOf } from './chat-moderation'
import { recordStreamChatMessage } from './stream-chat-store'
import { readViewer, recordViewerMessage } from './viewer-store'
import { loadModerationConfig } from './moderation-config'
import { consumeCooldown, recordAndCountRecentMessage, reserveChatReply } from './chat-store'
import { CHAT_MESSAGE, COUNTED_EVENT_TYPES, STREAM_OFFLINE, STREAM_ONLINE, UNCOUNTED_EVENT_TYPES, verifyWebhookSignature } from './eventsub-webhook'
import { HttpError, STATUS, type Context } from './http'
import { loadOverlayKey } from './overlay-key'
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
 * チャットの通知を受けて、自動モデレーション・アラートのトリガー・コマンドの応答を順に行う。
 *
 * この順にするのは、処分した発言にはトリガーも応答も返さないため（荒らしの発言でアラートを鳴らさない）。
 * 発言そのものは配信の記録（D1の stream_events）に書かない。チャットは件数の桁が違い、1通ごとに書くと
 * 配信の記録と書き込みの枠を食い合うため。書くのは発言ではなく人で（viewers。viewer-store.ts）、これは1人1行に収まる。
 *
 * 注意: 応答を送ると決めたあとの失敗は、Twitchへの応答を2xxのままにして記録に残す。
 * 2xx以外を返すとTwitchは同じ通知を再送するので、送信が成功していた場合に二重投稿になってしまう。
 * 黙って無視するのではなく収集の失敗として残し、管理画面（/api/admin/stats/failures）から気づけるようにする。
 */
const replyToChatMessage = async (context: Context, body: Record<string, unknown>): Promise<void> => {
  const { env, now } = context
  // 通知の中身が想定と違えば、黙って捨てずに「不正な通知」として400で返す（Workerの不具合を表す500と区別する）
  const message = readChatMessage(body.event, invalid)

  // このWorkerが扱う配信者以外のチャンネルのチャットには応答しない。
  // 応答先は常に TWITCH_BROADCASTER_ID なので、古い購読が残っていると、他人のチャットの発言に対して
  // こちらのチャンネルで応答してしまう。受け取り自体は成功として返す（2xx以外だとTwitchが再送し続ける）
  if (message.broadcasterUserId !== env.TWITCH_BROADCASTER_ID) return

  // botを切断した直後など、購読が残っていても応答できないことがある。アラートの再生にbotは要らないので、
  // 自動モデレーションとコマンドの応答だけを飛ばし、トリガーの判定は続ける
  const bot = await loadToken(env.STORE, 'bot')

  // 視聴者の記録は、処分や応答の判定より先に残す。処分した発言も記録に含めるのは、荒らしの履歴も配信者には有用なため。
  // トリガーの条件のうち「このチャンネルで初めての発言か」「前の発言から空いた日数」は、この記録を読んで判定する。
  // そのため記録はアラートの判定（runAlertActions）より先に済ませておく必要がある（viewer-store.ts の readChatHistory を参照）。
  // bot自身の発言だけは記録しない（人の記録に自分の応答を混ぜない）。発言のたびに書くことになるが、
  // 前回から間隔が空くまで書き込まない作りなので（viewer-store.ts）、D1の書き込みの枠を食い続けることはない
  if (message.chatterUserId !== bot?.userId) {
    await recordViewerMessage(
      env.DB,
      {
        userId: message.chatterUserId,
        login: message.chatterUserLogin,
        displayName: message.chatterUserName,
        badges: message.badges,
        messageId: message.messageId,
      },
      now,
    )
    // 配信中なら、人物像（viewers の summary）の材料として本文も貯める。配信が終わったあとに cron が
    // 人ごとにまとめて人物像を作り、使い終えた材料を消す（stream-chat-store.ts・collect.ts）。
    // チャットの全文は貯めないという方針の、意識して設けた例外である（集計値だけでは人物像を作れないため）
    await recordStreamChatMessage(env.DB, { messageId: message.messageId, userId: message.chatterUserId, text: message.text }, now)
  }

  // 自動モデレーションはコマンドの応答より先に判定する。処分した発言には応答もトリガーも返さない
  if (bot && (await moderateChatMessage(context, message, bot.userId))) return

  // bot自身の発言ではトリガーを引かない。引くと、その応答にまた反応して止まらなくなる（コマンドの応答と同じ考え方）
  if (message.chatterUserId === bot?.userId) return

  // botの接続はもう調べ済みなので、判定の関数はその結果を返すだけでよい
  await runAlertActions(context, CHAT_MESSAGE, body, message.messageId, () => Promise.resolve(bot !== null), message)

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
    await sendAsBot(context, reply)
  } catch (error) {
    await recordFailure(env.DB, 'chat-reply-failed', error instanceof Error ? error.message : String(error), now)
  }
}

/**
 * アラートのトリガーに当てはまる通知なら、その動作を実行する。
 *
 * 素材の再生（alert）はオーバーレイ（OBSのブラウザソース）が受け持つので、当てはまったアラートを
 * 配送先（Durable Object）へ押し出す。チャットとアナウンスの送信はWorkerがbotとして行うので、
 * botが接続されているときだけ送る。オーバーレイを開いていなくてもチャットを送れるのはこのためである。
 *
 * 注意: 送ると決めたあとの失敗は、コマンドへの応答と同じく2xxのまま記録に残す
 * （2xx以外だとTwitchが同じ通知を再送し、送信が成功していた場合に二重投稿になる）。
 *
 * 注意: チャットとアナウンスを続けて送るが、この2回でTwitchのレート制限には当たらない。
 * チャット送信（POST /helix/chat/messages）の「1チャンネルにつき1秒1通」は送り主が配信者・モデレーター・VIPでない場合の制限で、
 * アナウンスを送れるbotは必ずそのチャンネルのモデレーターなので当てはまらない（モデレーターの枠は30秒100通）。
 * アナウンス（POST /helix/chat/announcements）の「2秒に1回」はこのエンドポイント自身の制限で、チャット送信とは枠を共有しない。
 * そのためこの2回の間で間隔を空ける必要はない。一方、別々の通知が2秒以内に続き、そのどちらもアナウンスを送る場合は
 * 2通目が429になり得るので、announceAsBot（bot-chat.ts）が送信枠を確保して間隔を空ける。
 * 詰まって待ちきれないときは送らずに投げ、下の sendAndRecordFailure が失敗として記録する。
 *
 * @param messageId 通知のメッセージID。再送で二度送らないための鍵に使う
 * @param botConnected botが接続されているかを調べる。判定を関数で渡すのは、送る動作が1件もないときに
 *   トークンを読まずに済ませるため（チャットの発言では1通ごとにここを通るので、余分なKVの読み出しを増やさない）
 * @param chatMessage 通知がチャットの発言なら、読み取った発言。ほかのイベントなら null
 *   （状態を持つ条件の判定に要る。同じ通知を2か所で読み解かないよう、読み取り済みのものを受け取る）
 * @throws HttpError イベントの中身が想定と違う場合（400。黙って捨てない）
 */
const runAlertActions = async (
  context: Context,
  subscriptionType: string,
  body: Record<string, unknown>,
  messageId: string,
  botConnected: () => Promise<boolean>,
  chatMessage: ChatMessage | null,
): Promise<void> => {
  const { env, now } = context

  const config = await loadAlertConfig(env.STORE)
  // 通知の中身だけでは決まらない条件（初めての発言か・前の発言から空いた日数）は、照合の前にデータベースを見て決める
  const state = await resolveConditionState(env.DB, config, chatMessage, now)
  // 中身の形が違えば「不正な通知」として400で返す（Workerの不具合を表す500と区別する）
  const [message, announcement] = ((): [string | null, StoredAnnounceAction | null] => {
    try {
      return [chatMessageFor(config, subscriptionType, body.event, state), announcementFor(config, subscriptionType, body.event, state)]
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  const aiChat = ((): ReturnType<typeof aiChatFor> => {
    try {
      return aiChatFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  // 素材の再生はbotと関わりなく行う（botを接続していなくてもアラートは鳴る）
  await pushMatchedAlert(context, config, subscriptionType, body, messageId, state)

  if (message === null && announcement === null && aiChat === null) return

  // botを切断していれば送る先がない。受け取り自体は成功として返す
  if (!(await botConnected())) return

  if (message !== null) await sendAndRecordFailure(context, messageId, 'chat', 'alert-chat-failed', () => sendAsBot(context, message))
  if (announcement !== null) {
    await sendAndRecordFailure(context, messageId, 'announce', 'alert-announce-failed', () => announceAsBot(context, announcement))
  }
  if (aiChat !== null) {
    // LLMの応答を待つとTwitchへの2xxが遅れ、同じ通知を再送されてしまう。応答を返してから続きを走らせる
    context.waitUntil(
      recordLateFailure(context, 'alert-aichat-failed', () =>
        sendAndRecordFailure(context, messageId, 'aiChat', 'alert-aichat-failed', () => sendAiChat(context, aiChat, state, chatMessage)),
      ),
    )
  }
}

/**
 * LLMに文面を作らせて、botとしてチャットへ送る。
 *
 * 材料はイベントの中身（alert-event.ts が読み取り済み）と、その人の記録（viewers）である。
 * 記録は「この動作が当てはまったとき」にだけ読むので、発言のたびの読み出しにはならない。
 *
 * 注意: 記録を引く鍵はTwitchのユーザーIDで、それが手元にあるのはチャットの発言の通知だけである
 * （viewers はチャットで発言した人だけを貯めているため、そもそもフォローやレイドの相手には記録がないことが多い）。
 * ほかのイベントでは記録なしとして、指示とイベントの中身だけから文面を作らせる。
 *
 * 注意: 失敗（LLMの失敗・無料枠切れ・500文字超過）は投げたままにして、呼び出し側が記録する。
 * 黙って固定文言に落とすようなことはしない（配信者が気づけなくなるため）。
 */
const sendAiChat = async (
  context: Context,
  aiChat: NonNullable<ReturnType<typeof aiChatFor>>,
  state: ConditionState,
  chatMessage: ChatMessage | null,
): Promise<void> => {
  const { env } = context
  const viewer = chatMessage === null ? null : await readViewer(env.DB, chatMessage.chatterUserId)
  const message = await generateChatMessage(env.AI, { instruction: aiChat.instruction, extracted: aiChat.extracted, viewer, state })
  await sendAsBot(context, message)
}

/**
 * 当てはまるアラートがあれば、配送先（Durable Object）へ押し出す。
 *
 * 素材のURLにはオーバーレイ用キーが要るので、アラートを出す動作を持つトリガーがあるときだけキーを読む
 * （チャットの発言は件数の桁が違うため、1通ごとに余分なKVの読み出しを増やさない）。
 *
 * 注意: 押し出しの失敗は、チャットの送信と同じく2xxのまま記録に残す。2xx以外だとTwitchが同じ通知を再送し、
 * 押し出しが成功していた場合に同じアラートが二度鳴る。
 */
const pushMatchedAlert = async (
  context: Context,
  config: AlertConfig,
  subscriptionType: string,
  body: Record<string, unknown>,
  messageId: string,
  state: ConditionState,
): Promise<void> => {
  const { env, now } = context
  if (!hasAlertAction(config, subscriptionType)) return

  const overlayKey = await loadOverlayKey(env.STORE)
  if (overlayKey === null) {
    await recordFailure(env.DB, 'alert-push-failed', 'オーバーレイ用キーが未発行のため、素材のURLを作れません。管理画面にログインしてください', now)
    return
  }

  // 中身の形が違えば「不正な通知」として400で返す（Workerの不具合を表す500と区別する）
  const alert = ((): ReturnType<typeof alertFor> => {
    try {
      return alertFor(config, subscriptionType, body.event, overlayKey, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  if (alert === null) return

  await sendAndRecordFailure(context, messageId, 'alert', 'alert-push-failed', () => pushAlert(env.ALERTS, alert))
}

/**
 * 鍵を確保してから送り、失敗は記録に残す（通知の受け取り自体は成功として返す）。
 *
 * 鍵の確保を送信より先に行うのは、Twitchの再送で同じお礼を二度送らないため。
 * 鍵に動作の種類を混ぜるのは、同じ通知でチャットとアナウンスの両方を送るときに、片方が鍵を取って
 * もう片方が送れなくなるのを防ぐため。
 */
/**
 * Twitchへ応答を返したあとに走らせる処理から、失敗を取りこぼさないようにする。
 *
 * ほかの動作は送信を待ってから応答を返すので、鍵の確保のような送信の手前での失敗は例外として上がり、
 * 5xxを受けたTwitchが同じ通知を再送してくれる（鍵があるので二重送信にはならない）。
 * 応答のあとに走らせる処理ではその手が使えず、投げたままでは誰も受け取らないまま消えてしまうので、
 * ここで受け止めて記録まで引き受ける。
 *
 * 注意: 記録そのものが失敗したら（データベースに触れないときなど）、もう打つ手がないのでログに残すだけにする。
 */
const recordLateFailure = async (context: Context, failureCode: string, run: () => Promise<void>): Promise<void> => {
  const { env, now } = context
  try {
    await run()
  } catch (error) {
    try {
      await recordFailure(env.DB, failureCode, error instanceof Error ? error.message : String(error), now)
    } catch (failure) {
      console.error(failure)
    }
  }
}

const sendAndRecordFailure = async (
  context: Context,
  messageId: string,
  actionType: 'chat' | 'announce' | 'alert' | 'aiChat',
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
      // チャットは記録せず応答に回す（そちらでもトリガーにかける）。ほかのイベントは配信の記録として数えたうえで、アラートのトリガーにかける
      const { type } = readSubscription(body)
      if (type === CHAT_MESSAGE) await replyToChatMessage(context, body)
      else {
        await recordNotification({ db: env.DB, messageId, occurredAt, body })
        await runAlertActions(context, type, body, messageId, async () => (await loadToken(env.STORE, 'bot')) !== null, null)
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
