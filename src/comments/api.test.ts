/**
 * コメントビューアーのAPIの呼び出し（api.ts）のテスト
 *
 * 実際のWorkerへは通信せず、fetch を差し替えて「どんなリクエストを送るか」と
 * 「失敗や想定外の応答をエラーとして扱うか」を確認する。
 */
import { describe, expect, it } from 'vitest'
import { createCommentApi, describeModeration, MAX_ICON_USERS, pickUnknownUserIds } from './api'
import type { FeedEntry } from './feed'

/** 送られたリクエストを記録し、決めた応答を返す fetch */
const 応答を返すfetch = (status: number, body: unknown) => {
  const 送ったURL: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    送ったURL.push(String(input))
    return Response.json(body, { status })
  }
  return { fetchImpl, 送ったURL }
}

describe('loadIcons', () => {
  it('ユーザーIDをまとめて問い合わせ、IDごとのアイコンのURLを受け取る', async () => {
    const { fetchImpl, 送ったURL } = 応答を返すfetch(200, { icons: { '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' } })

    const icons = await createCommentApi(fetchImpl).loadIcons(['777', '888'])

    expect(送ったURL).toEqual(['/api/admin/comments/icons?user_id=777&user_id=888'])
    expect(icons).toEqual({ '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(200, { icons: { '777': 42 } })

    await expect(createCommentApi(fetchImpl).loadIcons(['777'])).rejects.toThrow()
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = 応答を返すfetch(502, { error: { code: 'twitch-error', message: 'Twitchに問い合わせられませんでした' } })

    await expect(createCommentApi(fetchImpl).loadIcons(['777'])).rejects.toThrow('Twitchに問い合わせられませんでした')
  })
})

describe('pickUnknownUserIds', () => {
  /** その人の発言の行を作る */
  const 発言の行 = (userId: string): FeedEntry => ({
    item: {
      kind: 'chat',
      id: `通知-${userId}`,
      at: 0,
      messageId: `発言-${userId}`,
      user: { id: userId, login: `login_${userId}`, name: `視聴者${userId}` },
      color: null,
      badges: [],
      fragments: [],
      bits: null,
      reply: null,
    },
    removed: false,
  })

  it('まだアイコンを引いていない人のIDを、重ねずに選ぶ', () => {
    const 並び = [発言の行('777'), 発言の行('888'), 発言の行('777'), 発言の行('999')]

    expect(pickUnknownUserIds(並び, new Set(['888']))).toEqual(['777', '999'])
  })

  it('匿名のギフトなど、人のいない行は選ばない', () => {
    const 匿名のギフト: FeedEntry = {
      item: { kind: 'notice', id: '通知', at: 0, messageId: 'お知らせ', user: null, color: null, badges: [], fragments: [], notice: { type: 'communityGift', tier: '1000', count: 5 } },
      removed: false,
    }

    expect(pickUnknownUserIds([匿名のギフト], new Set())).toEqual([])
  })

  it('1度に問い合わせられる人数までに区切る', () => {
    const 並び = Array.from({ length: MAX_ICON_USERS + 1 }, (_, 番号) => 発言の行(String(番号)))

    expect(pickUnknownUserIds(並び, new Set())).toHaveLength(MAX_ICON_USERS)
  })
})

describe('moderate', () => {
  /** 送られたリクエストを記録し、決めた応答を返す fetch（本文とメソッドも残す） */
  const 処分に応えるfetch = (status: number, body: unknown) => {
    const 送ったもの: { url: string; method: string | undefined; body: unknown }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      送ったもの.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) })
      return Response.json(body, { status })
    }
    return { fetchImpl, 送ったもの }
  }

  it('選んだ処分と、対象の発言・人をWorkerへ送る', async () => {
    const { fetchImpl, 送ったもの } = 処分に応えるfetch(200, { action: 'timeout', durationSeconds: 600 })

    const result = await createCommentApi(fetchImpl).moderate('timeout', { messageId: '荒らしの発言', userId: '11111' })

    expect(送ったもの).toEqual([{ url: '/api/admin/comments/moderation', method: 'POST', body: { action: 'timeout', messageId: '荒らしの発言', userId: '11111' } }])
    expect(result).toEqual({ action: 'timeout', durationSeconds: 600 })
  })

  it('Workerが失敗を返したら、理由を添えたエラーにする（botがモデレーターでないなど）', async () => {
    const { fetchImpl } = 処分に応えるfetch(502, { error: { code: 'twitch-error', message: 'botがこのチャンネルのモデレーターではありません' } })

    await expect(createCommentApi(fetchImpl).moderate('ban', { messageId: '荒らしの発言', userId: '11111' })).rejects.toThrow('botがこのチャンネルのモデレーターではありません')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = 処分に応えるfetch(200, { action: 'timeout' })

    await expect(createCommentApi(fetchImpl).moderate('timeout', { messageId: '荒らしの発言', userId: '11111' })).rejects.toThrow()
  })
})

describe('describeModeration', () => {
  it.each([
    [{ action: 'delete' as const }, '荒らしさん さんの発言を削除しました'],
    [{ action: 'timeout' as const, durationSeconds: 600 }, '荒らしさん さんを10分タイムアウトしました'],
    [{ action: 'timeout' as const, durationSeconds: 90 }, '荒らしさん さんを90秒タイムアウトしました'],
    [{ action: 'ban' as const }, '荒らしさん さんをBANしました'],
  ])('%o を、行ったことを伝える文にする', (result, 文) => {
    expect(describeModeration(result, '荒らしさん')).toBe(文)
  })
})

describe('send', () => {
  it('送る文言をWorkerへ渡す（配信者本人として送られる）', async () => {
    const 送ったもの: { url: string; method: string | undefined; body: unknown }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      送ったもの.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 204 })
    }

    await createCommentApi(fetchImpl).send('みなさん来てくれてありがとう')

    expect(送ったもの).toEqual([{ url: '/api/admin/comments/messages', method: 'POST', body: { message: 'みなさん来てくれてありがとう' } }])
  })

  it('Workerが断ったら、理由を添えたエラーにする（許可を取り直していないなど）', async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ error: { code: 'missing-scope', message: '配信者のトークンに user:write:chat がありません。ログインし直してください' } }, { status: 401 })

    await expect(createCommentApi(fetchImpl).send('こんにちは')).rejects.toThrow('ログインし直してください')
  })
})
