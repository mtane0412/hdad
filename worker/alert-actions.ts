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
import { pushAlert, pushLick, pushVrm, pushTownTour, pushTwister } from './alert-channel'
import { AI_CHAT_COOLDOWN_SECONDS, AI_CHAT_DAILY_LIMIT, generateChatMessage } from './ai-chat'
import {
  aiChatsFor,
  alertsFor,
  announcementsFor,
  chatDeductionsFor,
  chatMessagesFor,
  dollGrantsFor,
  hasAlertAction,
  kanjiQuizzesFor,
  licksFor,
  vrmsFor,
  requiresStreamSummary,
  shoutoutsFor,
  townToursFor,
  twistersFor,
} from './alert-event'
import { resolveConditionState } from './alert-state'
import type { ConditionState } from './alert-event'
import { announceAsBot, sendAsBot, shoutoutAsBot } from './bot-chat'
import type { ChatMessage } from './chat-command'
import { consumeCooldown, reserveChatReply } from './chat-store'
import { grantDolls } from './doll-award'
import { countLlmCalls, toUtcDay } from './llm-usage-store'
import { HttpError, STATUS, type Context } from './http'
import { loadOverlayKey } from './overlay-key'
import { latestViewerCount, recordFailure } from './stats-store'
import { readCurrentStreamSummary } from './stream-summary-store'
import { pickTown, townTourCallOf } from './town-tour-call'
import { listTownTourVisits } from './town-tour-visits'
import { loadTownTourNarration } from './town-tour-narration'
import { loadTownTourSound, playbackSoundOf } from './town-tour-sound'
import { issueKanjiQuiz } from './kanji-quiz-issue'
import { CHAT_DEDUCTION_PROBLEM_SETS } from '../src/chat-deduction/problem-set'
import { pickConfiguredChatDeductionProblem } from './chat-deduction-pick'
import { startChatDeductionGame } from './chat-deduction-start'
import { loadKanjiQuizMissLimit } from './kanji-quiz-miss-limit'
import { loadKanjiQuizSound, playbackKanjiQuizSoundOf } from './kanji-quiz-sound'
import { lickCallOf, lickSeedOf } from './lick-call'
import type { TriggerKind } from './trigger-menu'
import { vrmCallOf, vrmReactionOf, vrmSeedOf } from './vrm-call'
import { loadVrmModel, playbackVrmModelOf } from './vrm-model'
import { loadLickSound, playbackLickSoundOf } from './lick-sound'
import { twisterCallOf, twisterSeedOf } from './twister-call'
import { loadTwisterSound, playbackTwisterSoundOf } from './twister-sound'
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
 * 配送先（Durable Object）へ押し出す。チャット・アナウンス・シャウトアウトはWorkerがbotとして行うので、
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
  const shoutouts = ((): ReturnType<typeof shoutoutsFor> => {
    try {
      return shoutoutsFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  const townTours = ((): ReturnType<typeof townToursFor> => {
    try {
      return townToursFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  // 素材の再生はbotと関わりなく行う（botを接続していなくてもアラートは鳴る）
  await pushMatchedAlerts(context, config, subscriptionType, body, messageId, state, summary)
  // 市町村紹介も素材が流すので、botの接続を見る前に押し出す。市町村は1件ごとに引き直す（紹介を作るのは素材が受け取ってから）。
  // 音とナレーション（issue #255）の設定とオーバーレイ用キーと、人口と比べる同接と、紹介済みの市町村（issue #252）は、当てはまった行があるときだけ読む
  // （チャットの発言のたびにKVとD1を読まないため）
  if (townTours.length > 0) {
    const [sound, narration, overlayKey, liveViewers, visited] = await Promise.all([
      loadTownTourSound(env.STORE),
      loadTownTourNarration(env.STORE),
      loadOverlayKey(env.STORE),
      latestViewerCount(env.DB),
      listTownTourVisits(env.DB),
    ])
    const visitedCodes = new Set(visited)
    for (const [index, townTour] of townTours.entries()) {
      // 同じ通知で2回以上流すとき、まだ記録されていない先の市町村を続けて引かないよう、引いたものは次の抽選から除く
      const town = pickTown(Math.random, visitedCodes)
      visitedCodes.add(town.code)
      // キーが未発行で音のURLを作れないときも、押し出しの失敗として記録する（黙って無音で流さない）
      await sendAndRecordFailure(context, messageId, 'townTour', index, 'town-tour-push-failed', () =>
        pushTownTour(env.ALERTS, townTourCallOf(town, townTour, playbackSoundOf(sound, overlayKey), liveViewers, crypto.randomUUID(), visited, narration.enabled)),
      )
    }
  }

  // ツイスター（issue #272）も素材が流すので、botの接続を見る前に押し出す。アイコンはレイド元と配信者の2人ぶんを1回で引き、
  // 対戦の種は1回ごとに引き直す。アイコンを引けなければ押し出さずに失敗として記録する（顔の無い対戦を黙って流さない）
  const twisters = ((): ReturnType<typeof twistersFor> => {
    try {
      return twistersFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  // BGM の設定とオーバーレイ用キーは、当てはまった行があるときだけ読む（チャットの発言のたびにKVを読まないため）
  if (twisters.length > 0) {
    const [sound, overlayKey] = await Promise.all([loadTwisterSound(env.STORE), loadOverlayKey(env.STORE)])
    for (const [index, twister] of twisters.entries()) {
      await sendAndRecordFailure(context, messageId, 'twister', index, 'twister-push-failed', async () => {
        // キーが未発行で BGM のURLを作れないときも、押し出しの失敗として記録する（黙って無音で流さない）
        const playbackSound = playbackTwisterSoundOf(sound, overlayKey)
        const { twitch } = context
        const icons = await twitch.getProfileImageUrls(await twitch.getAppAccessToken(), [twister.raiderId, env.TWITCH_BROADCASTER_ID])
        const seed = twisterSeedOf(crypto.getRandomValues(new Uint32Array(1)))
        await pushTwister(env.ALERTS, twisterCallOf(twister, icons, env.TWITCH_BROADCASTER_ID, playbackSound, seed, crypto.randomUUID()))
      })
    }
  }

  // 漢字クイズ（issue #300）も素材が流すので、botの接続を見る前に押し出す。問題は1件ごとに設定の級から、同じ配信で出していないものを選び直す。
  // その級の問題が問題集に無いとき・同じ配信で出しきったときも、押し出しの失敗として記録する（ほかの級から・重複して黙って出さない。issue #301）
  const kanjiQuizzes = ((): ReturnType<typeof kanjiQuizzesFor> => {
    try {
      return kanjiQuizzesFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  // 音の設定・配信を止めるまでの時間切れの回数・オーバーレイ用キーは、当てはまった行があるときだけ読む（チャットの発言のたびにKVを読まないため）。
  // 読めなかったときも漢字クイズの押し出しの失敗として記録し、ほかの動作は続けるよう、1件ごとの失敗の境界の中で読む
  for (const [index, kanjiQuiz] of kanjiQuizzes.entries()) {
    await sendAndRecordFailure(context, messageId, 'kanjiQuiz', index, 'kanji-quiz-push-failed', async () => {
      const [sound, { missLimit }, overlayKey] = await Promise.all([loadKanjiQuizSound(env.STORE), loadKanjiQuizMissLimit(env.STORE), loadOverlayKey(env.STORE)])
      // キーが未発行で音のURLを作れないときも、押し出しの失敗として記録する（黙って無音で流さない）
      const playbackSound = playbackKanjiQuizSoundOf(sound, overlayKey)
      // チャンネルポイントの交換での出題は試し再生ではないので、時間切れなら配信を止める
      await issueKanjiQuiz(
        { db: env.DB, alerts: env.ALERTS, now, random: Math.random, id: crypto.randomUUID() },
        { ...kanjiQuiz, rehearsal: false, sound: playbackSound, missLimit },
      )
    })
  }

  // ペロペロ（issue #338）も素材が流すので、botの接続を見る前に押し出す。相手のアイコンは1件ごとにログイン名から引く。
  // Twitch にその人がいなければ（消えたアカウントなど）アイコン無しで流し、Twitch を呼べなければ押し出しの失敗として記録する
  const licks = ((): ReturnType<typeof licksFor> => {
    try {
      return licksFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  // 効果音の設定とオーバーレイ用キーは、当てはまった行があるときだけ読む（チャットの発言のたびにKVを読まないため）
  if (licks.length > 0) {
    const [sound, overlayKey] = await Promise.all([loadLickSound(env.STORE), loadOverlayKey(env.STORE)])
    for (const [index, lick] of licks.entries()) {
      await sendAndRecordFailure(context, messageId, 'lick', index, 'lick-push-failed', async () => {
        // キーが未発行で効果音のURLを作れないときも、押し出しの失敗として記録する（黙って無音で流さない）
        const playbackSound = playbackLickSoundOf(sound, overlayKey)
        const { twitch } = context
        const user = await twitch.getUserByLogin(await twitch.getAppAccessToken(), lick.userLogin)
        const seed = lickSeedOf(crypto.getRandomValues(new Uint32Array(1)))
        await pushLick(env.ALERTS, lickCallOf({ name: lick.userName, iconUrl: user?.profileImageUrl ?? null }, playbackSound, seed, crypto.randomUUID()))
      })
    }
  }

  // VRMのマスコットの反応（issue #358・#359）も素材が流すので、botの接続を見る前に押し出す。出す VRM は全体で1つで、
  // 反応の種類は当てはまった行の項目から決め、種は1件ごとに引く
  const vrmKinds = ((): TriggerKind[] => {
    try {
      return vrmsFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  // VRM の設定とオーバーレイ用キーは、当てはまった行があるときだけ読む（チャットの発言のたびにKVを読まないため）
  if (vrmKinds.length > 0) {
    const [model, overlayKey] = await Promise.all([loadVrmModel(env.STORE), loadOverlayKey(env.STORE)])
    for (const [index, kind] of vrmKinds.entries()) {
      await sendAndRecordFailure(context, messageId, 'vrm', index, 'vrm-push-failed', async () => {
        // VRM を選んでいない・キーが未発行で URL を作れないときも、押し出しの失敗として記録する（黙って何も出さずに済ませない）
        const modelUrl = playbackVrmModelOf(model, overlayKey)
        const seed = vrmSeedOf(crypto.getRandomValues(new Uint32Array(1)))
        await pushVrm(env.ALERTS, vrmCallOf(modelUrl, seed, vrmReactionOf(kind), crypto.randomUUID()))
      })
    }
  }

  // チャットで推理も合成ページの素材が映すので、botの接続を見る前に始める。開催中のゲームがあれば始めずに失敗として記録する
  // （開催中は1つだけ。同じ通知で2行が当てはまっても、2つ目は開催中として記録に残る）
  const chatDeductions = ((): ReturnType<typeof chatDeductionsFor> => {
    try {
      return chatDeductionsFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  for (const [index, { choice, startRewardId }] of chatDeductions.entries()) {
    await sendAndRecordFailure(context, messageId, 'chatDeduction', index, 'chat-deduction-start-failed', async () => {
      await startChatDeductionGame(
        context,
        (previousProblemId) => pickConfiguredChatDeductionProblem(CHAT_DEDUCTION_PROBLEM_SETS, choice, previousProblemId, Math.random),
        startRewardId,
      )
    })
  }

  await grantMatchedDolls(context, config, subscriptionType, body, messageId, state)

  if (messages.length === 0 && announcements.length === 0 && aiChats.length === 0 && shoutouts.length === 0) return

  // botを切断していれば送る先がない。受け取り自体は成功として返す
  if (!(await botConnected())) return

  // 当てはまった行はすべて実行する。鍵には並びの位置を混ぜ、同じ通知で2通送るときに片方が送れなくならないようにする
  for (const [index, message] of messages.entries()) {
    await sendAndRecordFailure(context, messageId, 'chat', index, 'alert-chat-failed', () => sendAsBot(context, message))
  }
  for (const [index, announcement] of announcements.entries()) {
    await sendAndRecordFailure(context, messageId, 'announce', index, 'alert-announce-failed', () => announceAsBot(context, announcement))
  }
  for (const [index, shoutout] of shoutouts.entries()) {
    await sendAndRecordFailure(context, messageId, 'shoutout', index, 'alert-shoutout-failed', () => shoutoutAsBot(context, shoutout.userId))
  }
  for (const [index, aiChat] of aiChats.entries()) {
    // LLMの応答を待つとTwitchへの2xxが遅れ、同じ通知を再送されてしまう。応答を返してから続きを走らせる
    context.waitUntil(
      recordLateFailure(context, 'alert-aichat-failed', () =>
        sendAndRecordFailure(context, messageId, 'aiChat', index, 'alert-aichat-failed', () =>
          sendAiChat(context, aiChat, subscriptionType, index, state, chatMessage, summary),
        ),
      ),
    )
  }
}

/**
 * 当てはまった「人形を渡す」動作（issue #419）ごとに、出来事を起こした視聴者へいまの人形を渡す。
 *
 * 人形は bot と関わりなく台帳に書くので、bot の接続を見る前に呼ぶ（bot が無くても渡せる）。
 * 再送での二重の付与は、台帳のきっかけの ID（source_id の UNIQUE）で防ぐ。ID は通知のメッセージIDと、当てはまった動作の
 * 並びの位置から作る（同じ通知で2行が当てはまったとき、どちらも渡すため。位置の考え方は sendAndRecordFailure と同じ）。
 * そのため reserveChatReply の鍵は取らない（鍵を取ってから書く形にすると、台帳への書き込みに失敗した再送で渡せなくなる）。
 *
 * 注意: いまの人形が選ばれていないなど、渡せなかったときは黙って飛ばさず `doll-grant-failed` として記録する
 * （Twitch には2xxを返す。再送されても同じ理由で渡せないため）。
 */
const grantMatchedDolls = async (
  context: AlertActionContext,
  config: AlertConfig,
  subscriptionType: string,
  body: Record<string, unknown>,
  messageId: string,
  state: ConditionState,
): Promise<void> => {
  const { env, now } = context
  const grants = ((): ReturnType<typeof dollGrantsFor> => {
    try {
      return dollGrantsFor(config, subscriptionType, body.event, state)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  for (const [index, grant] of grants.entries()) {
    try {
      await grantDolls(env, now, {
        userId: grant.userId,
        userName: grant.userName,
        kind: grant.kind,
        delta: grant.count,
        reason: 'trigger',
        triggerKind: grant.triggerKind,
        sourceId: `trigger:${messageId}:dollGrant:${index}`,
      })
    } catch (error) {
      await recordFailure(env.DB, 'doll-grant-failed', error instanceof Error ? error.message : String(error), now)
    }
  }
}

/** 1日の上限に達したことを失敗として記録した時刻を持つ鍵（command_uses の行。コマンド名と重ならない形にしてある） */
const AI_CHAT_LIMIT_NOTICE_KEY = 'aiChat:limit-notice'
/** 上限に達したことの記録を繰り返さない秒数 */
const AI_CHAT_LIMIT_NOTICE_SECONDS = 60 * 60

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
  subscriptionType: string,
  index: number,
  state: ConditionState,
  chatMessage: ChatMessage | null,
  streamSummary: string | null,
): Promise<void> => {
  const { env, llm, now } = context

  // 費用の歯止め。LLMを呼ぶ前に、同じ人への続けての返信と、その日の呼び出しの総量を止める
  const cooldownKey = `aiChat:${subscriptionType}:${index}:${chatMessage?.chatterUserId ?? 'event'}`
  // クールダウン中は想定どおりの抑止なので、失敗としては記録せず黙って見送る
  if (!(await consumeCooldown(env.DB, cooldownKey, AI_CHAT_COOLDOWN_SECONDS, now))) return
  const todayCalls = await countLlmCalls(env.DB, 'aiChat', toUtcDay(now))
  if (todayCalls >= AI_CHAT_DAILY_LIMIT) {
    // 上限を超えた日は発言のたびにここへ来るので、失敗の記録は一定時間に1回だけにする（最新50件のほかの失敗を押し流さないため）
    if (await consumeCooldown(env.DB, AI_CHAT_LIMIT_NOTICE_KEY, AI_CHAT_LIMIT_NOTICE_SECONDS, now)) {
      throw new Error(`aiChat の1日の上限（${AI_CHAT_DAILY_LIMIT}回）に達したため、LLMを呼ばずに見送りました。上限を超えた間は、この記録は1時間に1回だけ残します`)
    }
    return
  }

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
  actionType: 'chat' | 'announce' | 'alert' | 'aiChat' | 'shoutout' | 'townTour' | 'twister' | 'kanjiQuiz' | 'lick' | 'vrm' | 'chatDeduction',
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

