/**
 * 合成ページの素材「チャットで推理」が受け取るカードの一覧（issue #378）
 *
 * Worker（worker/chat-deduction-board.ts の ChatDeductionBoard）が、最後に始めたゲームの区分と、答えた質問・正誤を決めた解答の
 * カードを丸ごと返し・押し出す。ここはその形を確かめて読むだけで、通信も DOM も持たない（表示は view.ts、読み出しは api.ts）。
 *
 * 注意: 想定した形でなければエラーにする（Fail-Fast）。正解の表記はゲームを終えたあとにだけ届く（開催中は null）。
 */
import { isRecord, readList } from '../core/api'
import { isChatDeductionCategory, type ChatDeductionCategory } from './category'
import type { ChatDeductionEndReason } from './api'

/** 質問への答え（yes: はい。no: いいえ。unknown: 分からない） */
export const CHAT_DEDUCTION_VERDICTS = ['yes', 'no', 'unknown'] as const

export type ChatDeductionVerdict = (typeof CHAT_DEDUCTION_VERDICTS)[number]

/** 答えた質問のカード */
export interface ChatDeductionQuestionCard {
  readonly kind: 'question'
  readonly id: number
  readonly userName: string
  readonly text: string
  readonly verdict: ChatDeductionVerdict
  readonly reply: string
}

/** 正誤を決めた解答のカード */
export interface ChatDeductionGuessCard {
  readonly kind: 'guess'
  readonly id: number
  readonly userName: string
  readonly text: string
  readonly correct: boolean
}

export type ChatDeductionCard = ChatDeductionQuestionCard | ChatDeductionGuessCard

/** 合成ページに映すゲーム */
export interface ChatDeductionBoardGame {
  readonly id: number
  readonly category: ChatDeductionCategory
  readonly startedAt: string
  /** 開催中なら null */
  readonly endedAt: string | null
  /** 開催中なら null */
  readonly endReason: ChatDeductionEndReason | null
  /** 正解の表記。開催中なら null */
  readonly answer: string | null
}

/** 合成ページに映すもの丸ごと */
export interface ChatDeductionBoard {
  /** 一度もゲームを始めていなければ null */
  readonly game: ChatDeductionBoardGame | null
  readonly cards: readonly ChatDeductionCard[]
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'

const isVerdict = (value: unknown): value is ChatDeductionVerdict => CHAT_DEDUCTION_VERDICTS.some((verdict) => verdict === value)

const isGame = (value: unknown): value is ChatDeductionBoardGame =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  isChatDeductionCategory(value.category) &&
  typeof value.startedAt === 'string' &&
  isNullableString(value.endedAt) &&
  (value.endReason === null || value.endReason === 'stopped' || value.endReason === 'solved') &&
  isNullableString(value.answer)

const isCard = (value: unknown): value is ChatDeductionCard => {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.userName !== 'string' || typeof value.text !== 'string') return false
  if (value.kind === 'question') return isVerdict(value.verdict) && typeof value.reply === 'string'
  return value.kind === 'guess' && typeof value.correct === 'boolean'
}

/**
 * Worker の応答の本文を、カードの一覧として読む。
 *
 * @throws 想定した形でない場合
 */
export const readChatDeductionBoard = (body: unknown): ChatDeductionBoard => {
  const game: unknown = isRecord(body) ? body.game : undefined
  if (!(game === null || isGame(game))) throw new Error('Workerの応答の game が想定した形ではありません')
  return { game, cards: readList(body, 'cards', isCard) }
}

/**
 * WebSocket で押し出された文字列を、カードの一覧として読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseChatDeductionBoardMessage = (payload: string): ChatDeductionBoard => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出されたチャットで推理のカードの一覧をJSONとして読めません')
  }
  return readChatDeductionBoard(body)
}
