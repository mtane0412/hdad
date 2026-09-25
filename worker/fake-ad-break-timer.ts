/**
 * テスト用の広告の終了のタイマー
 *
 * Durable Object の代わりに、預けられた予約を配列へ貯める。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。
 */
import type { AdBreakEnd, AdBreakTimerNamespace } from './ad-break-timer'
import { STATUS } from './http'

interface FakeAdBreakTimerOptions {
  /** 預け先が失敗を返す場合（予約側が失敗を握りつぶさないことを確かめる） */
  失敗する?: boolean
}

/** 預けられた予約を直接確かめられるよう、記録も一緒に返す */
export const createFakeAdBreakTimer = ({ 失敗する = false }: FakeAdBreakTimerOptions = {}): {
  namespace: AdBreakTimerNamespace
  渡された予約: AdBreakEnd[]
} => {
  const 渡された予約: AdBreakEnd[] = []
  const id: DurableObjectId = { toString: () => 'ad-break', equals: (other) => other.toString() === 'ad-break', name: 'ad-break' }

  return {
    渡された予約,
    namespace: {
      idFromName: () => id,
      get: () => ({
        fetch: async (request: Request) => {
          if (失敗する) return new Response(null, { status: STATUS.internalServerError })
          渡された予約.push((await request.json()) as AdBreakEnd)
          return new Response(null, { status: STATUS.noContent })
        },
      }),
    },
  }
}
