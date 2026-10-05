/**
 * EventSubのWebhookの受け口（POST /api/eventsub/webhook）
 *
 * TwitchからWorkerへ直接届く通知を受け、配信の記録（イベントの件数、配信の開始・終了）としてデータベースへ書く。
 * 誰でも呼べるURLなので、署名（EVENTSUB_SECRET によるHMAC）でTwitchからの通知であることを確かめ、古い通知は受け付けない。
 * 同じ通知の再送は、メッセージIDによって二重に数えない（stats-store.ts）。
 *
 * 注意: 2xx 以外を返すとTwitchは再送し、失敗が続くと購読を失効させる。想定しない通知を黙って捨てず、失敗として返す（Fail-Fast）。
 */
import { scheduleAdBreakEnd } from './ad-break-timer'
import { runAlertActions } from './alert-actions'
import { loadAlertConfig } from './alert-config'
import { sendAsBot } from './bot-chat'
import { applyReply, findCommand, needsBgmCredit, needsStreamSummary, needsWorkTime, readChatMessage, type ChatMessage } from './chat-command'
import { loadBgmPlayback, loadBgmTracks, playingTrackOf } from './bgm-config'
import { loadBotConfig } from './bot-config'
import { punishAsBot } from './bot-moderation'
import { judge, repeatRuleOf } from './chat-moderation'
import { recordStreamChatMessage, removeModeratedStreamChat } from './stream-chat-store'
import { applyModerationToTaskDesk, handleTaskDeskCommand } from './task-desk-command'
import { readCurrentWorkTime } from './task-desk-store'
import { readCurrentStreamSummary } from './stream-summary-store'
import { recordViewerMessage } from './viewer-store'
import { answeredPrefectureOf } from '../src/town-tour/quiz'
import { pushTownTourAnswer } from './alert-channel'
import { answerTownTourQuiz } from './town-tour-quiz'
import { loadModerationConfig } from './moderation-config'
import { claimFirstChatOfStream, consumeCooldown, recordAndCountRecentMessage, reserveChatReply } from './chat-store'
import { pushFeedItem } from './comment-channel'
import { toFeedItem } from './comment-feed'
import {
  AD_BREAK_BEGIN,
  CHAT_MESSAGE,
  COUNTED_EVENT_TYPES,
  FEED_ONLY_EVENT_TYPES,
  STREAM_OFFLINE,
  STREAM_ONLINE,
  UNCOUNTED_EVENT_TYPES,
  verifyWebhookSignature,
} from './eventsub-webhook'
import { HttpError, STATUS, type Context } from './http'
import { recordEvent, recordFailure, recordStreamOffline, recordStreamOnline } from './stats-store'
import { loadToken, type StoredToken } from './token'

export const WEBHOOK_PATH = '/api/eventsub/webhook'

const HEADER = {
  messageId: 'Twitch-Eventsub-Message-Id',
  timestamp: 'Twitch-Eventsub-Message-Timestamp',
  signature: 'Twitch-Eventsub-Message-Signature',
  messageType: 'Twitch-Eventsub-Message-Type',
} as const

/** これより古い通知は受け付けない（ミリ秒）。盗み見た通知の使い回しへの備えで、Twitchの案内どおり10分 */
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000

/** 秒で届く値（広告の長さ）をミリ秒に直すための倍率 */
const MILLISECONDS_PER_SECOND = 1000

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
  // アラートやコメントビューアーのために購読しているだけで、件数は数えないイベント（フォロー）。記録することはないが、拒否もしない
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
 *
 * @param bot bot のトークン。botを切断した直後など、購読が残っていても応答できないことがある（null）。
 *   アラートの再生にbotは要らないので、そのときは自動モデレーションとコマンドの応答だけを飛ばし、トリガーの判定は続ける
 */
