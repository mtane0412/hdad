/**
 * 拡張の zip（GET /api/admin/tab/extension.zip）のテスト
 *
 * 確かめるのは次の4点である。
 * - ビルド済みの拡張のファイルに、リクエストの置き場所を書いた config.json を加えた zip を返すこと
 *   （拡張側の読み取り（extension/src/config.ts）で読めることまで確かめ、書く側と読む側の形の食い違いを防ぐ）
 * - manifest.json に、その置き場所への権限（host_permissions）を書き足すこと（拡張が配信者のセッションでつなぐため）
 * - ログインしていなければ断ること
 * - ビルド済みのファイルが見つからなければ、欠けた zip を返さずに失敗させること
 *   （見つからないパスに index.html を返す設定（wrangler.jsonc の not_found_handling）でも、HTML を詰めない）
 */
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { parseExtensionConfig } from '../extension/src/config'
import { createFakeAdBreakTimer } from './fake-ad-break-timer'
import { createFakeTokenVault } from './fake-token-vault'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets, type FakeAsset } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTabChannel } from './fake-tab-channel'
import { handleRequest, type Env } from './index'
import { createSessionToken } from './session'

const now = Date.parse('2026-10-01T12:00:00Z')
const broadcasterId = '12345'
const site = 'https://hdad.example.workers.dev'

/** ビルド済みの拡張（npm run build:extension が public/tab-extension/ に出すもの） */
const builtExtension = {
  '/tab-extension/manifest.json': '{"manifest_version":3,"name":"HDAD タブの映像","permissions":["tabCapture","offscreen"]}',
  '/tab-extension/background.js': 'console.log("ボタンを受ける")',
  '/tab-extension/offscreen.js': 'console.log("取り込んで送る")',
  '/tab-extension/options.js': 'console.log("映さないサイトを管理する")',
}

const createEnv = (assets: Readonly<Record<string, FakeAsset>> = builtExtension) =>
  ({
    STORE: createFakeStore(),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(assets),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: broadcasterId,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: createFakeAlertChannel().namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: createFakeAdBreakTimer().namespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  }) satisfies Env

const noTwitchFetch = async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`テストで想定していない通信です: ${String(input)}`)
}

const noDefer = (): void => {
  throw new Error('このテストでは、応答のあとに続く処理を使いません')
}

const invoke = (request: Request, env: Env) => handleRequest(request, env, { fetch: noTwitchFetch, now: () => now, wait: async () => undefined, waitUntil: noDefer })

/** 配信者としてログインした状態でダウンロードする */
const download = async (env: Env) => {
  const session = await createSessionToken(broadcasterId, env.SESSION_SECRET, now)
  return invoke(new Request(`${site}/api/admin/tab/extension.zip`, { headers: { Cookie: `__Host-session=${session}` } }), env)
}

describe('GET /api/admin/tab/extension.zip', () => {
  it('ビルド済みの拡張に、この置き場所を書いた設定を加えた zip を返す', async () => {
    const response = await download(createEnv())

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="hdad-tab.zip"')
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual([
      'hdad-tab/background.js',
      'hdad-tab/config.json',
      'hdad-tab/manifest.json',
      'hdad-tab/offscreen.html',
      'hdad-tab/offscreen.js',
      'hdad-tab/options.html',
      'hdad-tab/options.js',
    ])
    expect(strFromU8(files['hdad-tab/offscreen.js'] ?? new Uint8Array())).toBe('console.log("取り込んで送る")')
    expect(parseExtensionConfig(JSON.parse(strFromU8(files['hdad-tab/config.json'] ?? new Uint8Array())))).toEqual({
      origin: 'https://hdad.example.workers.dev',
    })
  })

  it('設定ページ（options.html）も静的アセットから読まずに書く', async () => {
    const response = await download(createEnv())

    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(strFromU8(files['hdad-tab/options.html'] ?? new Uint8Array())).toContain('<script type="module" src="options.js"></script>')
  })

  it('offscreen.html は静的アセットから読まずに書く', async () => {
    // 公開先の静的アセットは /tab-extension/offscreen.html を拡張子なしのURLへリダイレクト（307）するので、読めない
    const response = await download(createEnv())

    expect(response.status).toBe(200)
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(strFromU8(files['hdad-tab/offscreen.html'] ?? new Uint8Array())).toContain('<script type="module" src="offscreen.js"></script>')
  })

  it('manifest.json に、この置き場所への権限を書き足す', async () => {
    // 権限があると、拡張から置き場所へのWebSocketに配信者のクッキーが付く
    const response = await download(createEnv())

    const files = unzipSync(new Uint8Array(await response.arrayBuffer()))
    expect(JSON.parse(strFromU8(files['hdad-tab/manifest.json'] ?? new Uint8Array()))).toEqual({
      manifest_version: 3,
      name: 'HDAD タブの映像',
      permissions: ['tabCapture', 'offscreen'],
      host_permissions: ['https://hdad.example.workers.dev/*'],
    })
  })

  it('ログインしていなければ断る', async () => {
    const response = await invoke(new Request(`${site}/api/admin/tab/extension.zip`), createEnv())

    expect(response.status).toBe(401)
  })

  it('ビルド済みの拡張が見つからなければ、欠けた zip を返さずに失敗させる', async () => {
    // npm run build の前に拡張のビルド（prebuild）が走らなかったときに起こる
    const response = await download(createEnv({ '/tab-extension/manifest.json': '{}' }))

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'tab-extension-missing' } })
  })

  it('見つからないファイルの代わりにアプリの画面（HTML）が返ってきても、zip に詰めずに失敗させる', async () => {
    // 静的アセットは見つからないパスに index.html を状態コード200で返す（アプリが「見つからない」画面を出すため）
    const response = await download(
      createEnv({
        ...builtExtension,
        '/tab-extension/background.js': { body: '<!doctype html><title>HDAD</title>', contentType: 'text/html; charset=utf-8' },
      }),
    )

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'tab-extension-missing' } })
  })
})
