/**
 * チャットボットの管理用APIの呼び出し（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どの経路をどのメソッドで呼ぶか」と
 * 「失敗や想定外の応答をエラーとして扱うか（黙って未接続扱いにしないか）」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/core/api'
import { createBotApi } from './api'

const サイト = 'https://stream-assets.example.com'

const 接続済みのbot = { userId: '67890', login: 'haishinsha_bot', missingScopes: [] }

/** 送られたリクエストを記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const requests: Request[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Request(new URL(String(input), サイト), init))
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status })
  }
  return { requests, fetchImpl }
}

describe('status（接続状態の取得）', () => {
  it('接続済みなら、botのログイン名とユーザーIDを返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { bot: 接続済みのbot })

    expect(await createBotApi(fetchImpl).status()).toEqual(接続済みのbot)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/bot')
  })

  it('未接続なら null を返す', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { bot: null })
    expect(await createBotApi(fetchImpl).status()).toBeNull()
  })

  it('不足しているスコープをそのまま受け取れる', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { bot: { ...接続済みのbot, missingScopes: ['user:write:chat'] } })
    expect(await createBotApi(fetchImpl).status()).toMatchObject({ missingScopes: ['user:write:chat'] })
  })

  it('応答が想定した形でなければエラーにする（黙って未接続扱いにしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { bot: { login: 'haishinsha_bot' } })
    await expect(createBotApi(fetchImpl).status()).rejects.toThrow('/api/admin/bot')
  })

  it('Workerが失敗を返したら、そのメッセージを持つエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(401, { error: { code: 'unauthorized', message: 'ログインが必要です' } })
    await expect(createBotApi(fetchImpl).status()).rejects.toThrow('ログインが必要です')
  })
})

describe('disconnect（切断）', () => {
  it('DELETE で切断の経路を呼ぶ', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(204, null)

    await createBotApi(fetchImpl).disconnect()

    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/bot')
    expect(requests[0]!.method).toBe('DELETE')
  })
})

describe('sendMessage（チャットの送信）', () => {
  it('本文をJSONにして送る', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(204, null)

    await createBotApi(fetchImpl).sendMessage('こんばんは、配信が始まりました')

    const request = requests[0]!
    expect(new URL(request.url).pathname).toBe('/api/admin/bot/messages')
    expect(request.method).toBe('POST')
    expect(await request.json()).toEqual({ message: 'こんばんは、配信が始まりました' })
  })

  it('Twitchが送信しなかった場合は、その理由を持つエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(502, {
      error: { code: 'twitch-error', message: 'Twitchがチャットを送信しませんでした: メッセージがAutoModに保留されました' },
    })

    await expect(createBotApi(fetchImpl).sendMessage('あやしい文言')).rejects.toThrow('AutoMod')
  })
})

describe('startDeviceCode（別の端末での接続を始める）', () => {
  const 発行された内容 = {
    deviceCode: 'device-code-0123456789',
    userCode: 'ABCDEFGH',
    verificationUri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH',
    expiresIn: 1800,
    intervalSeconds: 5,
  }

  it('コードの発行を求め、利用者に見せる内容を返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, 発行された内容)

    expect(await createBotApi(fetchImpl).startDeviceCode()).toEqual(発行された内容)
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/bot/device-code')
    expect(requests[0]!.method).toBe('POST')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { userCode: 'ABCDEFGH' })
    await expect(createBotApi(fetchImpl).startDeviceCode()).rejects.toThrow('/api/admin/bot/device-code')
  })
})

describe('pollDeviceCode（認可されるまで待つ）', () => {
  it('まだ認可されていなければ、待っている状態を返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { status: 'pending' })

    expect(await createBotApi(fetchImpl).pollDeviceCode('device-code-0123456789')).toEqual({ status: 'pending' })
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/bot/device-token')
    expect(await requests[0]!.json()).toEqual({ deviceCode: 'device-code-0123456789' })
  })

  it('問い合わせが速すぎると言われたら、pending と区別して返す', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { status: 'slow-down' })

    expect(await createBotApi(fetchImpl).pollDeviceCode('device-code-0123456789')).toEqual({ status: 'slow-down' })
  })

  it('認可が済んでいれば、接続したbotを返す', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { status: 'connected', bot: 接続済みのbot })

    expect(await createBotApi(fetchImpl).pollDeviceCode('device-code-0123456789')).toEqual({ status: 'connected', bot: 接続済みのbot })
  })

  it('応答が想定した形でなければエラーにする（黙って待ち続けない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { status: 'connected' })
    await expect(createBotApi(fetchImpl).pollDeviceCode('device-code-0123456789')).rejects.toThrow('/api/admin/bot/device-token')
  })

  it('コードの期限が切れていたら、そのメッセージを持つエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(502, { error: { code: 'twitch-error', message: 'Twitchが 400 を返しました: expired_token' } })
    await expect(createBotApi(fetchImpl).pollDeviceCode('期限切れのコード')).rejects.toThrow('expired_token')
  })
})

describe('commands（コマンドの取得と保存）', () => {
  const 挨拶のコマンド = { name: 'aisatsu', reply: '@{user} こんばんは', cooldownSeconds: 10 }

  it('保存済みのコマンドの一覧を返す', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { commands: [挨拶のコマンド] })

    expect(await createBotApi(fetchImpl).commands()).toEqual([挨拶のコマンド])
    expect(new URL(requests[0]!.url).pathname).toBe('/api/admin/bot/commands')
  })

  it('まだ1つも登録していなければ、空の一覧を返す', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { commands: [] })
    expect(await createBotApi(fetchImpl).commands()).toEqual([])
  })

  it('応答が想定した形でなければエラーにする（黙って空の一覧にしない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { commands: [{ name: 'aisatsu' }] })
    await expect(createBotApi(fetchImpl).commands()).rejects.toThrow('commands[0]')
  })

  it('一覧をまるごと置き換えて保存する', async () => {
    const { requests, fetchImpl } = 応答を返すfetch(200, { commands: [挨拶のコマンド] })

    expect(await createBotApi(fetchImpl).saveCommands([挨拶のコマンド])).toEqual([挨拶のコマンド])
    const request = requests[0]!
    expect(request.method).toBe('PUT')
    expect(await request.json()).toEqual({ commands: [挨拶のコマンド] })
  })

  it('内容に問題があれば、問題点を持つエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(400, {
      error: { code: 'invalid-config', message: 'コマンドの設定に問題があります', problems: ['commands[0].name: 空白と ! を含まない50文字以内の文字列で指定してください'] },
    })

    const error = await createBotApi(fetchImpl).saveCommands([{ name: '', reply: 'こんばんは', cooldownSeconds: 0 }]).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).problems).toHaveLength(1)
  })
})