const replyToChatMessage = async (context: Context, body: Record<string, unknown>, bot: StoredToken | null): Promise<void> => {
  const { env, now } = context
  // 通知の中身が想定と違えば、黙って捨てずに「不正な通知」として400で返す（Workerの不具合を表す500と区別する）
  const message = readChatMessage(body.event, invalid)

  // このWorkerが扱う配信者以外のチャンネルのチャットには応答しない。
  // 応答先は常に TWITCH_BROADCASTER_ID なので、古い購読が残っていると、他人のチャットの発言に対して
  // こちらのチャンネルで応答してしまう。受け取り自体は成功として返す（2xx以外だとTwitchが再送し続ける）。
  // Shared Chat の相手チャンネルで書かれた発言もここで外す（発言があったチャンネルは readChatMessage が書かれた側を返す）。
  // 記録・LLMの材料・自動モデレーション・トリガー・コマンドはどれも自チャンネルの視聴者のためのものだからである（issue #205）
  if (message.broadcasterUserId !== env.TWITCH_BROADCASTER_ID) return

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
  }

  // 自動モデレーションはコマンドの応答より先に判定する。処分した発言には応答もトリガーも返さない
  if (bot && (await moderateChatMessage(context, message, bot.userId))) return

  // bot自身の発言ではトリガーを引かない。引くと、その応答にまた反応して止まらなくなる（コマンドの応答と同じ考え方）
  if (message.chatterUserId === bot?.userId) return

  // 配信中なら、人物像（viewers の summary）やサイドスーパー・あらすじ・章立ての材料として本文も貯める。配信が終わったあとに
  // cron が人ごとにまとめて人物像を作り、使い終えた材料を消す（stream-chat-store.ts・collect.ts）。
  // チャットの全文は貯めないという方針の、意識して設けた例外である（集計値だけでは人物像を作れないため）。
  // 視聴者の記録と違って自動モデレーションのあとに貯めるのは、処分した発言をLLMの材料に混ぜないためである（issue #202）
  await recordStreamChatMessage(env.DB, { messageId: message.messageId, userId: message.chatterUserId, text: message.text }, now)

  // botの接続はもう調べ済みなので、判定の関数はその結果を返すだけでよい
  await runAlertActions(context, CHAT_MESSAGE, body, message.messageId, () => Promise.resolve(bot !== null), message)

  // 市町村紹介の冒頭の都道府県当てクイズ（issue #251）。都道府県を1つだけ書いた発言のときだけ、受け付けている出題と照らす
  // （チャットの全件でD1を読まないため）。bot と処分した発言は上で外れているので、回答にならない
  await answerTownTourQuizFromChat(context, message)

  // 作業机の組み込みのコマンド（!task・!done。issue #207）は、登録したコマンドより先に見る（同じ名前は登録させない）。
  // 作業机に並べるのに bot は要らないので、bot が無くても宣言は残す（受け付けない理由だけは返せない）
  const taskDeskContext = { db: env.DB, alerts: env.ALERTS, now, reply: bot ? (text: string) => sendAsBot(context, text) : null }
  if (await handleTaskDeskCommand(taskDeskContext, message)) return

  if (!bot) return

  // コマンドに一致しない発言では、ここから先へ進まない（チャットの全件をD1に書かないため）
  const { commands } = await loadBotConfig(env.STORE)
  const command = findCommand(commands, message, bot.userId)
  if (!command) return

  // 流している曲（issue #152）は、{bgm} を使う応答文のときだけ読む。止めているときは null のままで、応答文にはその旨が入る。
  // 鍵の確保とクールダウンより先に読むのは、読めずに投げたときに応答の機会を使い切らないため（再送で応答し直せる）
  const bgm = needsBgmCredit(command) ? playingTrackOf(await loadBgmTracks(env.STORE), await loadBgmPlayback(env.STORE)) : null

  // 鍵の確保はクールダウンの判定より先に行う。逆にすると、再送のたびに最後に使った時刻が更新され、いつまでも応答できなくなる
  if (!(await reserveChatReply(env.DB, message.messageId, now))) return
  if (!(await consumeCooldown(env.DB, command.name, command.cooldownSeconds, now))) return

  // あらすじ（issue #65）は、それを使う応答文のときだけ読む。使っていないコマンドのために毎回D1を読まない。
  // 貯めてあるものをそのまま返すだけなので、ここでLLMは呼ばない（応答を待たせないため）。
  // 配信していない・まだ作っていないときは null のままで、応答文にはその旨が入る（無応答にはしない）
  const summary = needsStreamSummary(command) ? ((await readCurrentStreamSummary(env.DB, now))?.summary ?? null) : null
  // 作業した時間の合計（issue #209）も、{worktime} を使う応答文のときだけ読む。記録が無いときは null のままで、応答文にはその旨が入る
  const workTime = needsWorkTime(command) ? await readCurrentWorkTime(env.DB, now) : null

  try {
    // 組み立ても try の中で行う。上限を縮める前に保存した長い曲では {bgm} の組み立てが投げるので、その理由も失敗として記録する
    await sendAsBot(context, applyReply(command, message, summary, bgm, workTime))
  } catch (error) {
    await recordFailure(env.DB, 'chat-reply-failed', error instanceof Error ? error.message : String(error), now)
  }
}

