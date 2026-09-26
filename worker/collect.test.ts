/**
 * cron による配信の記録の収集（collect.ts）のテスト
 *
 * Twitchのクライアント・KV・D1を差し替え、「配信中か」「トークンが使えるか」に応じて何が記録されるかを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { TextGenerator } from './llm'
import { MAX_VIEWER_SUMMARY_LENGTH } from './viewer-summary'
import { STREAM_CHAT_RETENTION_MS, SUMMARY_BATCH_SIZE, collectStats } from './collect'
import { readStreamSummary } from './stream-summary-store'
import { readSideSuper } from './side-super-store'
import { MAX_SIDE_SUPER_BODY_LENGTH } from './side-super'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { getSession, listFailures, listFollowerSamples, listSessions } from './stats-store'
import { AuthError, loadToken, saveToken, type StoredToken } from './token'
import { deleteViewer, readViewer, recordViewerMessage } from './viewer-store'
import { TwitchApiError, type LiveStream, type TwitchClient } from './twitch'

const 現在時刻 = Date.parse('2026-09-21T12:05:00Z')
const 配信者のID = '12345'

const 雑談配信: LiveStream = {
  id: '40000000001',
  startedAt: '2026-09-21T12:00:00.000Z',
  title: '月曜の雑談配信',
  categoryName: 'Just Chatting',
  viewerCount: 42,
}

const 保管中のトークン: StoredToken = {
  accessToken: '保管中のアクセストークン',
  refreshToken: '保管中のリフレッシュトークン',
  expiresAt: 現在時刻 + 60 * 60 * 1000,
  scopes: ['moderator:read:followers'],
  userId: 配信者のID,
  login: 'haishinsha',
}

/** 決まった人物像を返すLLMの代役。呼ばれた回数を控えて、無駄に呼んでいないかを確かめられるようにする */
/**
 * 1回の収集で作られるものすべてが成功する応答。
 *
 * サイドスーパーはちょうど2行でなければ保存されない（worker/side-super.ts の SIDE_SUPER_LINES）。
 * 「前回作ったあとに新しい材料が無ければ作り直さない」ことを確かめるテストでは、1回目の収集で
 * サイドスーパーまで保存されている必要があるため、既定の1行の応答ではなく2行のこれを使う。
 */
const 全部が成功する応答 = '初見プレイ中\nボス戦へ向けて装備集め'

const AIの代役 = (response: string | Error = 'ギターの話をよくする常連さん'): TextGenerator & { 呼ばれた数: () => number } => {
  let 回数 = 0
  return {
    呼ばれた数: () => 回数,
    run: async () => {
      回数 += 1
      if (response instanceof Error) throw response
      return response
    },
  }
}

type 収集用のTwitch = Pick<TwitchClient, 'refresh' | 'getLiveStream' | 'getFollowerTotal'>

const Twitchの代役 = (overrides: Partial<収集用のTwitch> = {}): 収集用のTwitch => ({
  refresh: async () => {
    throw new Error('テストで想定していないトークンの更新です')
  },
  getLiveStream: async () => 雑談配信,
  getFollowerTotal: async () => 1234,
  ...overrides,
})

const 環境を作る = async (token: StoredToken | null = 保管中のトークン) => {
  const db = createFakeDatabase()
  const store = createFakeStore()
  if (token) await saveToken(store, 'broadcaster', token)
  return { db, store }
}

