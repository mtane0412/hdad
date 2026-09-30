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
const createFetchWithResponse = (status: number, body: unknown) => {
  const sentUrls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    sentUrls.push(String(input))
    return Response.json(body, { status })
  }
  return { fetchImpl, sentUrls }
}

describe('loadIcons', () => {
  it('ユーザーIDをまとめて問い合わせ、IDごとのアイコンのURLを受け取る', async () => {
    const { fetchImpl, sentUrls } = createFetchWithResponse(200, { icons: { '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' } })

    const icons = await createCommentApi(fetchImpl).loadIcons(['777', '888'])

    expect(sentUrls).toEqual(['/api/admin/comments/icons?user_id=777&user_id=888'])
    expect(icons).toEqual({ '777': 'https://static-cdn.jtvnw.net/jtv_user_pictures/jouren.png' })
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { icons: { '777': 42 } })

    await expect(createCommentApi(fetchImpl).loadIcons(['777'])).rejects.toThrow()
  })

  it('Workerが失敗を返したらエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(502, { error: { code: 'twitch-error', message: 'Twitchに問い合わせられませんでした' } })

    await expect(createCommentApi(fetchImpl).loadIcons(['777'])).rejects.toThrow('Twitchに問い合わせられませんでした')
  })
})

describe('pickUnknownUserIds', () => {
  /** その人の発言の行を作る */
  const createChatRow = (userId: string): FeedEntry => ({
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
    read: null,
  })

  it('まだアイコンを引いていない人のIDを、重ねずに選ぶ', () => {
    const entries = [createChatRow('777'), createChatRow('888'), createChatRow('777'), createChatRow('999')]

    expect(pickUnknownUserIds(entries, new Set(['888']))).toEqual(['777', '999'])
  })

  it('匿名のギフトなど、人のいない行は選ばない', () => {
    const anonymousGift: FeedEntry = {
      item: { kind: 'notice', id: '通知', at: 0, messageId: 'お知らせ', user: null, color: null, badges: [], fragments: [], notice: { type: 'communityGift', tier: '1000', count: 5 } },
      removed: false,
      read: null,
    }

    expect(pickUnknownUserIds([anonymousGift], new Set())).toEqual([])
  })

  it('1度に問い合わせられる人数までに区切る', () => {
    const entries = Array.from({ length: MAX_ICON_USERS + 1 }, (_, index) => createChatRow(String(index)))

    expect(pickUnknownUserIds(entries, new Set())).toHaveLength(MAX_ICON_USERS)
  })
})

describe('moderate', () => {
  /** 送られたリクエストを記録し、決めた応答を返す fetch（本文とメソッドも残す） */
  const createModerationFetch = (status: number, body: unknown) => {
    const sentRequests: { url: string; method: string | undefined; body: unknown }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      sentRequests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) })
      return Response.json(body, { status })
    }
    return { fetchImpl, sentRequests }
  }

  it('選んだ処分と、対象の発言・人をWorkerへ送る', async () => {
    const { fetchImpl, sentRequests } = createModerationFetch(200, { action: 'timeout', durationSeconds: 600 })

    const result = await createCommentApi(fetchImpl).moderate('timeout', { messageId: '荒らしの発言', userId: '11111' })

    expect(sentRequests).toEqual([{ url: '/api/admin/comments/moderation', method: 'POST', body: { action: 'timeout', messageId: '荒らしの発言', userId: '11111' } }])
    expect(result).toEqual({ action: 'timeout', durationSeconds: 600 })
  })

  it('Workerが失敗を返したら、理由を添えたエラーにする（botがモデレーターでないなど）', async () => {
    const { fetchImpl } = createModerationFetch(502, { error: { code: 'twitch-error', message: 'botがこのチャンネルのモデレーターではありません' } })

    await expect(createCommentApi(fetchImpl).moderate('ban', { messageId: '荒らしの発言', userId: '11111' })).rejects.toThrow('botがこのチャンネルのモデレーターではありません')
  })

  it('応答が想定した形でなければエラーにする', async () => {
    const { fetchImpl } = createModerationFetch(200, { action: 'timeout' })

    await expect(createCommentApi(fetchImpl).moderate('timeout', { messageId: '荒らしの発言', userId: '11111' })).rejects.toThrow()
  })
})

