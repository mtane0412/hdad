/**
 * テスト用の Jev の代役
 *
 * Worker のテストだけが使う（プロダクションコードからは参照しない）。意見ボードの絞り込み（worker/opinion-filter.ts）のように、
 * Noul の質問を名前ごとに尋ねる箇所の代役で、渡された注文と箇所を控え、決めた答え（質問の名前ごとの確率）を返す。
 */
import type { JevAnswers, JevClient, JevQuestion, JevRequest, JevUsage } from './jev'

/**
 * Noul の答えを返す Jev の代役を作る。
 *
 * @param answers 質問の名前ごとの確率。Error を渡すと、呼ばれたときにそれを投げる（残高切れなどの再現）
 */
export const createFakeNoulJev = (
  answers: Readonly<Record<string, number>> | Error,
): JevClient & { requests: JevRequest<Record<string, JevQuestion>>[]; usages: JevUsage[] } => {
  const requests: JevRequest<Record<string, JevQuestion>>[] = []
  const usages: JevUsage[] = []
  return {
    requests,
    usages,
    decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(usage: JevUsage, request: JevRequest<Qs>): Promise<JevAnswers<Qs>> => {
      usages.push(usage)
      requests.push(request)
      if (answers instanceof Error) throw answers
      // 代役の答えは質問の名前ごとの確率（Noul の答えの形）なので、そのまま返す
      return answers as JevAnswers<Qs>
    },
  }
}
