/**
 * 外へ出る呼び出しの時間制限
 *
 * Worker から外へ出る呼び出し（Twitch の Helix API・LLM・Gyazo）に、待つのをやめる期限を与える（issue #126）。
 * 相手が失敗を返さずに黙り続けると、cron の1回分がそこで止まり、後ろの処理（配信の記録・材料づくり）へ進めない。
 *
 * 期限の値はここでは決めず、呼び出し側のモジュール（worker/twitch.ts・worker/gyazo.ts・worker/llm.ts）が
 * 相手ごとの定数として持つ。相手によって待つべき時間が違う（LLMは文面を作るので長く、Twitchの問い合わせは短い）ためである。
 *
 * 注意: 期限に達したら黙って空の結果に落とさず TimeoutError を投げる（Fail-Fast）。呼び出し側が失敗として
 * 記録するので、配信者が「相手が応答しなかった」ことに管理画面から気づける。
 * 注意: 相手の応答を待つのをやめるだけでなく、中断の合図（AbortSignal）も渡す。合図を渡さないと、
 * Worker は要求そのものを投げたまま抱え続け、外への呼び出しの枠（サブリクエスト）を無駄に占める。
 * 注意: 合図を渡したうえで、待つのをやめる側（Promise.race）も持つ。中断を見ない相手（Workers AI の
 * バインディングや、テストで差し替える代役）では、合図だけでは待つのをやめられないためである。
 */

/** 相手が決めた時間のうちに応答しなかった */
export class TimeoutError extends Error {
  override name = 'TimeoutError'

  /**
   * @param 相手 待っていた相手の名前（Twitch・Gyazo・OpenRouter・Workers AI）。失敗の記録から原因を読むために入れる
   * @param milliseconds 待った時間（ミリ秒）
   */
  constructor(
    readonly 相手: string,
    readonly milliseconds: number,
  ) {
    super(`${相手} が ${milliseconds / 1000}秒以内に応答しませんでした`)
  }
}

/**
 * 中断の合図が上がったら TimeoutError で終わる約束を作る。
 *
 * すでに上がっている場合にも備えるのは、AbortSignal.timeout の期限が 0 に近いときに、
 * 見張りを付ける前に上がっていることがあるためである。
 */
const 期限の見張り = (signal: AbortSignal, 相手: string, milliseconds: number): Promise<never> =>
  new Promise((_resolve, reject) => {
    const やめる = (): void => reject(new TimeoutError(相手, milliseconds))
    if (signal.aborted) やめる()
    else signal.addEventListener('abort', やめる, { once: true })
  })

/**
 * 決めた時間で待つのをやめる通信を作る。
 *
 * @param fetchImpl 元の通信（テストでは代役が渡る）
 * @param milliseconds 待つ時間の上限（ミリ秒）
 * @param 相手 待つ相手の名前。失敗の文面に入る
 * @returns 元の通信と同じ形の関数。期限に達すると TimeoutError で失敗する
 */
export const withTimeout =
  (fetchImpl: typeof fetch, milliseconds: number, 相手: string): typeof fetch =>
  (input, init) => {
    const 期限 = AbortSignal.timeout(milliseconds)
    // 呼び出し側が自前の合図を渡していれば、そちらも効いたままにする（どちらが上がっても中断する）
    const signal = init?.signal ? AbortSignal.any([init.signal, 期限]) : 期限
    return Promise.race([fetchImpl(input, { ...init, signal }), 期限の見張り(期限, 相手, milliseconds)])
  }

/**
 * 中断の合図を受け取れない呼び出しを、決めた時間で待つのをやめる。
 *
 * Workers AI のバインディング（Env.AI の run）は合図を受け取れないので、呼び出しそのものは中断できない。
 * それでも待つのをやめれば、cron の1回分が黙った相手のところで止まり続けることは防げる。
 *
 * @param 呼び出す 呼び出しを始める関数（この中で投げられた失敗もそのまま伝わる）
 * @param milliseconds 待つ時間の上限（ミリ秒）
 * @param 相手 待つ相手の名前。失敗の文面に入る
 */
export const runWithTimeout = async <Result>(呼び出す: () => Promise<Result>, milliseconds: number, 相手: string): Promise<Result> => {
  const 期限 = AbortSignal.timeout(milliseconds)
  return await Promise.race([呼び出す(), 期限の見張り(期限, 相手, milliseconds)])
}
