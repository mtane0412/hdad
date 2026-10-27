/**
 * 漢字クイズで配信を止めるまでの時間切れの回数
 *
 * 1配信のうちに時間切れ（誰も正解できないまま制限時間が尽きた出題）が何回になったら配信を止めるかを、1〜上限の整数で持つ。
 * 設定は漢字クイズとして1つだけで（worker/kanji-quiz-miss-limit.ts。KV）、どの報酬から出した出題も同じ配信のうちは通しで数える。
 * 未保存なら1回（時間切れになったらすぐ止める。回数を設定にする前と同じ）。
 *
 * 注意: Worker（保存時の検証と時間切れの判定）と管理画面（選択肢と応答の読み取り）が同じ判定を使う。Worker から src/ を読み込む例外の1つで、
 * 判定を2か所に書き分けないためである（.claude/rules/kanji-quiz.md）。
 */

/** 選べる回数の上限。これより多いと「配信が終わるかもしれない」緊張がほとんど無くなる */
export const MAX_KANJI_QUIZ_MISS_LIMIT = 10

/** 未保存のときの回数。回数を設定にする前と同じく、1回の時間切れで配信を止める */
export const DEFAULT_KANJI_QUIZ_MISS_LIMIT = 1

/** 選べる回数（管理画面の選択肢）。小さい順 */
export const KANJI_QUIZ_MISS_LIMITS: readonly number[] = Array.from({ length: MAX_KANJI_QUIZ_MISS_LIMIT }, (_, index) => index + 1)

/** 配信を止めるまでの時間切れの回数の設定 */
export interface KanjiQuizMissLimit {
  readonly missLimit: number
}

/** 値が配信を止めるまでの時間切れの回数（1〜上限の整数）か */
export const isKanjiQuizMissLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_KANJI_QUIZ_MISS_LIMIT

/**
 * Worker から返ってきた設定を読む（管理画面）。
 *
 * @throws 回数が 1〜上限の整数でない・形が違う場合
 */
export const readKanjiQuizMissLimit = (body: unknown): KanjiQuizMissLimit => {
  const missLimit = typeof body === 'object' && body !== null && 'missLimit' in body ? body.missLimit : undefined
  if (!isKanjiQuizMissLimit(missLimit)) throw new Error(`配信を止めるまでの時間切れの回数は 1〜${MAX_KANJI_QUIZ_MISS_LIMIT} の整数のはずです`)
  return { missLimit }
}