/**
 * チャットの発言を、市町村紹介の冒頭の都道府県当てクイズの回答として照らす（issue #251）。
 *
 * 発言に都道府県が1つだけ書かれていれば、受け付けている出題と照らし、最初の正解者なら合成ページへ押し出す
 * （worker/town-tour-quiz.ts。2人目以降と、時間切れの後の回答は押し出さない）。
 *
 * 注意: 押し出しの失敗は投げる。正解者はもう記録されているので、Twitch が再送しても二度は押し出さない
 * （画面に正解者が出ないだけで、時間切れの扱いで紹介は続く）。
 */
const answerTownTourQuizFromChat = async (context: Context, message: ChatMessage): Promise<void> => {
  const prefecture = answeredPrefectureOf(message.text)
  if (prefecture === null) return
  const quizIds = await answerTownTourQuiz(context.env.DB, { prefecture, userName: message.chatterUserName }, context.now)
  for (const quizId of quizIds) await pushTownTourAnswer(context.env.ALERTS, { quizId, userName: message.chatterUserName })
}

/**
 * チャットの発言が、その配信で初めての発言か（コメントビューアーで挨拶の相手として印を付けるか）を判定する。
 *
 * 初めての発言なら first_chatters に記録する（chat-store.ts の claimFirstChatOfStream）。同じ発言について
 * トリガーの判定（alert-state.ts）がもう一度問い合わせても同じ答えが返るので、ここで先に記録してかまわない。
 * トリガーが1件も無くても判定する（挨拶の管理は通知音の有無と関係ないため。書き込むのは1配信につき1人1行）。
 *
 * 注意: 配信者自身と bot の発言は挨拶の相手ではないので、判定も記録もしない。
 * Shared Chat の相手チャンネルで書かれた発言も、自チャンネルの視聴者ではないので同じく扱う。
 */
const isFirstChatToGreet = async (context: Context, event: unknown, bot: StoredToken | null): Promise<boolean> => {
  const { env, now } = context
  // 発言の読み取りはコマンドの判定と同じものを使う（同じ通知を2か所で読み解かない）
  const message = readChatMessage(event)
  // Shared Chat の相手チャンネルで書かれた発言は、自チャンネルの初めての発言として数えない（issue #205）
  if (message.broadcasterUserId !== env.TWITCH_BROADCASTER_ID) return false
  if (message.chatterUserId === env.TWITCH_BROADCASTER_ID || message.chatterUserId === bot?.userId) return false
  return claimFirstChatOfStream(env.DB, { chatterUserId: message.chatterUserId, messageId: message.messageId }, now)
}

/**
 * 通知がこのWorkerの扱う配信者のチャンネルのものか。
 *
 * 古い購読が残っていると他人のチャンネルの通知も届くので、それを並べたり作業机を消したりしないために見る。
 * broadcaster_user_id を持たない通知は、ここでは除かない（中身の確かめは読み取る側が受け持つ）。
 */
