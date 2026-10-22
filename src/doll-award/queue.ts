/**
 * 人形の獲得の素材の順番待ち
 *
 * 合成ページ（src/overlay/stage.ts の mountDollAward）は、届いたものを1件ずつ出す。所持数とランキングは誰でもチャットで出せるので、
 * 大勢が続けて打つと順番待ちが伸び、獲得の演出が遅れたり古い所持数を延々と流したりする。そこで並べ方を次のように決める。
 * - 獲得は必ず後ろに並べる（人形を渡した出来事は落とさない）
 * - 同じ人の所持数・ランキングがもう待っていれば、その場所で新しいものに置き換える（新しいほうが正しく、2度流す意味が無い）
 * - 所持数とランキングは、待っているものが MAX_WAITING_DOLL_MESSAGES 件に達していれば並べない
 */
import type { DollAwardMessage } from './call'

/** 所持数とランキングを並べてよい、待っているものの件数の上限 */
export const MAX_WAITING_DOLL_MESSAGES = 5

/** 置き換えの対象を見分ける鍵。獲得は置き換えないので null */
const replaceKeyOf = (message: DollAwardMessage): string | null => {
  switch (message.type) {
    case 'award':
      return null
    case 'standing':
      return `standing:${message.userId}`
    case 'ranking':
      return 'ranking'
    default: {
      const exhaustive: never = message
      throw new Error(`知らない種類です: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * 届いた1件を順番待ちに並べた結果を返す（元の配列は変えない。並べなかったときは元の配列をそのまま返す）。
 */
export const enqueueDollAwardMessage = (waiting: readonly DollAwardMessage[], message: DollAwardMessage): readonly DollAwardMessage[] => {
  const key = replaceKeyOf(message)
  if (key === null) return [...waiting, message]
  const index = waiting.findIndex((other) => replaceKeyOf(other) === key)
  if (index !== -1) return waiting.map((other, position) => (position === index ? message : other))
  if (waiting.length >= MAX_WAITING_DOLL_MESSAGES) return waiting
  return [...waiting, message]
}
