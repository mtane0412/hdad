/**
 * テキスト（配信者が自由に書いた文字を映す素材）の形と検証
 *
 * 配信で「今何をしているか」「何を目指しているか」を見せるため、配信者が書いた文字をそのまま合成ページの素材「テキスト」に映す
 * （issue #294）。テキストは複数持て、1件は名前と本文を持つ（例: 「目標」「今やってること」）。素材はどのテキストを映すかを
 * パラメータ（テキストのID）で持ち、管理画面では名前の選択欄から選ばせる（docs/principles.md の2）。
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

/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = 'テキスト'

/** テキスト1件。項目は src/text/entry.ts と合わせる */
export interface TextEntry {
  /** テキストを見分けるID。素材のパラメータに入る（消したIDは使い回さない） */
  readonly id: number
  readonly name: string
  readonly body: string
  /** 最後に書き換えた時刻（ISO 8601） */
  readonly updatedAt: string
}

/** 合成ページへ押し出す、いまのテキストの一覧。少ないので丸ごと送り、素材は自分が映すテキストをIDで引く */
export interface TextsSnapshot {
  readonly texts: readonly TextEntry[]
}

/** 管理画面と下部バーから受け取る、テキスト1件の中身 */
export interface TextInput {
  readonly name: string
  readonly body: string
}

/** 見た目の1文字（書記素クラスタ）ごとに分ける。家族や国旗のような組み合わせの絵文字も1文字になる（作業机と同じ数え方） */
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' })

const lengthOf = (text: string): number => [...graphemes.segment(text)].length

/** 改行の区切り。\r\n を2行に数えないよう、先に見る */
const LINE_BREAK = /\r\n|\r|\n/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面と下部バーから送られてきたテキスト1件を検証する。名前は前後の空白を落として受け取る。
 *
 * @param input `{ name: string, body: string }`
 * @param otherNames ほかのテキストの名前（書き換えるときは、そのテキスト自身の名前を含めない）
 * @throws ConfigError 問題がある場合。問題点は最初の1件で止めずにすべて集める
 */
export const parseTextInput = (input: unknown, otherNames: readonly string[]): TextInput => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['テキストは { name, body } の形で指定してください'])

  const problems: string[] = []
  const name = typeof input.name === 'string' ? input.name.trim() : undefined
  if (name === undefined) {
    problems.push('name: 名前を文字列で指定してください')
  } else if (name === '') {
    problems.push('name: 名前を入れてください')
  } else if (lengthOf(name) > MAX_TEXT_NAME_LENGTH) {
    problems.push(`name: 名前は${MAX_TEXT_NAME_LENGTH}文字以内にしてください（いまは${lengthOf(name)}文字です）`)
  } else if (otherNames.includes(name)) {
    problems.push(`name: 「${name}」という名前のテキストはもうあります`)
  }

  const body = typeof input.body === 'string' ? input.body : undefined
  if (body === undefined) {
    problems.push('body: 本文を文字列で指定してください')
  } else {
    const length = lengthOf(body)
    if (length > MAX_TEXT_BODY_LENGTH) problems.push(`body: 本文は${MAX_TEXT_BODY_LENGTH}文字以内にしてください（いまは${length}文字です）`)
    const lines = body.split(LINE_BREAK).length
    if (lines > MAX_TEXT_BODY_LINES) problems.push(`body: 本文は${MAX_TEXT_BODY_LINES}行以内にしてください（いまは${lines}行です）`)
  }

  if (problems.length > 0 || name === undefined || body === undefined) throw new ConfigError(SUBJECT, problems)
  return { name, body }
}