const isOwnChannelEvent = ({ env }: Context, event: unknown): boolean =>
  !(isRecord(event) && typeof event.broadcaster_user_id === 'string' && event.broadcaster_user_id !== env.TWITCH_BROADCASTER_ID)

/**
 * モデレーションの削除の通知（発言の削除・ある人の発言の一掃・チャットのクリア）を、LLMの材料（stream_chat_messages）に反映する（issue #202）。
 *
 * 消された発言を、サイドスーパー・あらすじ・章立て・人物像の材料に残さないためである。ほかの種類の通知では何もしない。
 * 通知の読み取りはコメントビューアーと同じ toFeedItem を使う（同じ通知を2か所で読み解かない）。
 *
 * 注意: 失敗は握りつぶさずに投げ、Twitch に再送させる。消すのは何度行っても同じ結果になり、コメントビューアーの
 * 並べ方も同じ通知を二度当てはめないので、再送で困ることはない。消し損ねたまま2xxを返すと、材料に残り続けてしまう。
 */
const applyModerationToStreamChat = async ({ env, now }: Context, type: string, event: unknown): Promise<void> => {
  // 目印（id・at）は材料の削除では使わないので、読み取りのためだけに埋める
  const item = toFeedItem(type, event, { id: '', at: now }, false)
  if (item === null || (item.kind !== 'delete' && item.kind !== 'clearUser' && item.kind !== 'clear')) return
  await removeModeratedStreamChat(env.DB, item, now)
}

/**
 * 通知をコメントビューアー（/comments/）に並べる1件に直し、配送先へ押し出す。
 *
 * ほかの処理（自動モデレーション・トリガー・応答）より先に呼ぶ。発言より先に、その発言を消した通知が
 * 画面へ届くと、消す相手が見つからずに残ってしまうためである。
 *
 * このWorkerが扱う配信者以外のチャンネルの通知は押し出さない（古い購読が残っていても、他人のチャットを並べない）。
 *
 * 注意: 直せなかった・押し出せなかったときも、Twitchへは2xxを返して収集の失敗として記録する。
 * コメントビューアーは配信者が見るためのもので、そのためにトリガーや応答を止めない（アラートの配送と同じ扱い）。
 * 再送で同じ1件を2度押し出すことはあるが、画面が通知のメッセージIDで見分ける。
 * 初めての発言かの判定（isFirstChatToGreet）に失敗したときも同じ扱いにする（印を付けずに流すことはしない）。
 *
 * @param bot チャットの発言のときに、bot 自身の発言を見分けるための bot のトークン（未接続・読めなかったときは null。
 *   読めなかったときは bot 自身の発言にも初めての発言の印が付きうるが、応答の側が失敗にするので Twitch が再送する）
 */
const pushToCommentFeed = async (
  context: Context,
  type: string,
  body: Record<string, unknown>,
  messageId: string,
  occurredAt: number,
  bot: StoredToken | null,
): Promise<void> => {
  const { env, now } = context
  const { event } = body
  if (!isOwnChannelEvent(context, event)) return
  try {
    const firstOfStream = type === CHAT_MESSAGE && (await isFirstChatToGreet(context, event, bot))
    const item = toFeedItem(type, event, { id: messageId, at: occurredAt }, firstOfStream)
    if (item !== null) await pushFeedItem(env.COMMENTS, item)
  } catch (error) {
    await recordFailure(env.DB, 'comment-feed-failed', error instanceof Error ? error.message : String(error), now)
  }
}