describe('describeModeration', () => {
  it.each([
    [{ action: 'delete' as const }, '荒らしさん さんの発言を削除しました'],
    [{ action: 'timeout' as const, durationSeconds: 600 }, '荒らしさん さんを10分タイムアウトしました'],
    [{ action: 'timeout' as const, durationSeconds: 90 }, '荒らしさん さんを90秒タイムアウトしました'],
    [{ action: 'ban' as const }, '荒らしさん さんをBANしました'],
  ])('%o を、行ったことを伝える文にする', (result, sentence) => {
    expect(describeModeration(result, '荒らしさん')).toBe(sentence)
  })
})

describe('send', () => {
  it('送る文言をWorkerへ渡す（配信者本人として送られる）', async () => {
    const sentRequests: { url: string; method: string | undefined; body: unknown }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      sentRequests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) })
      return new Response(null, { status: 204 })
    }

    await createCommentApi(fetchImpl).send('みなさん来てくれてありがとう')

    expect(sentRequests).toEqual([{ url: '/api/admin/comments/messages', method: 'POST', body: { message: 'みなさん来てくれてありがとう' } }])
  })

  it('Workerが断ったら、理由を添えたエラーにする（許可を取り直していないなど）', async () => {
    const fetchImpl: typeof fetch = async () =>
      Response.json({ error: { code: 'missing-scope', message: '配信者のトークンに user:write:chat がありません。ログインし直してください' } }, { status: 401 })

    await expect(createCommentApi(fetchImpl).send('こんにちは')).rejects.toThrow('ログインし直してください')
  })
})

/** 送られたリクエスト（URL・メソッド・本文）を記録し、決めた応答を返す fetch */
const createRecordingFetch = (respond: () => Response) => {
  const sentRequests: { url: string; method: string | undefined; body: unknown }[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    sentRequests.push({ url: String(input), method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    return respond()
  }
  return { fetchImpl, sentRequests }
}

describe('markRead', () => {
  it('既読にする発言と、既読にするか未読に戻すかをWorkerへ送る', async () => {
    const { fetchImpl, sentRequests } = createRecordingFetch(() => new Response(null, { status: 204 }))

    await createCommentApi(fetchImpl).markRead('たなかさんの初見の挨拶', true)
    await createCommentApi(fetchImpl).markRead('たなかさんの初見の挨拶', false)

    expect(sentRequests).toEqual([
      { url: '/api/admin/comments/reads', method: 'POST', body: { messageId: 'たなかさんの初見の挨拶', read: true } },
      { url: '/api/admin/comments/reads', method: 'POST', body: { messageId: 'たなかさんの初見の挨拶', read: false } },
    ])
  })

  it('Workerが失敗を返したら、理由を添えたエラーにする', async () => {
    const { fetchImpl } = createRecordingFetch(() => Response.json({ error: { code: 'internal', message: 'コメントビューアーの1件を配送先へ送れませんでした' } }, { status: 500 }))

    await expect(createCommentApi(fetchImpl).markRead('たなかさんの初見の挨拶', true)).rejects.toThrow('配送先へ送れませんでした')
  })
})

describe('loadSettings・saveSettings', () => {
  it('設定を読む', async () => {
    const { fetchImpl, sentRequests } = createRecordingFetch(() => Response.json({ highlightUnread: true, judgeWithJev: false }))

    expect(await createCommentApi(fetchImpl).loadSettings()).toEqual({ highlightUnread: true, judgeWithJev: false })
    expect(sentRequests).toEqual([{ url: '/api/admin/comments/settings', method: undefined, body: undefined }])
  })

  it('設定を保存し、Workerが保存した設定を返す', async () => {
    const { fetchImpl, sentRequests } = createRecordingFetch(() => Response.json({ highlightUnread: false, judgeWithJev: true }))

    expect(await createCommentApi(fetchImpl).saveSettings({ highlightUnread: false, judgeWithJev: true })).toEqual({ highlightUnread: false, judgeWithJev: true })
    expect(sentRequests).toEqual([{ url: '/api/admin/comments/settings', method: 'PUT', body: { highlightUnread: false, judgeWithJev: true } }])
  })

  it('応答が想定した形でなければエラーにする', async () => {
    // 自動の既読の項目が欠けている（Workerとの食い違い）
    const { fetchImpl } = createRecordingFetch(() => Response.json({ highlightUnread: true }))

    await expect(createCommentApi(fetchImpl).loadSettings()).rejects.toThrow()
  })
})
