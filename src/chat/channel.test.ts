/**
 * 接続先チャンネルの取得（channel.ts）のテスト
 *
 * チャットボックスのURLにはチャンネル名を書かないため、接続先はWorkerから受け取る。
 * 実際の通信はせず、fetch を差し替える。
 */
import { describe, expect, it } from 'vitest'
import { loadChannel } from './channel'

/** 決めた応答を返す fetch。呼ばれたパスも記録する */
const 応答を返すfetch = (status: number, body: unknown) => {
  const paths: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    paths.push(String(input))
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { paths, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('loadChannel', () => {
  it('Workerから接続先のチャンネル名を受け取る（チャンネル名は小文字にそろえる）', async () => {
    const { paths, fetchImpl } = 応答を返すfetch(200, { login: 'Tanenob_CH' })
    const channel = await loadChannel(fetchImpl)

    expect(paths).toEqual(['/api/chat/channel'])
    // IRCのチャンネル名は小文字で指定する必要がある
    expect(channel).toEqual({ login: 'tanenob_ch' })
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(502, { error: { code: 'twitch-error', message: 'Twitchが応答しません' } })
    await expect(loadChannel(fetchImpl)).rejects.toThrow('Twitchが応答しません')
  })

  it('応答が想定した形でなければエラーにする（空のチャンネル名でIRCに接続しにいかない）', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { login: '' })
    await expect(loadChannel(fetchImpl)).rejects.toThrow('Workerの応答に login がありません')
  })
})
