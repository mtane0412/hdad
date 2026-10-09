/**
 * テキスト（配信者が自由に書いた文字を映す素材）の形と検証
 *
 * 配信で「今何をしているか」「何を目指しているか」を見せるため、配信者が書いた文字をそのまま合成ページの素材「テキスト」に映す
 * （issue #294）。テキストは複数持て、1件は名前と本文を持つ（例: 「目標」「今やってること」）。素材はどのテキストを映すかを
 * パラメータ（テキストのID）で持ち、管理画面では名前の選択欄から選ばせる（docs/principles.md の2）。
 *
 * テキストごとに「手動／自動」を持つ（issue #295）。自動のテキストは配信者が書いた指示文に沿って cron（worker/collect.ts）が
 * LLM（worker/text-auto.ts）に本文を書き直させる。自動の最中に配信者が本文を手で書き換えたら、画面が手動にして送ってくる
 * （人が書いた文を機械が黙って上書きしないため。方針11）。本文を誰が書いたか（writtenBy）も持ち、管理画面で見分けられるようにする。
 *
 * 通信も時刻も持たない純粋な関数だけを置き、読み書きは worker/text-store.ts、経路と押し出しは worker/text-routes.ts が持つ。
 *
 * 注意: 本文が上限の文字数・行数を超えたら、切り詰めずに受け付けない（方針4）。黙って切り詰めると、書いたものと違う文が配信画面に出る。
 * 注意: 名前はほかのテキストと重ねさせない。素材の選択欄に同じ名前が2つ並ぶと、どちらを選んだのか見分けられないため。
 */
import { ConfigError } from './alert-config'

/** 持てるテキストの数の上限。素材の選択欄と下部バーの選択欄に並べられる数にする */
export const MAX_TEXT_COUNT = 20

/** 名前の上限（見た目の文字数）。選択欄と合成ページの見出しに収まる長さにする */
export const MAX_TEXT_NAME_LENGTH = 20

/** 本文の上限（見た目の文字数。改行も1文字に数える）。配信画面の隅の札で読み切れる長さにする */
export const MAX_TEXT_BODY_LENGTH = 100

/** 本文の行数の上限。札が配信画面を覆わない高さにする */
export const MAX_TEXT_BODY_LINES = 4

/** 指示文の上限（見た目の文字数）。何を書かせたいかを一言で伝えられる長さにする */
export const MAX_TEXT_INSTRUCTION_LENGTH = 100

/** 本文の書き方。manual は配信者が手で書き、auto は指示文に沿って LLM が書き直す */
export const TEXT_MODES = ['manual', 'auto'] as const
export type TextMode = (typeof TEXT_MODES)[number]

/** いまの本文を誰が書いたか。human は配信者、llm は自動の書き換え */
export type TextWriter = 'human' | 'llm'

/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = 'テキスト'

/** テキスト1件。項目は src/text/entry.ts と合わせる */
export interface TextEntry {
  /** テキストを見分けるID。素材のパラメータに入る（消したIDは使い回さない） */
  readonly id: number
  readonly name: string
  readonly body: string
  readonly mode: TextMode
  /** LLM に本文を書かせるときの指示文。手動のあいだも持ち続ける（自動へ戻したときにまた使うため） */
  readonly instruction: string
  /** いまの本文を誰が書いたか */
  readonly writtenBy: TextWriter
  /** 最後に書き換えた時刻（ISO 8601） */
  readonly updatedAt: string
}

/** 合成ページへ押し出す、いまのテキストの一覧。少ないので丸ごと送り、素材は自分が映すテキストをIDで引く */
export interface TextsSnapshot {
  readonly texts: readonly TextEntry[]
}

/**
 * 管理画面と下部バーから受け取る、テキスト1件の中身。
 *
 * 自動のテキストは本文を持たない（本文は LLM が書くので、画面が読み込んだときの古い本文で上書きしないため）。
 */
export type TextInput =
  | { readonly name: string; readonly mode: 'manual'; readonly body: string; readonly instruction: string }
  | { readonly name: string; readonly mode: 'auto'; readonly instruction: string }

/** 見た目の1文字（書記素クラスタ）ごとに分ける。家族や国旗のような組み合わせの絵文字も1文字になる（作業机と同じ数え方） */
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' })

