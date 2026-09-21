/**
 * 購読の依頼
 *
 * EventSubの購読にはTwitchのユーザートークンが要るが、トークンはWorkerだけが持つ。
 * オーバーレイはWebSocketのセッションIDとオーバーレイ用キーをWorker（/api/eventsub/subscriptions）へ送り、登録を代行してもらう。
 * fetch を引数で受け取るのは、テストで差し替えるため。
 */
const SUBSCRIPTIONS_PATH = '/api/eventsub/subscriptions'
/** Workerが「Twitch側の失敗」を伝えるときの状態コード。時間をおけば直る可能性がある */
const BAD_GATEWAY = 502

export type SubscribeResult =
  | { readonly ok: true }
  /** retryable が false なら、人が設定を直すまで直らない（キーの誤り・未ログイン・Workerの設定不足） */
  | { readonly ok: false; readonly retryable: boolean; readonly message: string }

/** Workerのエラー応答 { error: { message } } からメッセージを取り出す。形が違えば null */
export const readErrorMessage = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null
  const { error } = body
  if (typeof error !== 'object' || error === null || !('message' in error)) return null
  return typeof error.message === 'string' ? error.message : null
}

/**
 * EventSubのセッションに対する購読の登録をWorkerへ依頼する。
 *
 * 注意: 失敗は例外ではなく戻り値で返す。呼び出し側が retryable を見て、つなぎ直すか止まるかを決める。
 */
export const requestSubscriptions = async (key: string, sessionId: string, fetchImpl: typeof fetch): Promise<SubscribeResult> => {
  let response: Response
  try {
    response = await fetchImpl(SUBSCRIPTIONS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, sessionId }),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, retryable: true, message: `Workerと通信できませんでした（${detail}）` }
  }
  if (response.ok) return { ok: true }

  const body: unknown = await response.json().catch(() => null)
  return {
    ok: false,
    retryable: response.status === BAD_GATEWAY,
    message: readErrorMessage(body) ?? `Workerが ${response.status} を返しました`,
  }
}
