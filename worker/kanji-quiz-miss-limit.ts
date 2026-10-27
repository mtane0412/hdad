/**
 * 漢字クイズで配信を止めるまでの時間切れの回数の設定
 *
 * 1配信のうちに時間切れ（誰も正解できないまま制限時間が尽きた出題）が何回になったら配信を止めるかを、管理画面（/triggers/ の漢字クイズのカード）から
 * 受け取って検証し、ストア（KV）に保存する。読むのは時間切れの判定（kanji-quiz-stop.ts）と出題（合成ページに残りの回数を出すため）で、
 * ここは設定の形と保存先だけを扱う。設定は漢字クイズとして1つだけで、どの報酬から出した出題も同じ配信のうちは通しで数える。
 *
 * 回数の範囲と未保存のときの値は src/kanji-quiz/miss-limit.ts にあり、管理画面と同じものを読む（Worker から src/kanji-quiz/ を読み込む例外）。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
import { DEFAULT_KANJI_QUIZ_MISS_LIMIT, MAX_KANJI_QUIZ_MISS_LIMIT, isKanjiQuizMissLimit, type KanjiQuizMissLimit } from '../src/kanji-quiz/miss-limit'
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

export type { KanjiQuizMissLimit }

const MISS_LIMIT_KEY = 'kanji-quiz-miss-limit'
/** 問題点のメッセージに出す、何の設定かの名前 */
const MISS_LIMIT_SUBJECT = '漢字クイズの配信終了までの時間切れの回数'

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @param input `{ missLimit }`（1〜上限の整数）
 * @throws ConfigError 形が違う・回数が範囲の外の場合
 */
export const parseKanjiQuizMissLimit = (input: unknown): KanjiQuizMissLimit => {
  if (typeof input !== 'object' || input === null) throw new ConfigError(MISS_LIMIT_SUBJECT, ['設定はオブジェクトで指定してください'])
  const missLimit = 'missLimit' in input ? input.missLimit : undefined
  if (!isKanjiQuizMissLimit(missLimit)) throw new ConfigError(MISS_LIMIT_SUBJECT, [`missLimit: 1〜${MAX_KANJI_QUIZ_MISS_LIMIT} の整数で指定してください`])
  return { missLimit }
}

export const saveKanjiQuizMissLimit = (store: KeyValueStore, setting: KanjiQuizMissLimit): Promise<void> => store.put(MISS_LIMIT_KEY, JSON.stringify(setting))

/** 保存済みの設定を読む。未保存なら1回（回数を設定にする前と同じく、1回の時間切れで配信を止める） */
export const loadKanjiQuizMissLimit = async (store: KeyValueStore): Promise<KanjiQuizMissLimit> => {
  const text = await store.get(MISS_LIMIT_KEY)
  return text === null ? { missLimit: DEFAULT_KANJI_QUIZ_MISS_LIMIT } : (JSON.parse(text) as KanjiQuizMissLimit)
}