const lengthOf = (text: string): number => [...graphemes.segment(text)].length

/** 改行の区切り。\r\n を2行に数えないよう、先に見る */
const LINE_BREAK = /\r\n|\r|\n/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isTextMode = (value: unknown): value is TextMode => TEXT_MODES.some((mode) => mode === value)

/**
 * 本文が上限の文字数・行数に収まっているかを確かめ、問題点を返す（収まっていれば空）。
 *
 * 配信者が書いた本文（parseTextInput）と、LLM が書いた本文（worker/text-auto.ts）の両方を同じ上限で確かめる。
 */
export const textBodyProblems = (body: string): string[] => {
  const problems: string[] = []
  const length = lengthOf(body)
  if (length > MAX_TEXT_BODY_LENGTH) problems.push(`本文は${MAX_TEXT_BODY_LENGTH}文字以内にしてください（いまは${length}文字です）`)
  const lines = body.split(LINE_BREAK).length
  if (lines > MAX_TEXT_BODY_LINES) problems.push(`本文は${MAX_TEXT_BODY_LINES}行以内にしてください（いまは${lines}行です）`)
  return problems
}

/**
 * 名前がほかのテキストと重なったことを伝える問題点を返す。
 *
 * 検証（parseTextInput）と、検証のあとで別の窓が先に同じ名前を書いたときの表の制約（worker/text-store.ts）の両方から使う。
 */
export const duplicateNameError = (name: string): ConfigError => new ConfigError(SUBJECT, [`name: 「${name}」という名前のテキストはもうあります`])

/**
 * 管理画面と下部バーから送られてきたテキスト1件を検証する。名前は前後の空白を落として受け取る。
 *
 * @param input `{ name: string, mode: 'manual' | 'auto', body: string, instruction: string }`（自動なら body は読まない）
 * @param otherNames ほかのテキストの名前（書き換えるときは、そのテキスト自身の名前を含めない）
 * @throws ConfigError 問題がある場合。問題点は最初の1件で止めずにすべて集める
 */
export const parseTextInput = (input: unknown, otherNames: readonly string[]): TextInput => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['テキストは { name, mode, body, instruction } の形で指定してください'])

  const problems: string[] = []
  const name = typeof input.name === 'string' ? input.name.trim() : undefined
  if (name === undefined) {
    problems.push('name: 名前を文字列で指定してください')
  } else if (name === '') {
    problems.push('name: 名前を入れてください')
  } else if (lengthOf(name) > MAX_TEXT_NAME_LENGTH) {
    problems.push(`name: 名前は${MAX_TEXT_NAME_LENGTH}文字以内にしてください（いまは${lengthOf(name)}文字です）`)
  } else if (otherNames.includes(name)) {
    problems.push(...duplicateNameError(name).problems)
  }

  const mode = isTextMode(input.mode) ? input.mode : undefined
  if (mode === undefined) problems.push('mode: 手動（manual）か自動（auto）を指定してください')

  // 自動のテキストの本文は LLM が書くので読まない
  const body = mode === 'auto' ? '' : typeof input.body === 'string' ? input.body : undefined
  if (body === undefined) {
    problems.push('body: 本文を文字列で指定してください')
  } else {
    problems.push(...textBodyProblems(body).map((problem) => `body: ${problem}`))
  }

  const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : undefined
  if (instruction === undefined) {
    problems.push('instruction: 指示文を文字列で指定してください')
  } else if (mode === 'auto' && instruction === '') {
    problems.push('instruction: 自動で書き換えるテキストには指示文を入れてください')
  } else if (lengthOf(instruction) > MAX_TEXT_INSTRUCTION_LENGTH) {
    problems.push(`instruction: 指示文は${MAX_TEXT_INSTRUCTION_LENGTH}文字以内にしてください（いまは${lengthOf(instruction)}文字です）`)
  }

  if (problems.length > 0 || name === undefined || mode === undefined || body === undefined || instruction === undefined) {
    throw new ConfigError(SUBJECT, problems)
  }
  return mode === 'auto' ? { name, mode, instruction } : { name, mode, body, instruction }
}
