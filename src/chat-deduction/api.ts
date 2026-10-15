/**
 * チャットで推理の Worker の呼び出し（issue #375）
 *
 * アプリのページ（/chat-deduction/）が、ログインのセッションで報酬のIDと最後のゲームを読み、報酬を作り、ゲームを始め・終える。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 想定した形でなければエラーにする（Fail-Fast）。
 */
import { createCaller, isRecord } from '../core/api'

const ADMIN_PATH = '/api/admin/chat-deduction'

/** 控えた「質問」「解答」の報酬のID（worker/chat-deduction-rewards.ts の ChatDeductionRewards と合わせる） */
export interface ChatDeductionRewards {
  readonly questionRewardId: string
  readonly answerRewardId: string
}

/** ゲームの終わり方（stopped: 配信者が打ち切った。solved: 正解者が出た） */
export type ChatDeductionEndReason = 'stopped' | 'solved'

/** ゲーム1つ（worker/chat-deduction-store.ts の ChatDeductionGame と合わせる） */
export interface ChatDeductionGame {
  readonly id: number
  readonly problemId: string
  readonly startedAt: string
  /** 開催中なら null */
  readonly endedAt: string | null
  /** 開催中なら null */
  readonly endReason: ChatDeductionEndReason | null
}

/** ページに出す状態 */
export interface ChatDeductionState {
  /** まだ作っていなければ null */
  readonly rewards: ChatDeductionRewards | null
  /** 最後に始めたゲーム（終えたものも含む）。一度も始めていなければ null */
  readonly game: ChatDeductionGame | null
}

export interface ChatDeductionApi {
  read(): Promise<ChatDeductionState>
  /** 「質問」「解答」の報酬をTwitchで作る */
  createRewards(): Promise<ChatDeductionRewards>
  /** 問題を選んでゲームを始める（2つの報酬を交換できるようにする） */
  startGame(problemId: string): Promise<ChatDeductionGame>
  /** ゲームを終える（2つの報酬を交換できないようにする） */
  endGame(id: number): Promise<ChatDeductionGame>
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'

const isRewards = (value: unknown): value is ChatDeductionRewards =>
  isRecord(value) && typeof value.questionRewardId === 'string' && typeof value.answerRewardId === 'string'

const isGame = (value: unknown): value is ChatDeductionGame =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.problemId === 'string' &&
  typeof value.startedAt === 'string' &&
  isNullableString(value.endedAt) &&
  (value.endReason === null || value.endReason === 'stopped' || value.endReason === 'solved')

/** 応答の本文から name の項目を取り出し、形を確かめる */
const readField = <T>(body: unknown, name: string, isValue: (value: unknown) => value is T): T => {
  const value: unknown = isRecord(body) ? body[name] : undefined
  if (!isValue(value)) throw new Error(`Workerの応答の ${name} が想定した形ではありません`)
  return value
}

const nullable =
  <T>(isValue: (value: unknown) => value is T) =>
  (value: unknown): value is T | null =>
    value === null || isValue(value)

export const createChatDeductionApi = (fetchImpl: typeof fetch): ChatDeductionApi => {
  const call = createCaller(fetchImpl)
  const send = (path: string, body?: unknown): Promise<unknown> =>
    call(path, body === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  return {
    read: async () => {
      const body = await call(ADMIN_PATH)
      return { rewards: readField(body, 'rewards', nullable(isRewards)), game: readField(body, 'game', nullable(isGame)) }
    },
    createRewards: async () => readField(await send(`${ADMIN_PATH}/rewards`), 'rewards', isRewards),
    startGame: async (problemId) => readField(await send(`${ADMIN_PATH}/games`, { problemId }), 'game', isGame),
    endGame: async (id) => readField(await send(`${ADMIN_PATH}/games/${id}/end`), 'game', isGame),
  }
}
