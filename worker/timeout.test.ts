/**
 * 外へ出る呼び出しの時間制限（worker/timeout.ts）のテスト
 *
 * 確かめたいのは次の3点である。
 * - 相手が黙り続けても、決めた時間で待つのをやめて失敗すること（cron の1回分がそこで止まらないこと）
 * - 失敗の文面に「誰が」「何秒で」応答しなかったかが入っていること（collection_failures から原因を読めるようにするため）
 * - 相手が時間内に応えたときは、その応答・その値をそのまま返すこと
 */
import { describe, expect, it } from 'vitest'
import { TimeoutError, runWithTimeout, withTimeout } from './timeout'

/** 押し込まれた要求を覚えたうえで、いつまでも応答を返さない fetch */
const silentFetch = () => {
  const received: { url: string; signal: AbortSignal | null }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    received.push({ url: String(input), signal: init?.signal ?? null })
    return await new Promise<Response>(() => undefined)
  }) as typeof fetch
  return { fetchImpl, received }
}

describe('withTimeout', () => {
  it('相手が応答を返さないと、決めた時間で TimeoutError にする', async () => {
    const { fetchImpl } = silentFetch()
    const withDeadline = withTimeout(fetchImpl, 10, 'Twitch')

    await expect(withDeadline('https://api.twitch.tv/helix/streams')).rejects.toBeInstanceOf(TimeoutError)
  })

  it('失敗の文面に相手の名前と制限の秒数を入れる', async () => {
    const { fetchImpl } = silentFetch()
    const withDeadline = withTimeout(fetchImpl, 10, 'Gyazo')

    await expect(withDeadline('https://api.gyazo.com/api/images/abc')).rejects.toThrow(/Gyazo.*0\.01秒/)
  })

  it('相手が応答を中断できるよう、中断の合図を渡す', async () => {
    const { fetchImpl, received } = silentFetch()

    await expect(withTimeout(fetchImpl, 10, 'Twitch')('https://api.twitch.tv/helix/users')).rejects.toBeInstanceOf(TimeoutError)
    const signal = received[0]?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(true)
  })

  it('時間内に応答が返れば、その応答をそのまま返す', async () => {
    const fetchImpl = (async () => Response.json({ data: '取れました' })) as typeof fetch

    const response = await withTimeout(fetchImpl, 1000, 'Twitch')('https://api.twitch.tv/helix/streams')
    expect(await response.json()).toEqual({ data: '取れました' })
  })

  it('呼び出し側が中断の合図を渡していれば、それも効いたままにする', async () => {
    const { fetchImpl, received } = silentFetch()
    const caller = new AbortController()

    // 期限（50ミリ秒）にはまだ達していないが、呼び出し側がやめれば相手へ渡った合図も上がる
    const pending = withTimeout(fetchImpl, 50, 'Twitch')('https://api.twitch.tv/helix/streams', { signal: caller.signal })
    expect(received[0]?.signal?.aborted).toBe(false)
    caller.abort(new Error('呼び出し側がやめました'))
    expect(received[0]?.signal?.aborted).toBe(true)

    // 中断を見ない代役はここでも応答を返さないので、期限まで待って失敗する（約束を捨てたままにしない）
    await expect(pending).rejects.toBeInstanceOf(TimeoutError)
  })

  it('応答の本文が届かないまま止まったときも TimeoutError にする', async () => {
    // ヘッダーだけ返して本文を閉じない応答（相手が途中で黙ったときの形）
    const fetchImpl = (async () => new Response(new ReadableStream({ start: () => undefined }))) as typeof fetch

    await expect(withTimeout(fetchImpl, 10, 'Gyazo')('https://api.gyazo.com/api/images/abc')).rejects.toBeInstanceOf(TimeoutError)
  })

  it('本文を持てない応答（204）も、そのまま返す', async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch

    const response = await withTimeout(fetchImpl, 1000, 'Twitch')('https://api.twitch.tv/helix/moderation/bans')
    expect(response.status).toBe(204)
  })

  it('応答の状態コードとヘッダーを保ったまま返す', async () => {
    const fetchImpl = (async () => Response.json({ message: 'not found' }, { status: 404, headers: { 'X-Test': '1' } })) as typeof fetch

    const response = await withTimeout(fetchImpl, 1000, 'Gyazo')('https://api.gyazo.com/api/images/abc')
    expect(response.status).toBe(404)
    expect(response.headers.get('X-Test')).toBe('1')
    expect(await response.json()).toEqual({ message: 'not found' })
  })

  it('相手が失敗を返したときは、その失敗をそのまま投げる（時間制限で置き換えない）', async () => {
    const fetchImpl = (async () => {
      throw new Error('名前を解決できませんでした')
    }) as typeof fetch

    await expect(withTimeout(fetchImpl, 1000, 'Gyazo')('https://api.gyazo.com/api/images/abc')).rejects.toThrow('名前を解決できませんでした')
  })
})

describe('runWithTimeout', () => {
  it('終わらない呼び出しを、決めた時間で TimeoutError にする', async () => {
    await expect(runWithTimeout(() => new Promise<string>(() => undefined), 10, 'Workers AI')).rejects.toBeInstanceOf(TimeoutError)
  })

  it('失敗の文面に相手の名前を入れる', async () => {
    await expect(runWithTimeout(() => new Promise<string>(() => undefined), 10, 'Workers AI')).rejects.toThrow(/Workers AI/)
  })

  it('時間内に終われば、その値をそのまま返す', async () => {
    await expect(runWithTimeout(async () => '作れた文面', 1000, 'Workers AI')).resolves.toBe('作れた文面')
  })

  it('呼び出しが失敗したときは、その失敗をそのまま投げる', async () => {
    await expect(
      runWithTimeout(() => {
        throw new Error('無料枠を使い切りました')
      }, 1000, 'Workers AI'),
    ).rejects.toThrow('無料枠を使い切りました')
  })
})
