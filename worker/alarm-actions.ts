/**
 * Durable Object のアラームから、擬似イベントのトリガーの動作を実行する
 *
 * Twitch・GitHub から届く通知ではなく、Worker が時刻を決めて作る出来事（広告の終了・ポモドーロの区切り）は、
 * Durable Object のアラーム（worker/ad-break-timer.ts の AdBreakTimer）で起こしてもらってから照合へ回す。
 * アラームには通知を受けたときの文脈（Context）が無いので、ここで同じ形を組み立てて runAlertActions に渡す。
 * 広告の終了とポモドーロの区切りの両方がこれを使う（文脈の組み立てを2か所に書かないため）。
 */
import { recordLateFailure, runAlertActions } from './alert-actions'
import type { Env } from './http'
import { createLlm } from './llm'
import { loadToken } from './token'
import { createTwitchClient } from './twitch'

/**
 * アラームが鳴ったときに要る依存。Cloudflare のランタイムから受け取れないものをテストで差し替えるために分ける
 * （Workerの入口が fetch・現在時刻を引数で受け取るのと同じ作り）。
 */
export interface AlarmDependencies {
  fetch: typeof fetch
  /** 現在時刻（ミリ秒） */
  now(): number
  /** 指定した時間だけ待つ。アナウンスの送信間隔を空けるのに使う */
  wait(milliseconds: number): Promise<void>
}

/**
 * 擬似イベントに当てはまるトリガーの動作を実行する。
 *
 * 注意: LLMに文面を作らせる動作（aiChat）は応答を待つと遅いため、ふだんはTwitchへの応答後に回している。
 * アラームには待たせる相手がいないので、ここでは後回しにされた処理も最後まで待つ（待たずに終えると取りこぼす）。
 *
 * 注意: 失敗は投げずに failureCode の収集の失敗として記録する。アラームから呼ぶときは予約や区切りをもう進めているので、
 * 投げてアラームを再試行させても取り返せず、失敗が誰にも届かないまま消えてしまう
 * （送信そのものの失敗は runAlertActions の中で動作ごとに記録される。ここで受け止めるのはその手前の失敗である）。
 *
 * @param body 通知の形（{ event: 中身 }）。alert-event.ts の extract が event を読む
 * @param messageId 二重送信を防ぐ鍵の素
 */
export const runAlarmActions = async (
  env: Env,
  dependencies: AlarmDependencies,
  failureCode: string,
  subscriptionType: string,
  body: Record<string, unknown>,
  messageId: string,
): Promise<void> => {
  const deferredTask: Promise<unknown>[] = []
  const twitch = createTwitchClient({ clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, fetch: dependencies.fetch })
  const context = {
    env,
    twitch,
    // アラームからも、通知を受けたときと同じLLM（設定に従って呼び先を決めるもの）を通す
    llm: createLlm({ ai: env.AI, store: env.STORE, fetch: dependencies.fetch, apiKey: env.OPENROUTER_API_KEY, db: env.DB, now: dependencies.now }),
    now: dependencies.now(),
    wait: dependencies.wait,
    waitUntil: (promise: Promise<unknown>): void => void deferredTask.push(promise),
  }

  await recordLateFailure(context, failureCode, async () => {
    // botの接続はここで調べる（チャット・アナウンスの動作は送り主のアカウントが要る）。
    // 状態を持つ条件（初めての発言かなど）は発言ではないので使わない
    await runAlertActions(context, subscriptionType, body, messageId, async () => (await loadToken(env.STORE, 'bot')) !== null, null)
    await Promise.all(deferredTask)
  })
}