/**
 * 広告の開始の通知から「広告が終わる時刻」を読み、終了のトリガーがあればタイマーへ預ける。
 *
 * Twitchには広告の終了に相当する通知がないため、終わる時刻は開始の通知（started_at と duration_seconds）から
 * 自前で出す。預け先は Durable Object で、時刻が来るとアラームで起きて擬似イベントとして照合へ回す
 * （worker/ad-break-timer.ts）。
 *
 * 終了のトリガーが1件もなければ預けない。鳴らす先がないタイマーで Durable Object を起こさないためである
 * （アラートを出す動作があるときだけオーバーレイ用キーを読むのと同じ考え方）。
 *
 * 注意: 預けるのに失敗しても、Twitchへは2xxを返して収集の失敗として記録する。2xx以外だとTwitchが同じ通知を再送し、
 * 開始の告知が二度送られてしまう（終了の告知が1回出ないことより悪い）。
 *
 * @throws HttpError 通知の中身に started_at・duration_seconds が揃っていない場合（400。黙って捨てない）
 */
const scheduleAdBreakEndIfNeeded = async (context: Context, body: Record<string, unknown>, messageId: string): Promise<void> => {
  const { env, now } = context
  const config = await loadAlertConfig(env.STORE)
  // 広告の終了を待つトリガーが1件も無ければ、鳴らす先の無いタイマーで Durable Object を起こさない
  if (!config.triggers.some((trigger) => trigger.kind === 'adBreakEnd')) return

  const { event } = body
  if (!isRecord(event)) throw invalid('広告の開始の通知に event がありません')
  const startedAt = typeof event.started_at === 'string' ? Date.parse(event.started_at) : Number.NaN
  const durationSeconds = event.duration_seconds
  if (Number.isNaN(startedAt) || typeof durationSeconds !== 'number') {
    throw invalid('広告の開始の通知に started_at・duration_seconds が揃っていません')
  }

  try {
    await scheduleAdBreakEnd(env.AD_BREAKS, { event, messageId, endsAt: startedAt + durationSeconds * MILLISECONDS_PER_SECOND })
  } catch (error) {
    await recordFailure(env.DB, 'ad-break-end-schedule-failed', error instanceof Error ? error.message : String(error), now)
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
      // まずコメントビューアーへ押し出す。そのうえで、チャットは記録せず応答に回す（そちらでもトリガーにかける）。
      // ほかのイベントは配信の記録として数えたうえで、アラートのトリガーにかける
      const { type } = readSubscription(body)
      // bot のトークンはチャットの発言のときだけ1度読み、配送（bot 自身の発言を見分ける）と応答の両方で使う。
      // 読めなかったとき、配送は bot を見分けずに続ける（コメントビューアーを止めない）。応答の側はこれまでどおり
      // 失敗として投げ、Twitch に再送させる（壊れたトークンのまま、自動モデレーションやコマンドを黙って飛ばさない）
      const botLoad = type === CHAT_MESSAGE ? loadToken(env.TOKENS, 'bot') : Promise.resolve(null)
      await pushToCommentFeed(context, type, body, messageId, occurredAt, await botLoad.catch(() => null))
      // コメントビューアーのためだけに購読している通知は、記録もトリガーの判定もしない。
      // ただしモデレーションの削除は作業机とLLMの材料にも反映する（荒らしが書いた文言を配信画面に残さない）
      if (FEED_ONLY_EVENT_TYPES.includes(type)) {
        if (isOwnChannelEvent(context, body.event)) {
          await applyModerationToTaskDesk({ db: env.DB, alerts: env.ALERTS, now }, type, body.event)
          await applyModerationToStreamChat(context, type, body.event)
        }
        return new Response(null, { status: STATUS.noContent })
      }
      if (type === CHAT_MESSAGE) await replyToChatMessage(context, body, await botLoad)
      else {
        await recordNotification({ db: env.DB, messageId, occurredAt, body })
        await runAlertActions(context, type, body, messageId, async () => (await loadToken(env.TOKENS, 'bot')) !== null, null)
        // 広告は開始しか届かないので、終了の告知に使う時刻をここで預ける（開始の告知そのものは上で済んでいる）
        if (type === AD_BREAK_BEGIN) await scheduleAdBreakEndIfNeeded(context, body, messageId)
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