describe('collectStats', () => {
  it('配信中なら、セッション・視聴者数・フォロワー数を記録する', async () => {
    const { db, store } = await 環境を作る()
    const 受け取った引数: string[][] = []
    const twitch = Twitchの代役({
      getLiveStream: async (accessToken, broadcasterId) => {
        受け取った引数.push([accessToken, broadcasterId])
        return 雑談配信
      },
    })

    await collectStats({ db, store, twitch, ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })

    expect(受け取った引数).toEqual([['保管中のアクセストークン', '12345']])
    expect((await getSession(db, 雑談配信.id))?.samples).toEqual([{ sampledAt: '2026-09-21T12:05:00.000Z', viewerCount: 42 }])
    expect(await listFollowerSamples(db)).toEqual([{ sampledAt: '2026-09-21T12:05:00.000Z', followerTotal: 1234 }])
    expect(await listFailures(db)).toEqual([])
  })

  it('配信していなければ、開いているセッションを閉じ、フォロワー数だけを記録する', async () => {
    const { db, store } = await 環境を作る()
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })

    const 五分後 = 現在時刻 + 5 * 60 * 1000
    await collectStats({ db, store, twitch: Twitchの代役({ getLiveStream: async () => null }), ai: AIの代役(), broadcasterId: 配信者のID, now: 五分後 })

    const session = await getSession(db, 雑談配信.id)
    expect(session?.endedAt).toBe('2026-09-21T12:10:00.000Z')
    expect(session?.samples).toHaveLength(1)
  })

  it('期限内のトークンをTwitchが拒んだら、1回だけ取り直してやり直す', async () => {
    const { db, store } = await 環境を作る()
    const 使われたトークン: string[] = []
    const twitch = Twitchの代役({
      refresh: async () => ({ accessToken: '取り直したアクセストークン', refreshToken: '新しいリフレッシュトークン', expiresIn: 14400 }),
      getLiveStream: async (accessToken) => {
        使われたトークン.push(accessToken)
        if (accessToken === '保管中のアクセストークン') throw new TwitchApiError(401, 'Twitchが 401 を返しました: Invalid OAuth token')
        return 雑談配信
      },
    })

    await collectStats({ db, store, twitch, ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })

    expect(使われたトークン).toEqual(['保管中のアクセストークン', '取り直したアクセストークン'])
    expect((await loadToken(store, 'broadcaster'))?.accessToken).toBe('取り直したアクセストークン')
    expect(await listSessions(db, 現在時刻)).toHaveLength(1)
  })

  it('トークンが保管されていなければ、黙って飛ばさず、失敗を記録してエラーにする', async () => {
    const { db, store } = await 環境を作る(null)

    await expect(collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })).rejects.toBeInstanceOf(AuthError)

    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'not-logged-in', message: expect.stringContaining('ログイン') },
    ])
  })

  it('トークンを更新できなければ、再ログインが必要な失敗として記録する', async () => {
    const { db, store } = await 環境を作る({ ...保管中のトークン, expiresAt: 現在時刻 - 1 })
    const twitch = Twitchの代役({
      refresh: async () => {
        throw new TwitchApiError(400, 'Twitchが 400 を返しました: Invalid refresh token')
      },
    })

    await expect(collectStats({ db, store, twitch, ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })).rejects.toBeInstanceOf(AuthError)

    expect((await listFailures(db))[0]?.code).toBe('relogin-required')
  })

  it('フォロワー数の取得に失敗しても、先に取れた配信の記録は残し、失敗を記録する', async () => {
    const { db, store } = await 環境を作る()
    const twitch = Twitchの代役({
      getFollowerTotal: async () => {
        throw new TwitchApiError(500, 'Twitchが 500 を返しました: Internal Server Error')
      },
    })

    await expect(collectStats({ db, store, twitch, ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })).rejects.toBeInstanceOf(TwitchApiError)

    expect(await listSessions(db, 現在時刻)).toHaveLength(1)
    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'twitch-error', message: 'Twitchが 500 を返しました: Internal Server Error' },
    ])
  })
})

