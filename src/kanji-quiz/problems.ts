/**
 * 漢字クイズの問題集の読み取り
 *
 * 問題集（problems.json）は配信者が目で確かめた問題だけを持つ（issue #300）。LLM や辞書からその場で作らないのは、
 * 正答の判定が配信の強制終了に直結するため、読みの誤りを事前に人の目で潰すためである。
 * 1問は熟語・正解の読み（ひらがな。複数可）・漢検の級・解説を持つ。級は問題ごとに手で付ける。
 * 級を決めるのは先頭の読み（想定する読み）だけで、2つ目以降はほかに辞書が認める読みを正解として受け付けるために持つ
 * （漢検の級別漢字表は機械で読める公開データが無く、推定させないため）。
 *
 * 注意: Worker（出題）からも読み込むので、DOM や src/core/ のブラウザ向けの部品に頼らない。
 * 注意: 形の誤りは黙って飛ばさずに投げる（Fail-Fast）。問題集の形はテスト（problems.test.ts）でも確かめる。
 */
import { isKankenGrade, type KankenGrade } from './grade'

/** 問題1問 */
export interface KanjiQuizProblem {
  /** 出題する熟語 */
  readonly word: string
  /** 正解の読み（ひらがなだけ）。どれを答えても正解にする。先頭が想定する読みで、級はこれで決める（2つ目以降は級より上で習う読みでもよい） */
  readonly readings: readonly string[]
  readonly grade: KankenGrade
  /** 時間切れのあとに出す解説 */
  readonly explanation: string
}

/** 読みに使える文字（ひらがなと長音符） */
const READING_PATTERN = /^[ぁ-ゖー]+$/

/**
 * 問題1問を読む。問題集の読み取りと、合成ページが押し出された出題を読むとき（call.ts）の両方で使う。
 *
 * @param at 問題点に添える位置（例: 漢字クイズの問題集の3番目）
 * @throws 問題の形が違う場合
 */
export const readKanjiQuizProblem = (candidate: unknown, at: string): KanjiQuizProblem => {
  const { word, readings, grade, explanation }: Record<string, unknown> = typeof candidate === 'object' && candidate !== null ? { ...candidate } : {}
  const where = `${at}（${typeof word === 'string' ? word : '?'}）`
  if (typeof word !== 'string' || word === '') throw new Error(`${where}: 熟語を空でない文字列にしてください`)
  if (!Array.isArray(readings) || readings.length === 0) throw new Error(`${where}: 読みを1つ以上の配列にしてください`)
  const readingStrings = readings.filter((reading: unknown): reading is string => typeof reading === 'string' && READING_PATTERN.test(reading))
  if (readingStrings.length !== readings.length) throw new Error(`${where}: 読みはひらがなだけで書いてください`)
  if (new Set(readingStrings).size !== readingStrings.length) throw new Error(`${where}: 同じ読みが2回あります`)
  if (!isKankenGrade(grade)) throw new Error(`${where}: 級を既知の値（10〜1・pre2・pre1）にしてください`)
  if (typeof explanation !== 'string' || explanation === '') throw new Error(`${where}: 解説を空でない文字列にしてください`)
  return { word, readings: readingStrings, grade, explanation }
}

/**
 * 問題集の中身を読み、問題の一覧にする。
 *
 * @throws 配列でない・問題の形が違う・同じ熟語が2問ある場合（何番目のどの熟語かを添える）
 */
export const readKanjiQuizProblems = (value: unknown): readonly KanjiQuizProblem[] => {
  if (!Array.isArray(value)) throw new Error('漢字クイズの問題集は配列にしてください')
  const seen = new Set<string>()
  return value.map((candidate: unknown, index): KanjiQuizProblem => {
    const problem = readKanjiQuizProblem(candidate, `漢字クイズの問題集の${index}番目`)
    if (seen.has(problem.word)) throw new Error(`漢字クイズの問題集の${index}番目（${problem.word}）: 熟語が重複しています`)
    seen.add(problem.word)
    return problem
  })
}
