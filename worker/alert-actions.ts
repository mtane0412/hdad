/**
 * アラートのトリガーに当てはまった動作の実行
 *
 * 「どのトリガーに当てはまるか」を決めるのは worker/alert-event.ts で、ここはその結果を受けて
 * 実際に送る・押し出すところだけを受け持つ。呼び出し口は2つある。
 * - Webhookの受け口（worker/webhook-routes.ts）。Twitchから届いた通知をそのまま渡す
 * - 広告の終了のタイマー（worker/ad-break-timer.ts）。Twitchから届かない擬似イベントを渡す
 *
 * 受け口から切り出してあるのは、この2つ目のためである（Durable Object のアラームからも同じ実行を通す）。
 * そのため受け取る文脈はリクエストに関わる項目（request・url・params）を含まない形に絞っている。
 *
 * 注意: 送ると決めたあとの失敗は、Twitchへの応答を2xxのままにして記録に残す。
 * 2xx以外を返すとTwitchは同じ通知を再送するので、送信が成功していた場合に二重投稿になってしまう。
 */
import { loadAlertConfig, type AlertConfig, type StoredAnnounceAction } from './alert-config'
import { pushAlert } from './alert-channel'
import { generateChatMessage } from './ai-chat'
import { aiChatsFor, alertsFor, announcementsFor, chatMessagesFor, hasAlertAction, requiresStreamSummary } from './alert-event'
import { resolveConditionState } from './alert-state'
import type { ConditionState } from './alert-event'
import { announceAsBot, sendAsBot } from './bot-chat'
import type { ChatMessage } from './chat-command'
import { reserveChatReply } from './chat-store'
import { HttpError, STATUS, type Context } from './http'
import { loadOverlayKey } from './overlay-key'
import { recordFailure } from './stats-store'
import { readCurrentStreamSummary } from './stream-summary-store'
import { readViewer } from './viewer-store'

/**
 * 動作の実行に要る文脈。
 *
 * リクエストに関わる項目（request・url・params）は使わないので受け取らない。
 * Durable Object のアラーム（worker/ad-break-timer.ts）からも呼べるようにするためである。
 */
export type AlertActionContext = Pick<Context, 'env' | 'twitch' | 'llm' | 'now' | 'wait' | 'waitUntil'>