describe('古い記録の掃除', () => {
  it('保持期間より古い「その配信で初めての発言」の記録を消す（配信を重ねても行が積み上がらないようにするため）', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保管中のトークン)
    const 三十日 = 30 * 24 * 60 * 60 * 1000
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('mukashi-no-haishin', new Date(現在時刻 - 三十日).toISOString(), new Date(現在時刻 - 三十日).toISOString(), '昔の配信', 'Just Chatting')
    const 記録を足す = (chatterUserId: string, at: number): void => {
      db.sqlite
        .prepare('INSERT INTO first_chatters (session_id, chatter_user_id, message_id, first_chatted_at) VALUES (?, ?, ?, ?)')
        .run('mukashi-no-haishin', chatterUserId, `hatsugen-${chatterUserId}`, new Date(at).toISOString())
    }
    記録を足す('mukashi-no-hito', 現在時刻 - 三十日)
    記録を足す('kyou-no-hito', 現在時刻)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })

    expect(db.sqlite.prepare('SELECT chatter_user_id FROM first_chatters').all()).toEqual([{ chatter_user_id: 'kyou-no-hito' }])
  })

  it('保持期間より古い文字起こしを消す（配信中だけ持つものなので、終わった配信のぶんを残さない）', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保管中のトークン)
    const 三十日 = 30 * 24 * 60 * 60 * 1000
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('mukashi-no-haishin', new Date(現在時刻 - 三十日).toISOString(), new Date(現在時刻 - 三十日).toISOString(), '昔の配信', 'Just Chatting')
    const 発話を足す = (messageId: string, at: number): void => {
      db.sqlite
        .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
        .run(messageId, 'mukashi-no-haishin', new Date(at).toISOString(), '昔しゃべった内容')
    }
    発話を足す('mukashi-no-hatsuwa', 現在時刻 - 三十日)
    発話を足す('kyou-no-hatsuwa', 現在時刻)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })

    expect(db.sqlite.prepare('SELECT message_id FROM transcripts').all()).toEqual([{ message_id: 'kyou-no-hatsuwa' }])
  })
})

describe('人物像の生成', () => {
  /** 終わった配信と、その配信での発言の記録を1人分そろえる */
  const 終わった配信と発言を作る = async (db: ReturnType<typeof createFakeDatabase>, userId = '100') => {
    await recordViewerMessage(db, { userId, login: 'hanako', displayName: '花子', badges: [], messageId: `chat-${userId}` }, 現在時刻 - 10 * 60 * 1000)
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('owatta-haishin', new Date(現在時刻 - 60 * 60 * 1000).toISOString(), new Date(現在時刻 - 30 * 60 * 1000).toISOString(), '昨日の配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run(`hatsugen-${userId}`, 'owatta-haishin', userId, new Date(現在時刻 - 45 * 60 * 1000).toISOString(), 'そのギターいいですね')
  }

  it('終わった配信の発言から人物像を作り、使い終えた材料を消す', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })

    expect(await readViewer(db, '100')).toMatchObject({ summary: 'ギターの話をよくする常連さん', summarizedAt: '2026-09-21T12:05:00.000Z' })
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })

  it('配信中の発言では人物像を作らない（その配信の残りの発言が入らないため）', async () => {
    const { db, store } = await 環境を作る()
    await recordViewerMessage(db, { userId: '100', login: 'hanako', displayName: '花子', badges: [], messageId: 'chat-100' }, 現在時刻)
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(雑談配信.id, 雑談配信.startedAt, '月曜の雑談配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-1', 雑談配信.id, '100', new Date(現在時刻).toISOString(), 'こんばんは')
    const ai = AIの代役()

    await collectStats({ db, store, twitch: Twitchの代役(), ai, broadcasterId: 配信者のID, now: 現在時刻 })

    // LLMの呼び出しそのものは、この配信のあらすじづくり（issue #65）で起きうる。ここで確かめたいのは
    // 「配信中の発言から人物像を作らないこと」なので、人物像が空のままであることで判断する
    expect(await readViewer(db, '100')).toMatchObject({ summary: '' })
  })

  it('LLMが失敗したら、収集自体は成功させたうえで失敗を記録し、材料は消さない（次の収集でやり直せるようにするため）', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(new Error('無料枠を使い切りました')), broadcasterId: 配信者のID, now: 現在時刻 })

    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'viewer-summary-failed', message: expect.stringContaining('無料枠') },
    ])
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 1 })
    expect(await listSessions(db, 現在時刻)).toHaveLength(2)
  })

  it('記録を消された人の材料は、LLMを呼ばずに消す', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)
    await deleteViewer(db, '100')
    const ai = AIの代役()

    await collectStats({ db, store, twitch: Twitchの代役(), ai, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(ai.呼ばれた数()).toBe(0)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })

  it('その人の発言が原因の失敗（長すぎる・空）では、次の人へ進む（1人で列の先頭を塞がないため）', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db, '100')
    await recordViewerMessage(db, { userId: '200', login: 'taro', displayName: '太郎', badges: [], messageId: 'chat-200' }, 現在時刻 - 10 * 60 * 1000)
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-200', 'owatta-haishin', '200', new Date(現在時刻 - 45 * 60 * 1000).toISOString(), 'こんばんは')
    // 先頭に来るのは発言の多い人なので、その人だけ上限を超える人物像が返るようにする
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-100b', 'owatta-haishin', '100', new Date(現在時刻 - 44 * 60 * 1000).toISOString(), 'もう一言')
    let 回数 = 0
    const ai: TextGenerator = {
      run: async () => {
        回数 += 1
        return 回数 === 1 ? 'あ'.repeat(MAX_VIEWER_SUMMARY_LENGTH + 1) : '元気な人'
      },
    }

    await collectStats({ db, store, twitch: Twitchの代役(), ai, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(await readViewer(db, '200')).toMatchObject({ summary: '元気な人' })
    expect(await listFailures(db)).toMatchObject([{ code: 'viewer-summary-failed' }])
  })

  it('1回の収集で人物像を作る人数に上限を設ける（Workers AI の無料枠を一度に使い切らないため）', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)
    for (const userId of ['200', '300', '400', '500', '600', '700']) {
      await recordViewerMessage(db, { userId, login: `user${userId}`, displayName: userId, badges: [], messageId: `chat-${userId}` }, 現在時刻 - 10 * 60 * 1000)
      db.sqlite
        .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
        .run(`hatsugen-${userId}`, 'owatta-haishin', userId, new Date(現在時刻 - 45 * 60 * 1000).toISOString(), 'こんばんは')
    }
    const ai = AIの代役()

    await collectStats({ db, store, twitch: Twitchの代役(), ai, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(ai.呼ばれた数()).toBe(SUMMARY_BATCH_SIZE)
  })

  it('古い材料は、人物像を作れないまま積み上がらないように消す', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)
    db.sqlite
      .prepare('UPDATE stream_chat_messages SET sent_at = ?')
      .run(new Date(現在時刻 - STREAM_CHAT_RETENTION_MS - 1000).toISOString())

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(new Error('呼ばれないはず')), broadcasterId: 配信者のID, now: 現在時刻 })

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })
})

