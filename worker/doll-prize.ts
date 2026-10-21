/**
 * ゲームの正解者に渡す人形（issue #420）
 *
 * チャットで推理と漢字クイズの正解者に、いまの人形を1つ渡す。何を渡すか（ふつう・スーパー・渡さない）はゲームごとに1つ持ち、
 * ストア（KV）に保存する。検証は worker/doll.ts の parseDollPrize が持ち、渡すのと獲得の演出の押し出しは worker/doll-award.ts の grantDolls が行う。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 * 注意: 渡せなかったとき（いまの人形が無いなど）は投げずに `doll-grant-failed` として記録する。ゲームの進行（終了・解説・
 *   正解者の表示）を人形のために止めないため（docs/principles.md の方針5の例外。docs/decisions/dolls.md）。
 *   記録そのものに失敗したときも投げず、Worker のログに残す。
 */
import { type DollPrize, type DollPrizeGame } from './doll'
import { grantDolls } from './doll-award'
import type { Context } from './http'
import { recordFailure } from './stats-store'
import type { KeyValueStore } from './store'

/** 保存していないときの設定。正解者に人形を渡さない */
const DEFAULT_DOLL_PRIZE: DollPrize = { kind: null }

/** 失敗のメッセージに出すゲームの名前 */
const GAME_LABELS: Readonly<Record<DollPrizeGame, string>> = { chatDeduction: 'チャットで推理', kanjiQuiz: '漢字クイズ' }

/** ゲームごとの KV の鍵。2つのページが別々に保存するので、1つの値にまとめず鍵を分ける（読んでから書く間に互いを上書きしないため） */
const keyOf = (game: DollPrizeGame): string => `doll-prize:${game}`

/** そのゲームの正解者に渡す人形を読む。保存していなければ渡さない */
export const loadDollPrize = async (store: KeyValueStore, game: DollPrizeGame): Promise<DollPrize> => {
  const text = await store.get(keyOf(game))
  return text === null ? DEFAULT_DOLL_PRIZE : (JSON.parse(text) as DollPrize)
}

/** そのゲームの正解者に渡す人形を保存する（検証は呼び出し側が parseDollPrize で済ませる） */
export const saveDollPrize = (store: KeyValueStore, game: DollPrizeGame, prize: DollPrize): Promise<void> => store.put(keyOf(game), JSON.stringify(prize))

/**
 * ゲームの正解者に、設定した人形（いまの人形）を1つ渡す。渡す人形が「なし」なら何もしない。
 *
 * @param winner 正解者の Twitch のユーザー ID と、失敗のメッセージに出す表示名
 * @param sourceId 台帳のきっかけの ID。ゲーム（出題）ごとに1つにし、同じ正解で二重に渡さない
 */
export const grantDollPrize = async (
  context: Context,
  game: DollPrizeGame,
  winner: { readonly userId: string; readonly userName: string },
  sourceId: string,
): Promise<void> => {
  const { env, now } = context
  try {
    const { kind } = await loadDollPrize(env.STORE, game)
    if (kind === null) return
    await grantDolls(env, now, { userId: winner.userId, kind, delta: 1, reason: game, sourceId }, winner.userName)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try {
      await recordFailure(env.DB, 'doll-grant-failed', `${GAME_LABELS[game]}の正解者（${winner.userName}さん）に人形を渡せませんでした: ${reason}`, now)
    } catch (failure) {
      // 記録にも失敗した（D1 の不調）。ここで投げるとゲームの進行が止まるので、Worker のログに残して続ける
      // （worker/alert-actions.ts の recordLateFailure と同じ扱い）
      console.error(failure)
    }
  }
}
