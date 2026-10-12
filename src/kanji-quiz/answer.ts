/**
 * 漢字クイズの回答の読み方
 *
 * チャットの発言を、前後の空白を除きカタカナをひらがなに直してから読む。Worker の正解の照合（worker/kanji-quiz-answer.ts）と、
 * 合成ページの「直前の回答」の判定（wrongKanjiQuizAnswerOf）が同じ直し方を通すよう、ここだけが持つ
 * （Worker から src/kanji-quiz/ を読み込む例外の1つ。.claude/rules/kanji-quiz.md）。
 *
 * 不正解かどうかは、ひらがな・カタカナ（と長音符）だけの短い発言を回答とみなし、出題中の熟語の読みと照らして決める。
 * 漢字・英数字・記号・空白を含む発言は雑談とみなして出さない。
 *
 * 注意: 通信も DOM も持ち込まない（Worker からも読むため）。
 */

/** カタカナ（ァ〜ヶ）の範囲。ひらがな（ぁ〜ゖ）と同じ並びで、符号の位置が KATAKANA_OFFSET だけずれている */
const KATAKANA_PATTERN = /[ァ-ヶ]/g
const KATAKANA_OFFSET = 0x60
/** 回答とみなす発言（カタカナをひらがなに直したあと）。ひらがなと長音符だけ */
const ANSWER_LIKE_PATTERN = /^[ぁ-ゖー]+$/
/** 回答とみなす発言の長さの上限（文字数）。熟語の読みより長い発言は回答ではなく雑談とみなす */
const ANSWER_MAX_LENGTH = 20

/** 前後の空白を除き、カタカナをひらがなに直す（長音符はそのまま） */
export const normalizeKanjiQuizAnswer = (text: string): string =>
  text.trim().replace(KATAKANA_PATTERN, (katakana) => String.fromCharCode(katakana.charCodeAt(0) - KATAKANA_OFFSET))

/**
 * 発言が出題中の熟語への不正解の回答なら、前後の空白を除いた発言（書かれたままの形）を返す。回答とみなさない発言と正解は null。
 *
 * @param readings 出題中の熟語の正解の読み（問題集の readings）
 */
export const wrongKanjiQuizAnswerOf = (text: string, readings: readonly string[]): string | null => {
  const answer = text.trim()
  if ([...answer].length > ANSWER_MAX_LENGTH) return null
  const reading = normalizeKanjiQuizAnswer(answer)
  if (!ANSWER_LIKE_PATTERN.test(reading) || readings.includes(reading)) return null
  return answer
}