describe('あらすじの生成', () => {
  /** 配信中の区切りと、その配信の文字起こし・発言をそろえる */
  const 配信中の材料を作る = (db: ReturnType<typeof createFakeDatabase>) => {
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(雑談配信.id, 雑談配信.startedAt, '月曜の雑談配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-1', 雑談配信.id, new Date(現在時刻 - 2 * 60 * 1000).toISOString(), '今日は新しいゲームを遊びます')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-1', 雑談配信.id, '100', new Date(現在時刻 - 60 * 1000).toISOString(), 'たのしみ！')
  }

  it('配信中なら、文字起こしと発言からあらすじを作って貯める', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai: AIの代役('配信者は新しいゲームを始めたところです'),
      broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(await readStreamSummary(db, 雑談配信.id)).toEqual({
      summary: '配信者は新しいゲームを始めたところです',
      transcriptsUntil: { at: new Date(現在時刻 - 2 * 60 * 1000).toISOString(), messageId: 'hatsuwa-1' },
      chatUntil: { at: new Date(現在時刻 - 60 * 1000).toISOString(), messageId: 'hatsugen-1' },
      updatedAt: new Date(現在時刻).toISOString(),
    })
  })

  it('文字起こしが1件も無ければ、視聴者の発言があってもあらすじを作らない', async () => {
    const { db, store } = await 環境を作る()
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(雑談配信.id, 雑談配信.startedAt, '月曜の雑談配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-1', 雑談配信.id, '100', new Date(現在時刻 - 60 * 1000).toISOString(), 'たのしみ！')
    const ai = AIの代役(全部が成功する応答)

    await collectStats({ db, store, twitch: Twitchの代役(), ai, broadcasterId: 配信者のID, now: 現在時刻 })

    // 視聴者の書き込みだけを材料にすると、書き込みの中身が配信で起きたこととして書かれてしまう
    expect(await readStreamSummary(db, 雑談配信.id)).toBeNull()
  })

  it('配信していなければ、あらすじを作らない', async () => {
    const { db, store } = await 環境を作る()
    const ai = AIの代役()

    await collectStats({
      db,
      store,
      twitch: Twitchの代役({ getLiveStream: async () => null }),
      ai,
      broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(ai.呼ばれた数()).toBe(0)
  })

  it('前回のあらすじのあとに新しい材料が無ければ、作り直さない', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(全部が成功する応答), broadcasterId: 配信者のID, now: 現在時刻 })
    const ai = AIの代役()

    await collectStats({ db, store, twitch: Twitchの代役(), ai, broadcasterId: 配信者のID, now: 現在時刻 + 5 * 60 * 1000 })

    expect(ai.呼ばれた数()).toBe(0)
  })

  it('LLMが失敗しても収集は止めず、失敗を記録して前回のあらすじを残す', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), broadcasterId: 配信者のID, now: 現在時刻 })
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-2', 雑談配信.id, new Date(現在時刻 + 60 * 1000).toISOString(), 'ボスに負けました')

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai: AIの代役(new Error('Workers AI の無料枠を使い切りました')),
      broadcasterId: 配信者のID,
      now: 現在時刻 + 5 * 60 * 1000,
    })

    expect((await readStreamSummary(db, 雑談配信.id))?.summary).toBe('ギターの話をよくする常連さん')
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('stream-summary-failed')
    // 収集そのものは止まらないので、視聴者数は2回とも記録されている
    expect((await getSession(db, 雑談配信.id))?.samples).toHaveLength(2)
  })
})

