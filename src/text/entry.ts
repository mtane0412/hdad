/**
 * テキストの形と、映すテキストの選び方
 *
 * 合成ページの素材「テキスト」は、配信者が書いた文字（issue #294）のうち、パラメータで選んだ1件を映す。
 * テキストの一覧は2つの道から届く。開いたとき・つなぎ直したとき・定期的に読む一覧（api.ts）と、変わるたびに丸ごと届く押し出し
 * （WebSocket）である。どちらも一覧の丸ごとなので、届いたもので置き換え、映すテキストをIDで引き直せばよい。
 * 通信もDOMも持たないので、ここだけをテストできる。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、形はここで定義する（worker/text.ts の TextEntry と合わせる）。
 * 想定した形でなければ投げる（Fail-Fast）。
 * 注意: 選んだテキストが消されていたら、黙って空にせず投げる（方針4）。空の札だと、消したことに配信中は気付けないため。
 */
import { isRecord, readList } from '../core/api'

/** 本文の書き方。manual は配信者が手で書き、auto は指示文に沿って LLM が書き直す（issue #295） */
export const TEXT_MODES = ['manual', 'auto'] as const
export type TextMode = (typeof TEXT_MODES)[number]

/** いまの本文を誰が書いたか。human は配信者、llm は自動の書き換え */
export const TEXT_WRITERS = ['human', 'llm'] as const
export type TextWriter = (typeof TEXT_WRITERS)[number]

/** テキスト1件 */
export interface TextEntry {
  /** テキストを見分けるID。素材のパラメータに入る */
  readonly id: number
  readonly name: string
  readonly body: string
  readonly mode: TextMode
  /** LLM に本文を書かせるときの指示文。手動のあいだも持ち続ける */
  readonly instruction: string
  /** いまの本文を誰が書いたか */
  readonly writtenBy: TextWriter
  /** 最後に書き換えた時刻（ISO 8601） */
  readonly updatedAt: string
}

const isOneOf = <T extends string>(choices: readonly T[], value: unknown): value is T => choices.some((choice) => choice === value)

/** テキスト1件として読めるか */
export const isTextEntry = (value: unknown): value is TextEntry =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.name === 'string' &&
  typeof value.body === 'string' &&
  isOneOf(TEXT_MODES, value.mode) &&
  typeof value.instruction === 'string' &&
  isOneOf(TEXT_WRITERS, value.writtenBy) &&
  typeof value.updatedAt === 'string'

/**
 * Worker の応答（読み出しと押し出しで同じ形）の texts を、テキストの一覧として読む。
 *
 * @throws 想定した形でない場合
 */
export const readTextList = (body: unknown): TextEntry[] => readList(body, 'texts', isTextEntry)

/**
 * 押し出された文字列（WebSocket のメッセージ）を、テキストの一覧として読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseTextsMessage = (message: string): TextEntry[] => readTextList(JSON.parse(message))

/**
 * 素材のパラメータ（テキストのID）から、映すテキストを引く。
 *
 * @param textId 素材のパラメータ text の値（選んでいなければ空文字）
 * @throws 選んでいない・選んだテキストが一覧に無い（消された）場合。直し方を文面に添える
 */
export const textToShow = (texts: readonly TextEntry[], textId: string): TextEntry => {
  if (textId === '') throw new Error('映すテキストが選ばれていません。オーバーレイのページで、この素材のテキストを選んでください')
  const found = texts.find((text) => String(text.id) === textId)
  if (found === undefined) {
    throw new Error(`映すテキスト（ID ${textId}）が見つかりません。テキストのページで消された可能性があります。オーバーレイのページで選び直してください`)
  }
  return found
}
