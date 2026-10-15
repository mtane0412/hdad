/**
 * チャットで推理の「質問」「解答」の報酬（issue #375）
 *
 * 視聴者はチャンネルポイントの交換（ユーザー入力つき）で質問と解答を送る。2つの報酬はゲームの開催中だけ交換できるようにする。
 * Twitch が交換できるかどうかの切り替えを許すのは同じ Client ID（HDAD）で作った報酬だけなので、既存の報酬を選ばせず、
 * ここで作って ID を KV（`chat-deduction-rewards`）に控える。必要ポイントや説明は、作ったあと /rewards/ で変えられる。
 *
 * 注意: 待ち行列に入れる形（should_redemptions_skip_request_queue: false）で作る。受け付けなかった質問のポイントを返す
 * （交換を CANCELED にする。issue #376）には、交換が未完了（UNFULFILLED）のまま残っている必要があるため。
 */
import type { KeyValueStore } from './store'
import type { CustomRewardInput, TwitchClient } from './twitch'

const REWARDS_KEY = 'chat-deduction-rewards'

/** 控えた2つの報酬のID */
export interface ChatDeductionRewards {
  questionRewardId: string
  answerRewardId: string
}

/** 2つの報酬に共通する作り方（交換できない状態で作り、ゲームを始めたときにだけ交換できるようにする） */
const COMMON_REWARD_INPUT = {
  isEnabled: false,
  isUserInputRequired: true,
  backgroundColor: '#1F6FEB',
  shouldRedemptionsSkipRequestQueue: false,
  maxPerStream: null,
  maxPerUserPerStream: null,
  globalCooldownSeconds: null,
} as const satisfies Partial<CustomRewardInput>

/** 「質問」の報酬の作り方 */
export const QUESTION_REWARD_INPUT: CustomRewardInput = {
  ...COMMON_REWARD_INPUT,
  title: 'チャットで推理: 質問',
  cost: 100,
  prompt: '答えについて「はい」か「いいえ」で答えられる質問を書いてください（例: 生き物ですか？）',
}

/** 「解答」の報酬の作り方 */
export const ANSWER_REWARD_INPUT: CustomRewardInput = {
  ...COMMON_REWARD_INPUT,
  title: 'チャットで推理: 解答',
  cost: 300,
  prompt: '答えだと思うものを書いてください（例: 富士山）',
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 控えた報酬のIDを読む。
 *
 * @returns まだ作っていなければ null
 * @throws 控えた中身の形が違う場合（作っていないことにすると、作り直しが同じ名前の報酬としてTwitchに断られるため）
 */
export const loadChatDeductionRewards = async (store: KeyValueStore): Promise<ChatDeductionRewards | null> => {
  const text = await store.get(REWARDS_KEY)
  if (text === null) return null
  const saved: unknown = JSON.parse(text)
  if (!isRecord(saved) || typeof saved.questionRewardId !== 'string' || typeof saved.answerRewardId !== 'string') {
    throw new Error(`チャットで推理の報酬のIDの形が違います（KV の ${REWARDS_KEY}）`)
  }
  return { questionRewardId: saved.questionRewardId, answerRewardId: saved.answerRewardId }
}

/** 報酬が、チャットで推理の報酬のどちらかか（/rewards/ から削除させないため） */
export const isChatDeductionReward = (rewards: ChatDeductionRewards | null, rewardId: string): boolean =>
  rewards !== null && (rewards.questionRewardId === rewardId || rewards.answerRewardId === rewardId)

/**
 * Twitchで2つの報酬を作り、IDを控える。
 *
 * 「解答」を作れなければ、作った「質問」を消してから投げる（片方だけが残ると、作り直しが同じ名前として断られるため）。
 *
 * @throws TwitchApiError Twitchが拒否した（同じ名前の報酬がある・50件の上限に達したなど）
 */
export const createChatDeductionRewards = async (store: KeyValueStore, twitch: TwitchClient, accessToken: string, broadcasterId: string): Promise<ChatDeductionRewards> => {
  const question = await twitch.createCustomReward(accessToken, broadcasterId, QUESTION_REWARD_INPUT)
  const answer = await twitch.createCustomReward(accessToken, broadcasterId, ANSWER_REWARD_INPUT).catch(async (error: unknown) => {
    await twitch.deleteCustomReward(accessToken, broadcasterId, question.id)
    throw error
  })
  const rewards: ChatDeductionRewards = { questionRewardId: question.id, answerRewardId: answer.id }
  await store.put(REWARDS_KEY, JSON.stringify(rewards))
  return rewards
}

/**
 * 2つの報酬を、交換できる（isEnabled: true）・できない状態にする。
 *
 * @throws TwitchApiError Twitchが拒否した（報酬が消された・このアプリが作っていないなど）
 */
export const setChatDeductionRewardsEnabled = async (
  twitch: TwitchClient,
  accessToken: string,
  broadcasterId: string,
  rewards: ChatDeductionRewards,
  isEnabled: boolean,
): Promise<void> => {
  // 順に送る（片方の失敗をもう一方の成功で隠さず、どこで止まったかを応答のメッセージで分かるようにする）
  await twitch.setCustomRewardEnabled(accessToken, broadcasterId, rewards.questionRewardId, isEnabled)
  await twitch.setCustomRewardEnabled(accessToken, broadcasterId, rewards.answerRewardId, isEnabled)
}