describe('サイドスーパーの生成', () => {
  /** 配信中の区切りと、その配信の文字起こし・発言をそろえる */
  const 配信中の材料を作る = (db: ReturnType<typeof createFakeDatabase>) => {
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(雑談配信.id, 雑談配信.startedAt, 雑談配信.title, 雑談配信.categoryName)
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-1', 雑談配信.id, new Date(現在時刻 - 2 * 60 * 1000).toISOString(), '今日は新しいゲームを遊びます')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-1', 雑談配信.id, '100', new Date(現在時刻 - 60 * 1000).toISOString(), 'たのしみ！')
  }

  it('配信中なら、直近の材料からサイドスーパーを作って貯める', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai: AIの代役('新作ゲーム\n初見プレイ中'),
      broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(await readSideSuper(db, 雑談配信.id)).toEqual({
      lines: ['新作ゲーム', '初見プレイ中'],
      updatedAt: new Date(現在時刻).toISOString(),
    })
  })

  it('配信していなければ、サイドスーパーを作らない', async () => {
    const { db, store } = await 環境を作る()

    await collectStats({
      db,
      store,
      twitch: Twitchの代役({ getLiveStream: async () => null }),
      ai: AIの代役(),
      broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(await readSideSuper(db, 雑談配信.id)).toBeNull()
  })

  it('前回作ったあとに新しい材料が無ければ、作り直さない', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(全部が成功する応答), broadcasterId: 配信者のID, now: 現在時刻 })
    const ai = AIの代役()

    await collectStats({ db, store, twitch: Twitchの代役(), ai, broadcasterId: 配信者のID, now: 現在時刻 + 5 * 60 * 1000 })

    expect(ai.呼ばれた数()).toBe(0)
  })

  it('LLMが失敗しても収集は止めず、失敗を記録して前回のサイドスーパーを残す', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役('新作ゲーム\n初見プレイ中'), broadcasterId: 配信者のID, now: 現在時刻 })
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-2', 雑談配信.id, new Date(現在時刻 + 60 * 1000).toISOString(), 'ボスに負けました')

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai: AIの代役(new Error('Workers AI の無料枠を使い切りました')),
      broadcasterId: 配信者のID,
      now: 現在時刻 + 5 * 60 * 1000,
    })

    expect((await readSideSuper(db, 雑談配信.id))?.lines).toEqual(['新作ゲーム', '初見プレイ中'])
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('side-super-failed')
    expect((await getSession(db, 雑談配信.id))?.samples).toHaveLength(2)
  })

  it('上限より長い行が返ってきたら、切り詰めずに失敗として記録する', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai: AIの代役(`新作ゲーム\n${'あ'.repeat(MAX_SIDE_SUPER_BODY_LENGTH + 1)}`),
      broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(await readSideSuper(db, 雑談配信.id)).toBeNull()
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('side-super-failed')
  })
})
