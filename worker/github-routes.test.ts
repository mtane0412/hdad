/**
 * GitHub の Webhook の受け口（POST /api/github/webhook）のテスト
 *
 * GitHub の代わりに署名付きのリクエストを作り、handleRequest を通して確かめる。特に重要なのは次の4点。
 * - 署名が正しくない通知・鍵を設定していないときの通知を受け付けないこと
 * - 配信していないときに届いた出来事では、何も実行しないこと（配信外の作業でチャットに書き込まない）
 * - 配信中に PR をマージすると、選んだトリガーの動作（アラート）が差し込み語を埋めて動くこと
 * - 同じ通知の再送（GitHub の Redeliver は同じ X-GitHub-Delivery を使う）で二重に実行しないこと
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { saveAlertConfig, type StoredTrigger } from './alert-config'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { handleRequest, type Env } from './index'
import { recordLiveStream } from './stats-store'

const NOW = Date.parse('2026-10-03T12:30:00Z')
const SITE = 'https://hdad.example.com'
const GITHUB_SECRET = 'テスト用のGitHubのWebhookシークレット'
const OVERLAY_KEY = 'issued-overlay-key-0123456789abcdefghij'
/** いま配信中の区切り（12:00 に始めた配信） */
const LIVE_STREAM = { id: '40000000001', startedAt: '2026-10-03T12:00:00.000Z', title: '作業配信', categoryName: 'Software and Game Development', viewerCount: 10 }