const invalid = (message: string): HttpError => new HttpError(STATUS.badRequest, 'invalid-webhook', message)

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
export const runAlertActions = async (
  context: AlertActionContext,
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
  // あらすじ（{summary}）も通知の中身では決まらないので、差し込む文言を持つトリガーがあるときだけ先に読む。
  // 読むのはここ1回だけで、チャット・アナウンス・アラートの差し込みで使い回す（コマンドの応答と同じく、ここでLLMは呼ばない）
  const summary = requiresStreamSummary(config, subscriptionType) ? ((await readCurrentStreamSummary(env.DB, now))?.summary ?? null) : null
  // 中身の形が違えば「不正な通知」として400で返す（Workerの不具合を表す500と区別する）
  const [messages, announcements] = ((): [string[], StoredAnnounceAction[]] => {
    try {
      return [
        chatMessagesFor(config, subscriptionType, body.event, state, summary),
        announcementsFor(config, subscriptionType, body.event, state, summary),
      ]
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  const aiChats = ((): ReturnType<typeof aiChatsFor> => {
    try {
      return aiChatsFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  // 素材の再生はbotと関わりなく行う（botを接続していなくてもアラートは鳴る）
  await pushMatchedAlerts(context, config, subscriptionType, body, messageId, state, summary)

  if (messages.length === 0 && announcements.length === 0 && aiChats.length === 0) return

  // botを切断していれば送る先がない。受け取り自体は成功として返す
  if (!(await botConnected())) return

  // 当てはまった行はすべて実行する。鍵には並びの位置を混ぜ、同じ通知で2通送るときに片方が送れなくならないようにする
  for (const [index, message] of messages.entries()) {
    await sendAndRecordFailure(context, messageId, 'chat', index, 'alert-chat-failed', () => sendAsBot(context, message))
  }
  for (const [index, announcement] of announcements.entries()) {
    await sendAndRecordFailure(context, messageId, 'announce', index, 'alert-announce-failed', () => announceAsBot(context, announcement))
  }
  for (const [index, aiChat] of aiChats.entries()) {
    // LLMの応答を待つとTwitchへの2xxが遅れ、同じ通知を再送されてしまう。応答を返してから続きを走らせる
    context.waitUntil(
      recordLateFailure(context, 'alert-aichat-failed', () =>
        sendAndRecordFailure(context, messageId, 'aiChat', index, 'alert-aichat-failed', () => sendAiChat(context, aiChat, state, chatMessage, summary)),
      ),
    )
  }
}

/**
 * LLMに文面を作らせて、botとしてチャットへ送る。
 *
 * 材料はイベントの中身（alert-event.ts が読み取り済み）と、その人の記録（viewers）と、
 * いま進んでいる配信のあらすじである。記録は「この動作が当てはまったとき」にだけ読むので、発言のたびの読み出しにはならない。
 * あらすじは呼び出し側が読んだものを受け取る（固定文言の差し込みと同じ1回の読み出しを使い回す）。
 *
 * 注意: 記録を引く鍵はTwitchのユーザーIDで、それが手元にあるのはチャットの発言の通知だけである
 * （viewers はチャットで発言した人だけを貯めているため、そもそもフォローやレイドの相手には記録がないことが多い）。
 * ほかのイベントでは記録なしとして、指示とイベントの中身だけから文面を作らせる。
 *
 * 注意: 失敗（LLMの失敗・無料枠切れ・500文字超過）は投げたままにして、呼び出し側が記録する。
 * 黙って固定文言に落とすようなことはしない（配信者が気づけなくなるため）。
 */
const sendAiChat = async (
  context: AlertActionContext,
  aiChat: ReturnType<typeof aiChatsFor>[number],
  state: ConditionState,
  chatMessage: ChatMessage | null,
  streamSummary: string | null,
): Promise<void> => {
  const { env, llm } = context
  const viewer = chatMessage === null ? null : await readViewer(env.DB, chatMessage.chatterUserId)
  const message = await generateChatMessage(llm, { instruction: aiChat.instruction, extracted: aiChat.extracted, viewer, state, streamSummary })
  await sendAsBot(context, message)
}

/**
 * 当てはまるアラートがあれば、配送先（Durable Object）へすべて押し出す。
 *
 * 素材のURLにはオーバーレイ用キーが要るので、アラートを出す動作を持つトリガーがあるときだけキーを読む
 * （チャットの発言は件数の桁が違うため、1通ごとに余分なKVの読み出しを増やさない）。
 *
 * 注意: 押し出しの失敗は、チャットの送信と同じく2xxのまま記録に残す。2xx以外だとTwitchが同じ通知を再送し、
 * 押し出しが成功していた場合に同じアラートが二度鳴る。
 *
 * @param summary 画面に出す文言に差し込む配信のあらすじ。呼び出し側が読んだものを受け取る
 *   （チャット・アナウンスと同じ値を使い回し、同じ通知でデータベースを二度読まない）
 */
const pushMatchedAlerts = async (
  context: AlertActionContext,
  config: AlertConfig,
  subscriptionType: string,
  body: Record<string, unknown>,
  messageId: string,
  state: ConditionState,
  summary: string | null,
): Promise<void> => {
  const { env, now } = context
  if (!hasAlertAction(config, subscriptionType)) return

  const overlayKey = await loadOverlayKey(env.STORE)
  if (overlayKey === null) {
    await recordFailure(env.DB, 'alert-push-failed', 'オーバーレイ用キーが未発行のため、素材のURLを作れません。管理画面にログインしてください', now)
    return
  }

  // 中身の形が違えば「不正な通知」として400で返す（Workerの不具合を表す500と区別する）
  const alerts = ((): ReturnType<typeof alertsFor> => {
    try {
      return alertsFor(config, subscriptionType, body.event, overlayKey, state, summary)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()

  // 当てはまった行はすべて押し出す。オーバーレイは受け取った順に並べて再生する（src/alerts/queue.ts）
  for (const [index, alert] of alerts.entries()) {
    await sendAndRecordFailure(context, messageId, 'alert', index, 'alert-push-failed', () => pushAlert(env.ALERTS, alert))
  }
}

/**
 * 鍵を確保してから送り、失敗は記録に残す（通知の受け取り自体は成功として返す）。
 *
 * 鍵の確保を送信より先に行うのは、Twitchの再送で同じお礼を二度送らないため。
 * 鍵に動作の種類を混ぜるのは、同じ通知でチャットとアナウンスの両方を送るときに、片方が鍵を取って
 * もう片方が送れなくなるのを防ぐため。当てはまった行をすべて実行するので、同じ種類の動作が同じ通知で
 * 何度も走る。そのため並びの位置（index）も混ぜる。位置は当てはまった動作の並び順なので、
 * 同じ設定と同じ通知であれば再送でも同じ鍵になる（設定を書き換えたあとの再送では鍵がずれるが、
 * それは設定を書き換えたこと自体の帰結であり、二重送信を防ぐ範囲はTwitchの再送に限る）。
 */
/**
 * Twitchへ応答を返したあとに走らせる処理から、失敗を取りこぼさないようにする。
 *
 * ほかの動作は送信を待ってから応答を返すので、鍵の確保のような送信の手前での失敗は例外として上がり、
 * 5xxを受けたTwitchが同じ通知を再送してくれる（鍵があるので二重送信にはならない）。
 * 応答のあとに走らせる処理ではその手が使えず、投げたままでは誰も受け取らないまま消えてしまうので、
 * ここで受け止めて記録まで引き受ける。
 *
 * 広告の終了のタイマー（worker/ad-break-timer.ts）も同じ立場にある。アラームが鳴った時点で予約を消しているので、
 * そこから先の失敗は再試行では取り返せない。そのためアラームの実行そのものもこれで包む。
 *
 * 注意: 記録そのものが失敗したら（データベースに触れないときなど）、もう打つ手がないのでログに残すだけにする。
 */
export const recordLateFailure = async (context: AlertActionContext, failureCode: string, run: () => Promise<void>): Promise<void> => {
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
  context: AlertActionContext,
  messageId: string,
  actionType: 'chat' | 'announce' | 'alert' | 'aiChat',
  index: number,
  failureCode: string,
  send: () => Promise<void>,
): Promise<void> => {
  const { env, now } = context
  if (!(await reserveChatReply(env.DB, `${messageId}:${actionType}:${index}`, now))) return

  try {
    await send()
  } catch (error) {
    await recordFailure(env.DB, failureCode, error instanceof Error ? error.message : String(error), now)
  }
}

