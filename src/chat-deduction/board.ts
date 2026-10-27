/**
 * 合成ページの素材「チャットで推理」が受け取るカードの一覧（issue #378）
 *
 * Worker（worker/chat-deduction-board.ts の ChatDeductionBoard）が、最後に始めたゲームの区分と、答えた質問・正誤を決めた解答の
 * カードを丸ごと返し・押し出す。ここはその形を確かめて読むだけで、通信も DOM も持たない（表示は view.ts、読み出しは api.ts）。
 *
 * 注意: 想定した形でなければエラーにする（Fail-Fast）。正解の表記と解説・画像はゲームを終えたあとにだけ届く（開催中は null）。
 * 場面ごとに鳴らす音の設定（sound）も一緒に届く。
 */
import { isRecord, readList } from '../core/api'
import { isChatDeductionCategory, type ChatDeductionCategory } from './category'
import type { ChatDeductionImage } from './images'
import { isChatDeductionEndReason, type ChatDeductionEndReason } from './api'
import { readChatDeductionPlaybackSound, type ChatDeductionSound } from './sound'

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
  /** 問題集の時代などの括り（例: 古代史）。括りの無い問題集なら null */
  readonly topic: string | null
  readonly startedAt: string
  /** 制限時間の締め切りの時刻。制限時間をなしにして始めたゲームなら null（見出しの帯に残り時間を出す） */
  readonly closesAt: string | null
  /** 開催中なら null */
  readonly endedAt: string | null
  /** 開催中なら null */
  readonly endReason: ChatDeductionEndReason | null
  /** 正解の表記。開催中なら null */
  readonly answer: string | null
  /** 正解の解説。開催中なら null */
  readonly explanation: string | null
  /** 解説に添える画像。開催中・出せる画像の無い問題なら null */
  readonly image: ChatDeductionImage | null
}

/** 合成ページに映すもの丸ごと */
export interface ChatDeductionBoard {
  /** 一度もゲームを始めていなければ null */
  readonly game: ChatDeductionBoardGame | null
  readonly cards: readonly ChatDeductionCard[]
  /** 場面ごとに鳴らす音（Worker が素材のIDを音声のURLにしたもの） */
  readonly sound: ChatDeductionSound
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'

const isVerdict = (value: unknown): value is ChatDeductionVerdict => CHAT_DEDUCTION_VERDICTS.some((verdict) => verdict === value)

const isImage = (value: unknown): value is ChatDeductionImage =>
  isRecord(value) && typeof value.url === 'string' && typeof value.artist === 'string' && typeof value.license === 'string'

const isGame = (value: unknown): value is ChatDeductionBoardGame =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  isChatDeductionCategory(value.category) &&
  isNullableString(value.topic) &&
  typeof value.startedAt === 'string' &&
  isNullableString(value.closesAt) &&
  isNullableString(value.endedAt) &&
  (value.endReason === null || isChatDeductionEndReason(value.endReason)) &&
  isNullableString(value.answer) &&
  isNullableString(value.explanation) &&
  (value.image === null || isImage(value.image))

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
  const sound: unknown = isRecord(body) ? body.sound : undefined
  return { game, cards: readList(body, 'cards', isCard), sound: readChatDeductionPlaybackSound(sound) }
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