const createEnv = () => {
  const db = createFakeDatabase()
  const store = createFakeStore({ 'overlay-key': OVERLAY_KEY })
  const alertChannel = createFakeAlertChannel()
  const env = {
    STORE: store,
    MEDIA: createFakeBucket(),
    DB: db,
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: '12345',
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のEventSubのシークレット',
    GITHUB_WEBHOOK_SECRET: GITHUB_SECRET,
    ALERTS: alertChannel.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  return { env, db, store, alertChannel }
}

/** PR のマージで画面に「{repo} #{number}「{title}」をマージ」と出すトリガー */
const MERGE_ALERT_TRIGGER: StoredTrigger = {
  kind: 'pullRequestMerged',
  actions: [{ type: 'alert', mediaId: 'sozai-1', mediaKind: 'image', durationSeconds: 5, volume: 1, message: '{repo} #{number}「{title}」をマージ（{user}）' }],
}

/** コミットの push で画面に「{branch} に {message}」と出すトリガー */
const PUSH_ALERT_TRIGGER: StoredTrigger = {
  kind: 'commitPushed',
  actions: [{ type: 'alert', mediaId: 'sozai-1', mediaKind: 'image', durationSeconds: 5, volume: 1, message: '{branch} に {message}' }],
}

/** GitHub が送ってくる、PR がマージされたときの通知の中身 */
const MERGED_PAYLOAD = {
  action: 'closed',
  number: 212,
  sender: { login: 'mtane0412' },
  repository: { name: 'hdad', full_name: 'mtane0412/hdad', private: false },
  pull_request: { number: 212, title: 'コミットとPRのマージをトリガーのきっかけにする', merged: true },
}

/** GitHub が送ってくる、機能ブランチへコミットを push したときの通知の中身 */
const PUSH_PAYLOAD = {
  ref: 'refs/heads/feature/github-webhook',
  deleted: false,
  sender: { login: 'mtane0412' },
  repository: { name: 'hdad', full_name: 'mtane0412/hdad', private: false },
  commits: [{ id: 'abc123', message: 'テストを先に書く\n\n詳しい説明' }],
  head_commit: { id: 'abc123', message: 'テストを先に書く\n\n詳しい説明' },
}

interface DeliveryOptions {
  event?: string
  delivery?: string
  secret?: string
  contentType?: string
  body: unknown
}

/** GitHub が送ってくるのと同じ形の、署名付きのリクエストを作る */
const createDelivery = ({ event = 'pull_request', delivery = '72d3162e-cc78-11e3-81ab-4c9367dc0958', secret = GITHUB_SECRET, contentType = 'application/json', body }: DeliveryOptions): Request => {
  const text = JSON.stringify(body)
  const signature = createHmac('sha256', secret).update(text).digest('hex')
  return new Request(`${SITE}/api/github/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': `sha256=${signature}`,
    },
    body: text,
  })
}

const noFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const callWebhook = (request: Request, env: Env) =>
  handleRequest(request, env, { fetch: noFetch, now: () => NOW, wait: async () => {}, waitUntil: () => {} })

const errorCode = async (response: Response): Promise<unknown> => {
  const body = (await response.json()) as { error?: { code?: unknown } }
  return body.error?.code
}

describe('通知の検証', () => {
  it('署名が正しくなければ403にし、何も実行しない', async () => {
    const { env, db, store, alertChannel } = createEnv()
    await saveAlertConfig(store, { triggers: [MERGE_ALERT_TRIGGER] })
    await recordLiveStream(db, LIVE_STREAM, NOW - 60 * 1000)

    const response = await callWebhook(createDelivery({ body: MERGED_PAYLOAD, secret: '攻撃者が推測した鍵' }), env)

    expect(response.status).toBe(403)
    expect(await errorCode(response)).toBe('invalid-signature')
    expect(alertChannel.pushedAlerts).toEqual([])
  })

  it('GitHub のヘッダーが欠けていたら400にする', async () => {
    const { env } = createEnv()
    const response = await callWebhook(new Request(`${SITE}/api/github/webhook`, { method: 'POST', body: '{}' }), env)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('invalid-webhook')
  })

  it('GITHUB_WEBHOOK_SECRET を設定していなければ、署名を確かめられないので500にする', async () => {
    const { env } = createEnv()

    const response = await callWebhook(createDelivery({ body: MERGED_PAYLOAD }), { ...env, GITHUB_WEBHOOK_SECRET: '' })

    expect(response.status).toBe(500)
    expect(await errorCode(response)).toBe('misconfigured')
  })

  it('本文が JSON でない（Webhook の Content type が form のまま）なら、直し方の分かる400にする', async () => {
    const { env } = createEnv()
    const response = await callWebhook(createDelivery({ body: MERGED_PAYLOAD, contentType: 'application/x-www-form-urlencoded' }), env)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('invalid-webhook')
  })

  it('Webhook を登録した直後の ping には、何も実行せず成功を返す', async () => {
    const { env } = createEnv()
    const response = await callWebhook(createDelivery({ event: 'ping', body: { zen: 'Keep it logically awesome.', hook_id: 1 } }), env)

    expect(response.status).toBe(204)
  })

  it('扱わない種類の出来事は400にする（Webhook の設定で選ぶ出来事の誤りに気付けるように）', async () => {
    const { env } = createEnv()
    const response = await callWebhook(createDelivery({ event: 'issues', body: { action: 'opened' } }), env)

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('unexpected-event')
  })
})

describe('トリガーの実行', () => {
  it('配信中に PR がマージされたら、差し込み語を埋めたアラートを押し出す', async () => {
    const { env, db, store, alertChannel } = createEnv()
    await saveAlertConfig(store, { triggers: [MERGE_ALERT_TRIGGER] })
    await recordLiveStream(db, LIVE_STREAM, NOW - 60 * 1000)

    const response = await callWebhook(createDelivery({ body: MERGED_PAYLOAD }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedAlerts.map((alert) => alert.text)).toEqual(['hdad #212「コミットとPRのマージをトリガーのきっかけにする」をマージ（mtane0412）'])
  })

  it('配信中にコミットが push されたら、ブランチ名とコミットのメッセージの1行目を埋めたアラートを押し出す', async () => {
    const { env, db, store, alertChannel } = createEnv()
    await saveAlertConfig(store, { triggers: [PUSH_ALERT_TRIGGER] })
    await recordLiveStream(db, LIVE_STREAM, NOW - 60 * 1000)

    const response = await callWebhook(createDelivery({ event: 'push', body: PUSH_PAYLOAD }), env)

    expect(response.status).toBe(204)
    expect(alertChannel.pushedAlerts.map((alert) => alert.text)).toEqual(['feature/github-webhook に テストを先に書く'])
  })

  it('配信していないときに届いた出来事では、何も実行しない（理由を本文に書いて200を返す）', async () => {
    const { env, store, alertChannel } = createEnv()
    await saveAlertConfig(store, { triggers: [MERGE_ALERT_TRIGGER] })

    const response = await callWebhook(createDelivery({ body: MERGED_PAYLOAD }), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ignored: 'not-streaming' })
    expect(alertChannel.pushedAlerts).toEqual([])
  })

  it('マージせずに閉じた PR では、何も実行しない（理由を本文に書いて200を返す）', async () => {
    const { env, db, store, alertChannel } = createEnv()
    await saveAlertConfig(store, { triggers: [MERGE_ALERT_TRIGGER] })
    await recordLiveStream(db, LIVE_STREAM, NOW - 60 * 1000)

    const closed = { ...MERGED_PAYLOAD, pull_request: { ...MERGED_PAYLOAD.pull_request, merged: false } }
    const response = await callWebhook(createDelivery({ body: closed }), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ignored: 'not-a-trigger' })
    expect(alertChannel.pushedAlerts).toEqual([])
  })

  it('同じ通知が再送されても（同じ X-GitHub-Delivery）、アラートは1度しか押し出さない', async () => {
    const { env, db, store, alertChannel } = createEnv()
    await saveAlertConfig(store, { triggers: [MERGE_ALERT_TRIGGER] })
    await recordLiveStream(db, LIVE_STREAM, NOW - 60 * 1000)

    await callWebhook(createDelivery({ body: MERGED_PAYLOAD }), env)
    await callWebhook(createDelivery({ body: MERGED_PAYLOAD }), env)

    expect(alertChannel.pushedAlerts).toHaveLength(1)
  })
})
