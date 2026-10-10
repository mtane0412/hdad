/**
 * 漢字クイズの回答の読み取り（issue #301）
 *
 * チャットの発言を、前後の空白を除きカタカナをひらがなに直してから、問題集の読みのいずれかと完全一致で照らす。
 * 部分一致とローマ字は受けない（正答の判定が配信の強制終了に直結するため、緩く受けて誤って正解にしない。issue #293）。
 * どの熟語を出題中かはここでは決めず、一致した読みを持つ熟語を返すだけにする（決めるのは D1 の出題の行。kanji-quiz-store.ts）。
 * 一致しなければ空を返し、Webhook はそのとき D1 を読まない（チャットの全件で D1 を読まないため）。
 */
import type { KanjiQuizProblem } from '../src/kanji-quiz/problems'
import { KANJI_QUIZ_PROBLEMS } from './kanji-quiz-call'

/** カタカナ（ァ〜ヶ）の範囲。ひらがな（ぁ〜ゖ）と同じ並びで、符号の位置が KATAKANA_OFFSET だけずれている */
const KATAKANA_PATTERN = /[ァ-ヶ]/g
const KATAKANA_OFFSET = 0x60

/** 前後の空白を除き、カタカナをひらがなに直す（長音符はそのまま） */
export const normalizeKanjiQuizAnswer = (text: string): string =>
  text.trim().replace(KATAKANA_PATTERN, (katakana) => String.fromCharCode(katakana.charCodeAt(0) - KATAKANA_OFFSET))

/**
 * 発言を回答として読み、その読みを持つ熟語をすべて返す（同じ読みの熟語が複数あることがある）。
 *
 * @param problems 照らす問題集。省けばリポジトリの問題集
 */
export const wordsAnsweredBy = (text: string, problems: readonly KanjiQuizProblem[] = KANJI_QUIZ_PROBLEMS): string[] => {
  const reading = normalizeKanjiQuizAnswer(text)
  return problems.filter((problem) => problem.readings.includes(reading)).map(({ word }) => word)
}
