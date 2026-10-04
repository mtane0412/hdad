/**
 * GitHub の Webhook の受け口（POST /api/github/webhook）
 *
 * 配信者のリポジトリで起きた開発の出来事（コミットの push・PR のマージ）を受け、トリガーの既定メニューの
 * 区分「開発」の動作（アラート・botの書き込み）を実行する。作業配信で、画面からは分からない「進んだ瞬間」に区切りを付けるためである。
 *
 * 誰でも呼べるURLなので、署名（GITHUB_WEBHOOK_SECRET による HMAC）で GitHub からの通知であることを確かめる。
 * 受け付けるリポジトリの一覧は持たない。GitHub には個人アカウント単位の Webhook が無く、配信者がリポジトリごとに
 * Webhook を設定するので、**Webhook を設定したリポジトリ＝配信者が選んだリポジトリ**とみなす。
 *
 * 注意: 配信していないときに届いた出来事は捨てる。配信外の作業で Twitch のチャットに bot が書き込んだり、
 *   次に OBS を開いたときに古いアラートが鳴ったりしないようにするためである。捨てた理由は本文に書いて 200 で返し、
 *   GitHub の Recent Deliveries から「なぜ鳴らなかったか」を読めるようにする。
 * 配信中に届いた出来事は、トリガーに当てはまるかどうかと関係なく、合成ページの素材「作業ログ」に1行残して押し出す
 * （issue #211）。作業ログは「その配信で実際に起きたこと」の記録なので、トリガーの設定に左右されないようにする。
 *
 * 注意: 同じ通知の再送（GitHub の Redeliver は同じ X-GitHub-Delivery を使う）で二重に実行しないよう、
 *   動作ごとの鍵は X-GitHub-Delivery から作る（runAlertActions の reserveChatReply）。GitHub の通知には時刻の
 *   ヘッダーが無いので、EventSub のように古い通知を拒むことはしない。
 */
import { runAlertActions } from './alert-actions'
import { pushWorkLogEntry } from './alert-channel'
import { extract } from './alert-event'
import { GITHUB_EVENT, githubAlertEventOf, verifyGithubSignature } from './github-webhook'
import { HttpError, STATUS, type Context } from './http'
import { isStreaming } from './screen-store'
import { loadToken } from './token'
import { devEventOf } from './work-log'
import { recordDevEvent } from './work-log-store'

export const GITHUB_WEBHOOK_PATH = '/api/github/webhook'

const HEADER = {
  event: 'X-GitHub-Event',
  delivery: 'X-GitHub-Delivery',
  signature: 'X-Hub-Signature-256',
  contentType: 'Content-Type',
} as const

const JSON_CONTENT_TYPE = 'application/json'

/**
 * 動作ごとの鍵の頭。Twitchのメッセージ ID と同じ表（replied_chat_messages）に鍵を書くので、取り違えないように付ける
 */
const DELIVERY_KEY_PREFIX = 'github:'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const invalid = (message: string): HttpError => new HttpError(STATUS.badRequest, 'invalid-webhook', message)

/** 何も実行しなかった理由を本文に書いて返す（GitHub の Recent Deliveries で読めるように） */
const ignored = (reason: 'not-a-trigger' | 'not-streaming'): Response => Response.json({ ignored: reason }, { status: STATUS.ok })

const parseBody = (text: string): Record<string, unknown> => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw invalid('通知の本文をJSONとして読めません')
  }
  if (!isRecord(body)) throw invalid('通知の本文がJSONのオブジェクトではありません')
  return body
}

export const githubWebhook = async (context: Context): Promise<Response> => {
  const { request, env, now } = context
  const eventName = request.headers.get(HEADER.event)
  const delivery = request.headers.get(HEADER.delivery)
  const signature = request.headers.get(HEADER.signature)
  if (!eventName || !delivery || !signature) throw invalid('X-GitHub-Event・X-GitHub-Delivery・X-Hub-Signature-256 のヘッダーが揃っていません')

  // 鍵は任意のシークレットなので、無ければ黙って受け付けずに設定の誤りとして返す（署名を確かめずに通すことはしない）
  const secret = env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    throw new HttpError(STATUS.internalServerError, 'misconfigured', 'GitHub の Webhook の鍵（WorkerのシークレットGITHUB_WEBHOOK_SECRET）が設定されていません')
  }

  // 署名は届いた文字列そのものに対して確かめる。中身を読むのはそのあと
  const text = await request.text()
  if (!(await verifyGithubSignature({ body: text, signature, secret }))) {
    throw new HttpError(STATUS.forbidden, 'invalid-signature', '通知の署名が正しくありません')
  }

  // Webhook の Content type の既定は application/x-www-form-urlencoded なので、選び忘れると本文が JSON で届かない
  if (!request.headers.get(HEADER.contentType)?.startsWith(JSON_CONTENT_TYPE)) {
    throw invalid('通知の本文が JSON ではありません。Webhook の設定で Content type を application/json にしてください')
  }

  // 登録した直後に GitHub が届くかを確かめに来る。中身は無いので成功だけを返す
  if (eventName === GITHUB_EVENT.ping) return new Response(null, { status: STATUS.noContent })

  const payload = parseBody(text)
  const type = (() => {
    try {
      return githubAlertEventOf(eventName, payload)
    } catch (error) {
      throw new HttpError(STATUS.badRequest, 'unexpected-event', error instanceof Error ? error.message : String(error))
    }
  })()
  if (type === null) return ignored('not-a-trigger')
  if (!(await isStreaming(env.DB, now))) return ignored('not-streaming')

  // 作業ログに出す1行は、トリガーと同じ読み解き（alert-event.ts の extract）から作る。形が違えば何も実行せずに400にする
  const devEvent = (() => {
    try {
      const extracted = extract(type, payload)
      return extracted === null ? null : devEventOf(extracted)
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error))
    }
  })()
  if (devEvent === null) throw new Error(`開発の出来事として読めない種別です: ${type}`)

  // 実行は Twitch の通知と同じ入口を通す（照合・鍵の確保・失敗の記録をすべて共有する）。
  // 通知の中身は、Twitchの通知の event に当たる位置へ置く（alert-event.ts の extract が読む）
  await runAlertActions(
    context,
    type,
    { event: payload },
    `${DELIVERY_KEY_PREFIX}${delivery}`,
    async () => (await loadToken(env.TOKENS, 'bot')) !== null,
    null,
  )

  // 作業ログはトリガーの動作のあとに残す。押し出しに失敗したら500で返し、GitHub の Redeliver で届け直せるようにする
  // （再送では動作は鍵で弾かれ、作業ログは同じ1行のまま押し出し直される）
  const entry = await recordDevEvent(env.DB, { id: `${DELIVERY_KEY_PREFIX}${delivery}`, ...devEvent }, now)
  if (entry !== null) await pushWorkLogEntry(env.ALERTS, entry)
  return new Response(null, { status: STATUS.noContent })
}
