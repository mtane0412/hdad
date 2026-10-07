/**
 * cron による配信の記録の収集（collect.ts）のテスト
 *
 * Twitchのクライアント・Gyazo・KV・D1を差し替え、「配信中か」「トークンが使えるか」に応じて何が記録されるかを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { TextGenerator } from './llm'
import type { LlmUsage } from './llm-config'
import { MAX_VIEWER_SUMMARY_LENGTH } from './viewer-summary'
import { COLLECT_BUDGET_MS, STREAM_CHAT_RETENTION_MS, SUMMARY_BATCH_SIZE, collectStats } from './collect'
import { readStreamSummary } from './stream-summary-store'
import { listStreamChapters } from './stream-chapter-store'
import { readSideSuper } from './side-super-store'
import { MAX_SIDE_SUPER_BODY_LENGTH } from './side-super'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { createFakeTokenVault } from './fake-token-vault'
import { getSession, listFailures, listFollowerSamples, listSessions, recordStreamOnline } from './stats-store'
import { AuthError, loadToken, saveToken, type StoredToken } from './token'
import { deleteViewer, readViewer, recordViewerMessage } from './viewer-store'
import { TwitchApiError, type LiveStream, type TwitchClient } from './twitch'
import { GyazoApiError } from './gyazo'
import { recordTranscript } from './transcript-store'
import { loadBgmPlayback, saveBgmPlayback, saveBgmSettings, saveBgmTracks, type BgmTrack } from './bgm-config'
import { createFakeAlertChannel } from './fake-alert-channel'
import type { JevAnswers, JevClient, JevQuestion, JevRequest } from './jev'
import { saveStreamTitleSettings } from './stream-title-config'
import { listStreamTitleCandidates } from './stream-title-store'
import { OCR_MAX_ATTEMPTS, listPendingOcr, readRecentScreenLines, recordScreenCapture, saveScreenOcr } from './screen-store'

const now = Date.parse('2026-09-21T12:05:00Z')
const streamerId = '12345'

const chatStream: LiveStream = {
  id: '40000000001',
  startedAt: '2026-09-21T12:00:00.000Z',
  title: '月曜の雑談配信',
  categoryName: 'Just Chatting',
  viewerCount: 42,
}

const storedToken: StoredToken = {
  accessToken: '保管中のアクセストークン',
  refreshToken: '保管中のリフレッシュトークン',
  expiresAt: now + 60 * 60 * 1000,
  scopes: ['moderator:read:followers'],
  userId: streamerId,
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
const allSuccessResponse = '初見プレイ中\nボス戦へ向けて装備集め'

/**
 * 篩を通ったあとの行（screen_lines）を1行だけ直に置く。
 *
 * あらすじ・サイドスーパーの材料として渡っているかを確かめるテストが使う。撮影から篩までの道のりは
 * 「画面の文字の取り込み」「篩」のテストが通るので、ここでは通し終えた形だけを用意する。
 */
const createScreenLines = (
  db: ReturnType<typeof createFakeDatabase>,
  imageId: string,
  capturedAt: number,
  text: string,
  siftedAt = capturedAt,
): void => {
  const shotAt = new Date(capturedAt).toISOString()
  const queuedAt = new Date(siftedAt).toISOString()
  db.sqlite
    .prepare('INSERT INTO screen_captures (image_id, session_id, captured_at, ocr_text, sifted_at) VALUES (?, ?, ?, ?, ?)')
    .run(imageId, chatStream.id, shotAt, text, queuedAt)
  db.sqlite
    .prepare('INSERT INTO screen_lines (image_id, line_no, session_id, captured_at, text, sifted_at) VALUES (?, 0, ?, ?, ?, ?)')
    .run(imageId, chatStream.id, shotAt, text, queuedAt)
}

const fakeAi = (
  response: string | Error = 'ギターの話をよくする常連さん',
): TextGenerator & { callCount: () => number; receivedMaterial: (usage: LlmUsage) => string[] } => {
  let count = 0
  const record: { usage: LlmUsage; prompt: string }[] = []
  return {
    callCount: () => count,
    // 材料が漏れなくLLMへ渡っているかを、使う箇所（あらすじ・サイドスーパー）ごとに確かめられるようにする。
    // 箇条を分けずに全部の文面をまとめて見ると、片方への受け渡しが壊れても、もう片方に入っているだけで通ってしまう
    receivedMaterial: (usage) => record.filter((single) => single.usage === usage).map((single) => single.prompt),
    run: async (usage, request) => {
      count += 1
      record.push({ usage, prompt: request.messages.map((message) => message.content).join('\n') })
      if (response instanceof Error) throw response
      return response
    },
  }
}

type collectTwitch = Pick<TwitchClient, 'refresh' | 'revoke' | 'getLiveStream' | 'getFollowerTotal' | 'getChannel'>

const fakeTwitch = (overrides: Partial<collectTwitch> = {}): collectTwitch => ({
  refresh: async () => {
    throw new Error('テストで想定していないトークンの更新です')
  },
  revoke: async () => {
    throw new Error('テストで想定していないトークンの失効です')
  },
  getLiveStream: async () => chatStream,
  getFollowerTotal: async () => 1234,
  getChannel: async () => ({ categoryName: 'Cuphead', title: '初見でボスラッシュ' }),
  ...overrides,
})

/** 呼ばれたら失敗させる Jev の代役。BGMの設定は既定でオフなので、BGMの切り替えを確かめないテストでは呼ばれない */
const uncalledJev: JevClient = {
  decide: async () => {
    throw new Error('このテストでは Jev を呼ばないはずです')
  },
}

/** BGMの切り替え（issue #153）を確かめないテストで渡す依存 */
const withoutBgmJudgment = { jev: uncalledJev, alerts: createFakeAlertChannel().namespace }

const createEnv = async (token: StoredToken | null = storedToken) => {
  const db = createFakeDatabase()
  const store = createFakeStore()
  const tokens = createFakeTokenVault().namespace
  if (token) await saveToken(tokens, 'broadcaster', token)
  return { db, store, tokens }
}

describe('collectStats', () => {
  it('配信中なら、セッション・視聴者数・フォロワー数を記録する', async () => {
    const { db, store, tokens } = await createEnv()
    const receivedArgs: string[][] = []
    const twitch = fakeTwitch({
      getLiveStream: async (accessToken, broadcasterId) => {
        receivedArgs.push([accessToken, broadcasterId])
        return chatStream
      },
    })

    await collectStats({ db, store, tokens, twitch, ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(receivedArgs).toEqual([['保管中のアクセストークン', '12345']])
    expect((await getSession(db, chatStream.id, now))?.samples).toEqual([{ sampledAt: '2026-09-21T12:05:00.000Z', viewerCount: 42 }])
    expect(await listFollowerSamples(db)).toEqual([{ sampledAt: '2026-09-21T12:05:00.000Z', followerTotal: 1234 }])
    expect(await listFailures(db)).toEqual([])
  })

  it('配信していなければ、開いているセッションを閉じ、フォロワー数だけを記録する', async () => {
    const { db, store, tokens } = await createEnv()
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    const fiveMinutesLater = now + 5 * 60 * 1000
    await collectStats({ db, store, tokens, twitch: fakeTwitch({ getLiveStream: async () => null }), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now: fiveMinutesLater })

    const session = await getSession(db, chatStream.id, now)
    expect(session?.endedAt).toBe('2026-09-21T12:10:00.000Z')
    expect(session?.samples).toHaveLength(1)
  })

  it('期限内のトークンをTwitchが拒んだら、1回だけ取り直してやり直す', async () => {
    const { db, store, tokens } = await createEnv()
    const usedToken: string[] = []
    const twitch = fakeTwitch({
      refresh: async () => ({ accessToken: '取り直したアクセストークン', refreshToken: '新しいリフレッシュトークン', expiresIn: 14400 }),
      getLiveStream: async (accessToken) => {
        usedToken.push(accessToken)
        if (accessToken === '保管中のアクセストークン') throw new TwitchApiError(401, 'Twitchが 401 を返しました: Invalid OAuth token')
        return chatStream
      },
    })

    await collectStats({ db, store, tokens, twitch, ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(usedToken).toEqual(['保管中のアクセストークン', '取り直したアクセストークン'])
    expect((await loadToken(tokens, 'broadcaster'))?.accessToken).toBe('取り直したアクセストークン')
    expect(await listSessions(db, now)).toHaveLength(1)
  })

  it('トークンが保管されていなければ、黙って飛ばさず、失敗を記録してエラーにする', async () => {
    const { db, store, tokens } = await createEnv(null)

    await expect(collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })).rejects.toBeInstanceOf(AuthError)

    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'not-logged-in', message: expect.stringContaining('ログイン') },
    ])
  })

  it('トークンを更新できなければ、再ログインが必要な失敗として記録する', async () => {
    const { db, store, tokens } = await createEnv({ ...storedToken, expiresAt: now - 1 })
    const twitch = fakeTwitch({
      refresh: async () => {
        throw new TwitchApiError(400, 'Twitchが 400 を返しました: Invalid refresh token')
      },
    })

    await expect(collectStats({ db, store, tokens, twitch, ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })).rejects.toBeInstanceOf(AuthError)

    expect((await listFailures(db))[0]?.code).toBe('relogin-required')
  })

  it('フォロワー数の取得に失敗しても、先に取れた配信の記録は残し、失敗を記録する', async () => {
    const { db, store, tokens } = await createEnv()
    const twitch = fakeTwitch({
      getFollowerTotal: async () => {
        throw new TwitchApiError(500, 'Twitchが 500 を返しました: Internal Server Error')
      },
    })

    await expect(collectStats({ db, store, tokens, twitch, ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })).rejects.toBeInstanceOf(TwitchApiError)

    expect(await listSessions(db, now)).toHaveLength(1)
    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'twitch-error', message: 'Twitchが 500 を返しました: Internal Server Error' },
    ])
  })
})

describe('古い記録の掃除', () => {
  it('保持期間より古い「その配信で初めての発言」の記録を消す（配信を重ねても行が積み上がらないようにするため）', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    const tokens = createFakeTokenVault().namespace
    await saveToken(tokens, 'broadcaster', storedToken)
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('mukashi-no-haishin', new Date(now - thirtyDays).toISOString(), new Date(now - thirtyDays).toISOString(), '昔の配信', 'Just Chatting')
    const addRecord = (chatterUserId: string, at: number): void => {
      db.sqlite
        .prepare('INSERT INTO first_chatters (session_id, chatter_user_id, message_id, first_chatted_at) VALUES (?, ?, ?, ?)')
        .run('mukashi-no-haishin', chatterUserId, `hatsugen-${chatterUserId}`, new Date(at).toISOString())
    }
    addRecord('mukashi-no-hito', now - thirtyDays)
    addRecord('kyou-no-hito', now)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(db.sqlite.prepare('SELECT chatter_user_id FROM first_chatters').all()).toEqual([{ chatter_user_id: 'kyou-no-hito' }])
  })

  it('保持期間より古い文字起こしを消す（配信中だけ持つものなので、終わった配信のぶんを残さない）', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    const tokens = createFakeTokenVault().namespace
    await saveToken(tokens, 'broadcaster', storedToken)
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('mukashi-no-haishin', new Date(now - thirtyDays).toISOString(), new Date(now - thirtyDays).toISOString(), '昔の配信', 'Just Chatting')
    const addSpeech = (messageId: string, at: number): void => {
      db.sqlite
        .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
        .run(messageId, 'mukashi-no-haishin', new Date(at).toISOString(), '昔しゃべった内容')
    }
    addSpeech('mukashi-no-hatsuwa', now - thirtyDays)
    addSpeech('kyou-no-hatsuwa', now)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(db.sqlite.prepare('SELECT message_id FROM transcripts').all()).toEqual([{ message_id: 'kyou-no-hatsuwa' }])
  })

  it('保持期間より古い画面の取り込みの記録を消す（文字起こしと同じく、配信中だけ持つものであるため）', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    const tokens = createFakeTokenVault().namespace
    await saveToken(tokens, 'broadcaster', storedToken)
    const thirtyDays = 30 * 24 * 60 * 60 * 1000
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('mukashi-no-haishin', new Date(now - thirtyDays).toISOString(), new Date(now - thirtyDays).toISOString(), '昔の配信', 'Just Chatting')
    const addImport = (imageId: string, at: number): void => {
      db.sqlite
        .prepare('INSERT INTO screen_captures (image_id, session_id, captured_at) VALUES (?, ?, ?)')
        .run(imageId, 'mukashi-no-haishin', new Date(at).toISOString())
    }
    addImport('mukashi-no-gamen', now - thirtyDays)
    addImport('kyou-no-gamen', now)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(db.sqlite.prepare('SELECT image_id FROM screen_captures').all()).toEqual([{ image_id: 'kyou-no-gamen' }])
  })
})

describe('人物像の生成', () => {
  /** 終わった配信と、その配信での発言の記録を1人分そろえる */
  const createEndedStreamWithChats = async (db: ReturnType<typeof createFakeDatabase>, userId = '100') => {
    await recordViewerMessage(db, { userId, login: 'hanako', displayName: '花子', badges: [], messageId: `chat-${userId}` }, now - 10 * 60 * 1000)
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('owatta-haishin', new Date(now - 60 * 60 * 1000).toISOString(), new Date(now - 30 * 60 * 1000).toISOString(), '昨日の配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run(`hatsugen-${userId}`, 'owatta-haishin', userId, new Date(now - 45 * 60 * 1000).toISOString(), 'そのギターいいですね')
  }

  it('終わった配信の発言から人物像を作り、使い終えた材料を消す', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(await readViewer(db, '100')).toMatchObject({ summary: 'ギターの話をよくする常連さん', summarizedAt: '2026-09-21T12:05:00.000Z' })
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })

  it('配信中の発言では人物像を作らない（その配信の残りの発言が入らないため）', async () => {
    const { db, store, tokens } = await createEnv()
    await recordViewerMessage(db, { userId: '100', login: 'hanako', displayName: '花子', badges: [], messageId: 'chat-100' }, now)
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(chatStream.id, chatStream.startedAt, '月曜の雑談配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-1', chatStream.id, '100', new Date(now).toISOString(), 'こんばんは')
    const ai = fakeAi()

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now })

    // LLMの呼び出しそのものは、この配信のあらすじづくり（issue #65）で起きうる。ここで確かめたいのは
    // 「配信中の発言から人物像を作らないこと」なので、人物像が空のままであることで判断する
    expect(await readViewer(db, '100')).toMatchObject({ summary: '' })
  })

  it('LLMが失敗したら、収集自体は成功させたうえで失敗を記録し、材料は消さない（次の収集でやり直せるようにするため）', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(new Error('無料枠を使い切りました')), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'viewer-summary-failed', message: expect.stringContaining('無料枠') },
    ])
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 1 })
    expect(await listSessions(db, now)).toHaveLength(2)
  })

  it('記録を消された人の材料は、LLMを呼ばずに消す', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db)
    await deleteViewer(db, '100')
    const ai = fakeAi()

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(ai.callCount()).toBe(0)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })

  it('人物像を作る人のチャンネルを観測して記録し、その内容を材料に渡す', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db)
    const queriedUserIds: string[] = []
    const twitch = fakeTwitch({
      getChannel: async (_accessToken, userId) => {
        queriedUserIds.push(userId)
        return { categoryName: 'Cuphead', title: '初見でボスラッシュ' }
      },
    })
    const receivedMaterial: string[] = []
    const ai: TextGenerator = {
      run: async (_usage, request) => {
        receivedMaterial.push(request.messages.map((message) => message.content).join('\n'))
        return 'ギターの話をよくする常連さん'
      },
    }

    await collectStats({ db, store, tokens, twitch, ai, ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(queriedUserIds).toEqual(['100'])
    expect(await readViewer(db, '100')).toMatchObject({
      channel: { categoryName: 'Cuphead', title: '初見でボスラッシュ', checkedAt: '2026-09-21T12:05:00.000Z' },
    })
    // 観測した内容は、その回の人物像づくりの材料にも入る（次の収集まで待たせない）
    expect(receivedMaterial.join('\n')).toContain('初見でボスラッシュ')
  })

  it('チャンネルを観測できなくても、人物像づくりは続けて失敗だけを記録する', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db)
    const twitch = fakeTwitch({
      getChannel: async () => {
        throw new TwitchApiError(502, 'TwitchにユーザーID 100 のチャンネルがありません')
      },
    })

    await collectStats({ db, store, tokens, twitch, ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(await readViewer(db, '100')).toMatchObject({ summary: 'ギターの話をよくする常連さん', channel: null })
    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'viewer-channel-failed', message: expect.stringContaining('チャンネルがありません') },
    ])
  })

  it('同じ収集で2人ぶん観測できなくても、両方の理由が残る（1行にまとめて記録するため）', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db, '100')
    await recordViewerMessage(db, { userId: '200', login: 'taro', displayName: '太郎', badges: [], messageId: 'chat-200' }, now - 10 * 60 * 1000)
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-200', 'owatta-haishin', '200', new Date(now - 45 * 60 * 1000).toISOString(), 'こんばんは')
    const twitch = fakeTwitch({
      getChannel: async (_accessToken, userId) => {
        throw new TwitchApiError(502, `TwitchにユーザーID ${userId} のチャンネルがありません`)
      },
    })

    await collectStats({ db, store, tokens, twitch, ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    // 失敗の記録は「時刻と種類」で1行なので（migrations/0012_collection_failures_key.sql）、
    // 人ごとに記録すると後の人が前の人を上書きしてしまう。1行にまとめて両方を残す
    const failed = await listFailures(db)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.message).toContain('100')
    expect(failed[0]?.message).toContain('200')
  })

  it('記録を消された人のチャンネルは問い合わせない（消えた人のためにTwitchを呼ばない）', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db)
    await deleteViewer(db, '100')
    let queryCount = 0
    const twitch = fakeTwitch({
      getChannel: async () => {
        queryCount += 1
        return { categoryName: 'Cuphead', title: '初見でボスラッシュ' }
      },
    })

    await collectStats({ db, store, tokens, twitch, ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(queryCount).toBe(0)
  })

  it('その人の発言が原因の失敗（長すぎる・空）では、次の人へ進む（1人で列の先頭を塞がないため）', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db, '100')
    await recordViewerMessage(db, { userId: '200', login: 'taro', displayName: '太郎', badges: [], messageId: 'chat-200' }, now - 10 * 60 * 1000)
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-200', 'owatta-haishin', '200', new Date(now - 45 * 60 * 1000).toISOString(), 'こんばんは')
    // 先頭に来るのは発言の多い人なので、その人だけ上限を超える人物像が返るようにする
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-100b', 'owatta-haishin', '100', new Date(now - 44 * 60 * 1000).toISOString(), 'もう一言')
    let count = 0
    const ai: TextGenerator = {
      run: async () => {
        count += 1
        return count === 1 ? 'あ'.repeat(MAX_VIEWER_SUMMARY_LENGTH + 1) : '元気な人'
      },
    }

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(await readViewer(db, '200')).toMatchObject({ summary: '元気な人' })
    expect(await listFailures(db)).toMatchObject([{ code: 'viewer-summary-failed' }])
  })

  it('1回の収集で人物像を作る人数に上限を設ける（Workers AI の無料枠を一度に使い切らないため）', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db)
    for (const userId of ['200', '300', '400', '500', '600', '700']) {
      await recordViewerMessage(db, { userId, login: `user${userId}`, displayName: userId, badges: [], messageId: `chat-${userId}` }, now - 10 * 60 * 1000)
      db.sqlite
        .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
        .run(`hatsugen-${userId}`, 'owatta-haishin', userId, new Date(now - 45 * 60 * 1000).toISOString(), 'こんばんは')
    }
    const ai = fakeAi()

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(ai.callCount()).toBe(SUMMARY_BATCH_SIZE)
  })

  it('古い材料は、人物像を作れないまま積み上がらないように消す', async () => {
    const { db, store, tokens } = await createEnv()
    await createEndedStreamWithChats(db)
    db.sqlite
      .prepare('UPDATE stream_chat_messages SET sent_at = ?')
      .run(new Date(now - STREAM_CHAT_RETENTION_MS - 1000).toISOString())

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(new Error('呼ばれないはず')), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })
})

describe('あらすじの生成', () => {
  /** 配信中の区切りと、その配信の文字起こし・発言をそろえる */
  const createLiveMaterial = (db: ReturnType<typeof createFakeDatabase>) => {
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(chatStream.id, chatStream.startedAt, '月曜の雑談配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-1', chatStream.id, new Date(now - 2 * 60 * 1000).toISOString(), '今日は新しいゲームを遊びます')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-1', chatStream.id, '100', new Date(now - 60 * 1000).toISOString(), 'たのしみ！')
  }

  it('配信中なら、文字起こしと発言からあらすじを作って貯める', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai: fakeAi('配信者は新しいゲームを始めたところです'),
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now,
    })

    expect(await readStreamSummary(db, chatStream.id)).toEqual({
      summary: '配信者は新しいゲームを始めたところです',
      transcriptsUntil: { at: new Date(now - 2 * 60 * 1000).toISOString(), messageId: 'hatsuwa-1' },
      chatUntil: { at: new Date(now - 60 * 1000).toISOString(), messageId: 'hatsugen-1' },
      screenUntil: { at: '', imageId: '', lineNo: -1 },
      updatedAt: new Date(now).toISOString(),
    })
  })

  it('画面に新しく現れた文字も材料にして、どこまで渡したかを目印に残す', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    createScreenLines(db, '1枚目', now - 90 * 1000, '岩手17歳女性殺害事件')
    const ai = fakeAi('配信者は未解決事件の資料を読んでいます')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(ai.receivedMaterial('streamSummary').some((material) => material.includes('岩手17歳女性殺害事件'))).toBe(true)
    expect((await readStreamSummary(db, chatStream.id))?.screenUntil).toEqual({
      at: new Date(now - 90 * 1000).toISOString(),
      imageId: '1枚目',
      lineNo: 0,
    })
  })

  it('画面に新しく現れた文字しか無ければ、あらすじを作らない（読み取った文字だけを地の文にしないため）', async () => {
    const { db, store, tokens } = await createEnv()
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(chatStream.id, chatStream.startedAt, '月曜の雑談配信', 'Just Chatting')
    createScreenLines(db, '1枚目', now - 90 * 1000, '岩手17歳女性殺害事件')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(allSuccessResponse), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(await readStreamSummary(db, chatStream.id)).toBeNull()
  })

  it('文字起こしが1件も無ければ、視聴者の発言があってもあらすじを作らない', async () => {
    const { db, store, tokens } = await createEnv()
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(chatStream.id, chatStream.startedAt, '月曜の雑談配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-1', chatStream.id, '100', new Date(now - 60 * 1000).toISOString(), 'たのしみ！')
    const ai = fakeAi(allSuccessResponse)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now })

    // 視聴者の書き込みだけを材料にすると、書き込みの中身が配信で起きたこととして書かれてしまう
    expect(await readStreamSummary(db, chatStream.id)).toBeNull()
  })

  it('配信していなければ、あらすじを作らない', async () => {
    const { db, store, tokens } = await createEnv()
    const ai = fakeAi()

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch({ getLiveStream: async () => null }),
      ai,
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now,
    })

    expect(ai.callCount()).toBe(0)
  })

  it('前回のあらすじのあとに新しい材料が無ければ、作り直さない', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(allSuccessResponse), ...withoutBgmJudgment, broadcasterId: streamerId, now })
    const ai = fakeAi()

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: now + 5 * 60 * 1000 })

    expect(ai.callCount()).toBe(0)
  })

  it('LLMが失敗しても収集は止めず、失敗を記録して前回のあらすじを残す', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-2', chatStream.id, new Date(now + 60 * 1000).toISOString(), 'ボスに負けました')

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai: fakeAi(new Error('Workers AI の無料枠を使い切りました')),
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now: now + 5 * 60 * 1000,
    })

    expect((await readStreamSummary(db, chatStream.id))?.summary).toBe('ギターの話をよくする常連さん')
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('stream-summary-failed')
    // 収集そのものは止まらないので、視聴者数は2回とも記録されている
    expect((await getSession(db, chatStream.id, now))?.samples).toHaveLength(2)
  })
})

describe('章立ての生成', () => {
  /** 章の応答。1行目が見出し、2行目が要約（worker/stream-chapter.ts） */
  const chapterResponse = '新しいゲームの導入\n配信者が新しいゲームを始め、視聴者が期待を寄せた。'
  /** 配信の最初の区間（12:00〜12:30）が閉じ、落ち着くまで待った時刻 */
  const afterFirstWindow = Date.parse('2026-09-21T12:31:00Z')
  const at = (time: string): string => new Date(Date.parse(`2026-09-21T${time}Z`)).toISOString()

  const createLiveSession = (db: ReturnType<typeof createFakeDatabase>) => {
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(chatStream.id, chatStream.startedAt, chatStream.title, chatStream.categoryName)
  }
  const insertTranscript = (db: ReturnType<typeof createFakeDatabase>, messageId: string, time: string, text: string) => {
    db.sqlite.prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)').run(messageId, chatStream.id, at(time), text)
  }
  const insertChat = (db: ReturnType<typeof createFakeDatabase>, messageId: string, time: string, text: string) => {
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run(messageId, chatStream.id, '100', at(time), text)
  }
  const chapteredUntil = (db: ReturnType<typeof createFakeDatabase>) =>
    (db.sqlite.prepare('SELECT chaptered_until FROM stream_sessions WHERE id = ?').get(chatStream.id) as { chaptered_until: string | null }).chaptered_until
  /** LLMに渡った章の材料（あらすじも同じ箇所を指名するので、章の指示文を含むものだけを選ぶ） */
  const chapterPrompts = (ai: ReturnType<typeof fakeAi>) => ai.receivedMaterial('streamSummary').filter((prompt) => prompt.includes('見出しと要約'))

  it('配信中に30分の区間が閉じたら、その区間の発話・発言から章を作って貯める', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    insertTranscript(db, 'hatsuwa-1', '12:10:00', 'ここから新しいゲームを始めます')
    insertChat(db, 'hatsugen-1', '12:11:00', 'たのしみ！')
    // 次の区間の発話は、この章の材料にしない
    insertTranscript(db, 'hatsuwa-2', '12:30:30', 'ステージ2に入りました')
    const ai = fakeAi(chapterResponse)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: afterFirstWindow })

    expect(await listStreamChapters(db, chatStream.id)).toEqual([
      { startedAt: at('12:00:00'), endedAt: at('12:30:00'), title: '新しいゲームの導入', summary: '配信者が新しいゲームを始め、視聴者が期待を寄せた。' },
    ])
    const [prompt] = chapterPrompts(ai)
    expect(prompt).toContain('配信者: ここから新しいゲームを始めます')
    expect(prompt).toContain('視聴者: たのしみ！')
    expect(prompt).not.toContain('ステージ2に入りました')
    expect(chapteredUntil(db)).toBe(at('12:30:00'))
  })

  it('配信中に章を作ったら、その見出しを作業ログの1行として合成ページへ押し出す', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    insertTranscript(db, 'hatsuwa-1', '12:10:00', 'ここから新しいゲームを始めます')
    const delivery = createFakeAlertChannel()

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(chapterResponse), jev: uncalledJev, alerts: delivery.namespace, broadcasterId: streamerId, now: afterFirstWindow })

    expect(delivery.pushedWorkLog).toEqual([{ id: `chapter:${at('12:00:00')}`, kind: 'chapter', at: at('12:00:00'), text: '新しいゲームの導入' }])
  })

  it('作業ログへの押し出しに失敗しても章は残し、失敗を記録する（章を作り直してLLMの枠を使わないため）', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    insertTranscript(db, 'hatsuwa-1', '12:10:00', 'ここから新しいゲームを始めます')

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai: fakeAi(chapterResponse),
      jev: uncalledJev,
      alerts: createFakeAlertChannel({ shouldFail: true }).namespace,
      broadcasterId: streamerId,
      now: afterFirstWindow,
    })

    expect(await listStreamChapters(db, chatStream.id)).toHaveLength(1)
    expect(chapteredUntil(db)).toBe(at('12:30:00'))
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('work-log-push-failed')
  })

  it('発話の無い区間は、章を作らずに飛ばす（視聴者の書き込みだけを配信の出来事として書かせないため）', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    insertChat(db, 'hatsugen-1', '12:11:00', 'たのしみ！')
    const ai = fakeAi(chapterResponse)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: afterFirstWindow })

    expect(await listStreamChapters(db, chatStream.id)).toEqual([])
    expect(chapterPrompts(ai)).toEqual([])
    expect(chapteredUntil(db)).toBe(at('12:30:00'))
  })

  it('1回の収集で作る章は1つまでにする（Workers AI の無料枠を一度に使い切らないため）', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    insertTranscript(db, 'hatsuwa-1', '12:10:00', 'ここから新しいゲームを始めます')
    insertTranscript(db, 'hatsuwa-2', '12:40:00', 'ステージ2に入りました')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(chapterResponse), ...withoutBgmJudgment, broadcasterId: streamerId, now: Date.parse('2026-09-21T13:01:00Z') })

    expect(await listStreamChapters(db, chatStream.id)).toHaveLength(1)
    expect(chapteredUntil(db)).toBe(at('12:30:00'))
  })

  it('配信が終わったら、最後の区間を配信の終わりで切って章にし、そのあとで人物像を作る（人物像を作ると発言が消えるため）', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    await recordViewerMessage(db, { userId: '100', login: 'hanako', displayName: '花子', badges: [], messageId: 'hatsugen-1' }, Date.parse(at('12:11:00')))
    insertTranscript(db, 'hatsuwa-1', '12:10:00', 'ここから新しいゲームを始めます')
    insertChat(db, 'hatsugen-1', '12:11:00', 'たのしみ！')
    const ended = Date.parse('2026-09-21T12:20:00Z')
    // 章にはあらすじと同じ箇所の設定を使い、人物像には人物像の箇所の設定を使う
    const prompts: { usage: LlmUsage; prompt: string }[] = []
    const ai: TextGenerator = {
      run: async (usage, request) => {
        prompts.push({ usage, prompt: request.messages.map((message) => message.content).join('\n') })
        return usage === 'streamSummary' ? chapterResponse : 'ゲームの話をよくする常連さん'
      },
    }

    await collectStats({ db, store, tokens, twitch: fakeTwitch({ getLiveStream: async () => null }), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: ended })

    expect(await listStreamChapters(db, chatStream.id)).toEqual([
      { startedAt: at('12:00:00'), endedAt: at('12:20:00'), title: '新しいゲームの導入', summary: '配信者が新しいゲームを始め、視聴者が期待を寄せた。' },
    ])
    const chapterIndex = prompts.findIndex(({ prompt }) => prompt.includes('見出しと要約'))
    const viewerIndex = prompts.findIndex(({ usage }) => usage === 'viewerSummary')
    expect(prompts[chapterIndex]?.prompt).toContain('視聴者: たのしみ！')
    expect(chapterIndex).toBeLessThan(viewerIndex)
    expect((await readViewer(db, '100'))?.summary).toBe('ゲームの話をよくする常連さん')
  })

  it('終わった配信の章は、作業ログへ押し出さない（合成ページに映っているのは次の配信のログのため）', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    insertTranscript(db, 'hatsuwa-1', '12:10:00', 'ここから新しいゲームを始めます')
    const delivery = createFakeAlertChannel()

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch({ getLiveStream: async () => null }),
      ai: fakeAi(chapterResponse),
      jev: uncalledJev,
      alerts: delivery.namespace,
      broadcasterId: streamerId,
      now: Date.parse('2026-09-21T12:20:00Z'),
    })

    expect(await listStreamChapters(db, chatStream.id)).toHaveLength(1)
    expect(delivery.pushedWorkLog).toEqual([])
  })

  const insertScreenLine = (db: ReturnType<typeof createFakeDatabase>, imageId: string, lineNo: number, time: string, text: string) => {
    db.sqlite
      .prepare('INSERT INTO screen_lines (image_id, line_no, session_id, captured_at, text, sifted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(imageId, lineNo, chatStream.id, at(time), text, at(time))
  }

  it('区間の始まりと同じ時刻の画面の文字が上限を超えていても詰まらず、その時刻を飛ばして次の区間の章を作る', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    // 1回の収集で通した5枚ぶんの画面の文字は同じ時刻で積まれるので、上限（100件）を超えることがある
    for (let lineNo = 0; lineNo <= 130; lineNo += 1) insertScreenLine(db, `画像${Math.floor(lineNo / 30)}`, lineNo % 30, '12:00:00', `画面の文字${lineNo}`)
    insertTranscript(db, 'hatsuwa-1', '12:10:00', 'ここから新しいゲームを始めます')
    const ai = fakeAi(chapterResponse)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: Date.parse('2026-09-21T12:32:00Z') })

    expect((await listFailures(db)).map((failure) => failure.code)).not.toContain('stream-chapter-failed')
    expect(await listStreamChapters(db, chatStream.id)).toEqual([
      { startedAt: at('12:00:00.001'), endedAt: at('12:30:00.001'), title: '新しいゲームの導入', summary: '配信者が新しいゲームを始め、視聴者が期待を寄せた。' },
    ])
    expect(chapterPrompts(ai)[0]).toContain('配信者: ここから新しいゲームを始めます')
  })

  it('区間の始まりと同じ時刻の発話が上限を超えていたら、その時刻の行を丸ごと材料にした章を作る（黙って捨てないため）', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    // 区間の始まりと同じ時刻に、件数の上限（300件）を超える発話が記録されている
    for (let index = 0; index <= 300; index += 1) insertTranscript(db, `hatsuwa-${index}`, '12:00:00', `同じ時刻の発話${index}`)
    const ai = fakeAi(chapterResponse)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: afterFirstWindow })

    expect((await listFailures(db)).map((failure) => failure.code)).not.toContain('stream-chapter-failed')
    expect((await listStreamChapters(db, chatStream.id)).map(({ startedAt, endedAt }) => ({ startedAt, endedAt }))).toEqual([
      { startedAt: at('12:00:00'), endedAt: at('12:00:00.001') },
    ])
    const [prompt] = chapterPrompts(ai)
    expect(prompt).toContain('配信者: 同じ時刻の発話0')
    expect(prompt).toContain('配信者: 同じ時刻の発話300')
    expect(chapteredUntil(db)).toBe(at('12:00:00.001'))
  })

  it('前の配信の章づくりに失敗しても、配信中の配信の章は作る（前の配信の失敗に巻き込まないため）', async () => {
    const { db, store, tokens } = await createEnv()
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('zenkai', '2026-09-21T10:00:00.000Z', '2026-09-21T10:20:00.000Z', '前回の配信', 'Just Chatting')
    db.sqlite.prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)').run('zenkai-1', 'zenkai', '2026-09-21T10:10:00.000Z', '前回の発話')
    createLiveSession(db)
    insertTranscript(db, 'hatsuwa-1', '12:10:00', 'ここから新しいゲームを始めます')
    // 前の配信の章だけ、LLMが失敗する
    const ai: TextGenerator = {
      run: async (_usage, request) => {
        const prompt = request.messages.map((message) => message.content).join('\n')
        if (prompt.includes('見出しと要約') && prompt.includes('タイトル: 前回の配信')) throw new Error('前回の配信の章を作れませんでした')
        return chapterResponse
      },
    }

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: afterFirstWindow })

    expect((await listFailures(db)).map((failure) => failure.code)).toContain('stream-chapter-failed')
    expect(await listStreamChapters(db, 'zenkai')).toEqual([])
    expect(await listStreamChapters(db, chatStream.id)).toHaveLength(1)
  })

  it('LLMが失敗したら、失敗を記録し、区間を進めずに次の収集でやり直す（その配信の人物像もまだ作らない）', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveSession(db)
    insertTranscript(db, 'hatsuwa-1', '12:10:00', 'ここから新しいゲームを始めます')
    insertChat(db, 'hatsugen-1', '12:11:00', 'たのしみ！')

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch({ getLiveStream: async () => null }),
      ai: fakeAi(new Error('Workers AI の無料枠を使い切りました')),
      ...withoutBgmJudgment,
      broadcasterId: streamerId,
      now: Date.parse('2026-09-21T12:20:00Z'),
    })

    expect((await listFailures(db)).map((failure) => failure.code)).toContain('stream-chapter-failed')
    expect(await listStreamChapters(db, chatStream.id)).toEqual([])
    expect(chapteredUntil(db)).toBeNull()
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 1 })
  })
})

describe('BGMの切り替え', () => {
  /** 雑談のときに流したい、落ち着いた曲 */
  const chatTrack: BgmTrack = {
    mediaId: 'media-zatsudan',
    title: 'ひだまりの午後',
    credit: '音楽: 甘茶の音楽工房',
    creditUrl: '',
    mood: 'ゆったりしたアコースティック',
    scene: '雑談・作業配信',
  }
  /** ゲームで盛り上がったときに流したい曲 */
  const upbeatTrack: BgmTrack = {
    mediaId: 'media-moriagari',
    title: '全力疾走',
    credit: '音楽: DOVA-SYNDROME',
    creditUrl: '',
    mood: 'テンポの速いロック',
    scene: 'ボス戦・盛り上がったとき',
  }

  /** 配信中で文字起こしがあり、雑談の曲を流していて、Jev に選ばせる設定を入れた状態を作る */
  const streamPlayingChatTrack = async () => {
    const { db, store, tokens } = await createEnv()
    await store.put('overlay-key', 'issued-overlay-key-0123456789abcdefghij')
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(chatStream.id, chatStream.startedAt, '月曜の雑談配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-1', chatStream.id, new Date(now - 2 * 60 * 1000).toISOString(), 'ボス戦だ、いくぞ！')
    await saveBgmTracks(store, [chatTrack, upbeatTrack])
    await saveBgmPlayback(store, { mediaId: chatTrack.mediaId, volume: 0.4, repeat: false, shuffle: false })
    await saveBgmSettings(store, { judgeWithJev: true })
    return { db, store, tokens }
  }

  /** 決めた曲（選択肢の名前）を選ぶ Jev の代役。渡された注文を控える */
  const trackPickingJev = (choice: string): JevClient & { order: JevRequest<Record<string, JevQuestion>>[] } => {
    const order: JevRequest<Record<string, JevQuestion>>[] = []
    return {
      order,
      decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(_usage: unknown, request: JevRequest<Qs>): Promise<JevAnswers<Qs>> => {
        order.push(request)
        return { track: { choice, confidence: 0.9 } } as JevAnswers<Qs>
      },
    }
  }

  it('あらすじを作り直したら、作ったあらすじと直近の発話を材料に Jev に曲を選ばせて切り替える', async () => {
    const { db, store, tokens } = await streamPlayingChatTrack()
    const jev = trackPickingJev('t1')
    const delivery = createFakeAlertChannel()

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi('ボス戦に挑んでいます'), jev, alerts: delivery.namespace, broadcasterId: streamerId, now })

    expect(jev.order.map((order) => order.state)).toEqual([{ summary: 'ボス戦に挑んでいます', transcript: ['ボス戦だ、いくぞ！'] }])
    expect((await loadBgmPlayback(store)).mediaId).toBe(upbeatTrack.mediaId)
    expect(delivery.pushedBgm.map((nowPlaying) => nowPlaying.track?.mediaId)).toEqual([upbeatTrack.mediaId])
  })

  it('あらすじを作り直さなかった回は Jev を呼ばない（新しい材料が無ければ呼ばない）', async () => {
    const { db, store, tokens } = await streamPlayingChatTrack()
    await saveBgmSettings(store, { judgeWithJev: false })
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(allSuccessResponse), ...withoutBgmJudgment, broadcasterId: streamerId, now })
    await saveBgmSettings(store, { judgeWithJev: true })
    const jev = trackPickingJev('t1')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), jev, alerts: createFakeAlertChannel().namespace, broadcasterId: streamerId, now: now + 5 * 60 * 1000 })

    expect(jev.order).toEqual([])
  })

  it('Jev が失敗しても収集は止めず、失敗を記録して曲はそのままにする', async () => {
    const { db, store, tokens } = await streamPlayingChatTrack()
    const jev: JevClient = {
      decide: async () => {
        throw new Error('Jev が失敗を返しました（402）')
      },
    }

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(allSuccessResponse), jev, alerts: createFakeAlertChannel().namespace, broadcasterId: streamerId, now })

    expect((await loadBgmPlayback(store)).mediaId).toBe(chatTrack.mediaId)
    const failed = (await listFailures(db)).filter((failure) => failure.code === 'bgm-choice-failed')
    expect(failed.map((failure) => failure.message)).toEqual([expect.stringContaining('402')])
    // あらすじのあとのサイドスーパーも作られている
    expect(await readSideSuper(db, chatStream.id)).not.toBeNull()
  })
})

describe('サイドスーパーの生成', () => {
  /** 配信中の区切りと、その配信の文字起こし・発言をそろえる */
  const createLiveMaterial = (db: ReturnType<typeof createFakeDatabase>) => {
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(chatStream.id, chatStream.startedAt, chatStream.title, chatStream.categoryName)
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-1', chatStream.id, new Date(now - 2 * 60 * 1000).toISOString(), '今日は新しいゲームを遊びます')
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-1', chatStream.id, '100', new Date(now - 60 * 1000).toISOString(), 'たのしみ！')
  }

  it('配信中なら、直近の材料からサイドスーパーを作って貯める', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai: fakeAi('新作ゲーム\n初見プレイ中'),
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now,
    })

    expect(await readSideSuper(db, chatStream.id)).toEqual({
      lines: ['新作ゲーム', '初見プレイ中'],
      updatedAt: new Date(now).toISOString(),
    })
  })

  it('直近に画面へ現れた文字も材料にする', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    createScreenLines(db, '1枚目', now - 90 * 1000, 'ストームヴィル城')
    const ai = fakeAi('新作ゲーム\n城を攻略中')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(ai.receivedMaterial('sideSuper').some((material) => material.includes('ストームヴィル城'))).toBe(true)
  })

  it('前回のあとに画面へ新しい文字が現れていれば、喋りも発言も無くても作り直す', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(allSuccessResponse), ...withoutBgmJudgment, broadcasterId: streamerId, now })
    const fiveMinutesLater = now + 5 * 60 * 1000
    // 撮ったのは前回サイドスーパーを作るより前で、篩を通って材料になったのはそのあと、という並びにする。
    // OCRの取得と篩は5分おきの収集で遅れて起きるので、実際にはこの並びが普通である
    createScreenLines(db, '1枚目', now - 60 * 1000, 'ストームヴィル城', fiveMinutesLater - 1000)
    const ai = fakeAi('新作ゲーム\n城を攻略中')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: fiveMinutesLater })

    expect(await readSideSuper(db, chatStream.id)).toEqual({ lines: ['新作ゲーム', '城を攻略中'], updatedAt: new Date(fiveMinutesLater).toISOString() })
  })

  it('前回作った時刻とちょうど同じ時刻の発話は、前回の材料に入っているので作り直さない', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    // 前提: 収集の時刻と同じ時刻に届いた発話がある。1回目の収集では、この発話も材料に入る
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-same-time', chatStream.id, new Date(now).toISOString(), 'ボス戦に挑みます')
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(allSuccessResponse), ...withoutBgmJudgment, broadcasterId: streamerId, now })
    const ai = fakeAi('新作ゲーム\n城を攻略中')

    // そのあと発話も発言も画面の文字も増えていないので、LLMを呼ばない
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: now + 5 * 60 * 1000 })

    expect(ai.receivedMaterial('sideSuper')).toEqual([])
    expect(await readSideSuper(db, chatStream.id)).toEqual({ lines: ['初見プレイ中', 'ボス戦へ向けて装備集め'], updatedAt: new Date(now).toISOString() })
  })

  it('画面の文字を取りに行く前に、サイドスーパーを作り終えている（画面の処理が重くても止まらないため）', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    await recordScreenCapture(db, '1枚目', now - 60 * 1000)
    // Gyazo に読み取った文字を取りに行った時点で、サイドスーパーが貯まっているかを覚えておく
    let sideSuperWhenFetchingOcr: Awaited<ReturnType<typeof readSideSuper>> = null
    const gyazo = {
      fetchOcr: async () => {
        sideSuperWhenFetchingOcr = await readSideSuper(db, chatStream.id)
        return '画面に出ていた文字'
      },
    }

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(allSuccessResponse), ...withoutBgmJudgment, broadcasterId: streamerId, now, gyazo })

    expect(sideSuperWhenFetchingOcr).not.toBeNull()
  })

  it('サイドスーパーを作ったあとに同じ収集で篩を通った画面の文字は、次の収集で材料にする', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    // 前提: 読み取りまで済んだ1枚がある。1回目の収集では、サイドスーパーを作ったあとで篩を通って積まれる
    await recordScreenCapture(db, '1枚目', now - 60 * 1000)
    await saveScreenOcr(db, '1枚目', 'ストームヴィル城')
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(allSuccessResponse), ...withoutBgmJudgment, broadcasterId: streamerId, now })
    const fiveMinutesLater = now + 5 * 60 * 1000
    const ai = fakeAi('新作ゲーム\n城を攻略中')

    // 喋りも発言も増えていないが、前回のサイドスーパーに入っていない画面の文字があるので作り直す
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: fiveMinutesLater })

    expect(ai.receivedMaterial('sideSuper').some((material) => material.includes('ストームヴィル城'))).toBe(true)
    expect(await readSideSuper(db, chatStream.id)).toEqual({ lines: ['新作ゲーム', '城を攻略中'], updatedAt: new Date(fiveMinutesLater).toISOString() })
  })

  it('配信していなければ、サイドスーパーを作らない', async () => {
    const { db, store, tokens } = await createEnv()

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch({ getLiveStream: async () => null }),
      ai: fakeAi(),
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now,
    })

    expect(await readSideSuper(db, chatStream.id)).toBeNull()
  })

  it('前回作ったあとに新しい材料が無ければ、作り直さない', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(allSuccessResponse), ...withoutBgmJudgment, broadcasterId: streamerId, now })
    const ai = fakeAi()

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: now + 5 * 60 * 1000 })

    expect(ai.callCount()).toBe(0)
  })

  it('LLMが失敗しても収集は止めず、失敗を記録して前回のサイドスーパーを残す', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi('新作ゲーム\n初見プレイ中'), ...withoutBgmJudgment, broadcasterId: streamerId, now })
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-2', chatStream.id, new Date(now + 60 * 1000).toISOString(), 'ボスに負けました')

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai: fakeAi(new Error('Workers AI の無料枠を使い切りました')),
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now: now + 5 * 60 * 1000,
    })

    expect((await readSideSuper(db, chatStream.id))?.lines).toEqual(['新作ゲーム', '初見プレイ中'])
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('side-super-failed')
    expect((await getSession(db, chatStream.id, now))?.samples).toHaveLength(2)
  })

  it('上限より長い行が返ってきたら、切り詰めずに失敗として記録する', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai: fakeAi(`新作ゲーム\n${'あ'.repeat(MAX_SIDE_SUPER_BODY_LENGTH + 1)}`),
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now,
    })

    expect(await readSideSuper(db, chatStream.id)).toBeNull()
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('side-super-failed')
  })
})

describe('collectStats（配信画面から読み取った文字の取得）', () => {
  /** 呼ばれた画像IDを覚え、決めておいた答えを返す Gyazo の代役 */
  const fakeGyazo = (answer: (imageId: string) => string | null | Error = () => '画面に出ていた文字') => {
    const fetched: string[] = []
    return {
      fetched,
      fetchOcr: async (imageId: string) => {
        fetched.push(imageId)
        const reply = answer(imageId)
        if (reply instanceof Error) throw reply
        return reply
      },
    }
  }

  /** 配信中に1枚撮った状態を作る */
  const createCapture = async (db: ReturnType<typeof createFakeDatabase>, imageId = '画像1') => {
    await recordStreamOnline(db, { id: chatStream.id, startedAt: Date.parse(chatStream.startedAt) })
    await recordScreenCapture(db, imageId, now - 60 * 1000)
  }

  it('まだ読み取っていない画像のOCRを取りに行き、取れた文字を記録する', async () => {
    const { db, store, tokens } = await createEnv()
    await createCapture(db)
    const gyazo = fakeGyazo(() => '岩手17歳女性殺害事件')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now, gyazo })

    expect(gyazo.fetched).toEqual(['画像1'])
    expect(await listPendingOcr(db, 10)).toEqual([])
    expect(db.sqlite.prepare('SELECT ocr_text FROM screen_captures').get()).toEqual({ ocr_text: '岩手17歳女性殺害事件' })
  })

  it('まだ生成されていなければ記録せず、次の収集に回す', async () => {
    const { db, store, tokens } = await createEnv()
    await createCapture(db)
    const gyazo = fakeGyazo(() => null)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now, gyazo })

    expect(await listPendingOcr(db, 10)).toHaveLength(1)
    expect(await listFailures(db)).toEqual([])
  })

  it('取りに行っても生成されないままなら、上限で諦める', async () => {
    const { db, store, tokens } = await createEnv()
    await createCapture(db)
    const gyazo = fakeGyazo(() => null)

    for (let round = 0; round < OCR_MAX_ATTEMPTS + 1; round += 1) {
      await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now, gyazo })
    }

    // 上限に達したあとの収集では、もう取りに行かない
    expect(gyazo.fetched).toHaveLength(OCR_MAX_ATTEMPTS)
  })

  it('Gyazo が失敗を返したら、失敗として記録したうえで収集そのものは続ける', async () => {
    const { db, store, tokens } = await createEnv()
    await createCapture(db)
    const gyazo = fakeGyazo(() => new GyazoApiError(401, 'Gyazo からのOCRの取得が 401 で失敗しました: unauthorized'))

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now, gyazo })

    expect((await listFailures(db)).map((failure) => failure.code)).toContain('screen-ocr-failed')
    // 画面の文字が取れなくても、配信の記録は残す
    expect((await getSession(db, chatStream.id, now))?.samples).toHaveLength(1)
  })

  it('1枚目で失敗したら、残りは取りに行かない（同じ理由で続けて失敗するため）', async () => {
    const { db, store, tokens } = await createEnv()
    await createCapture(db, '画像1')
    await recordScreenCapture(db, '画像2', now - 30 * 1000)
    const gyazo = fakeGyazo(() => new GyazoApiError(401, 'Gyazo からのOCRの取得が 401 で失敗しました: unauthorized'))

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now, gyazo })

    expect(gyazo.fetched).toEqual(['画像1'])
  })

  it('その画像が Gyazo から消えていたら（404）、その1枚だけを諦めて残りは取りに行く', async () => {
    const { db, store, tokens } = await createEnv()
    await createCapture(db, '消された画像')
    await recordScreenCapture(db, '残っている画像', now - 30 * 1000)
    const gyazo = fakeGyazo((imageId) =>
      imageId === '消された画像' ? new GyazoApiError(404, 'Gyazo からのOCRの取得が 404 で失敗しました') : '画面に出ていた文字',
    )

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now, gyazo })

    expect(gyazo.fetched).toEqual(['消された画像', '残っている画像'])
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('screen-ocr-failed')
    // 消された画像は、次の収集でもう取りに行かない（毎回そこで止まらないようにするため）
    expect(await listPendingOcr(db, 10)).toEqual([])
  })

  it('Gyazo のアクセストークンが無ければ、取りに行かない', async () => {
    const { db, store, tokens } = await createEnv()
    await createCapture(db)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(await listPendingOcr(db, 10)).toHaveLength(1)
    expect(await listFailures(db)).toEqual([])
  })
})

describe('collectStats（画面に新しく現れた文字の取り出し）', () => {
  /** 配信中に1枚撮り、その画面から読み取った文字まで用意する */
  const createOcrImage = async (db: ReturnType<typeof createFakeDatabase>, ocrText: string, imageId = '画像1') => {
    await recordStreamOnline(db, { id: chatStream.id, startedAt: Date.parse(chatStream.startedAt) })
    await recordScreenCapture(db, imageId, now - 60 * 1000)
    await saveScreenOcr(db, imageId, ocrText)
  }

  it('読み取った文字を篩に通し、残った行を積む', async () => {
    const { db, store, tokens } = await createEnv()
    await createOcrImage(db, '岩手17歳女性殺害事件\nあ\n盛岡市のガソリンスタンド')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    // 中身のない行（3文字未満）は落ちる
    expect(await readRecentScreenLines(db, chatStream.id, 10)).toEqual(['盛岡市のガソリンスタンド', '岩手17歳女性殺害事件'])
  })

  it('自前の文字（配信者の発話）は積まない', async () => {
    const { db, store, tokens } = await createEnv()
    await createOcrImage(db, '岩手の事件について話します\n盛岡市のガソリンスタンド')
    await recordTranscript(db, { messageId: 't1', text: '岩手の事件について話します' }, now - 90 * 1000)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(await readRecentScreenLines(db, chatStream.id, 10)).toEqual(['盛岡市のガソリンスタンド'])
  })

  it('同じ画面を撮り続けても、2枚目からは積まない', async () => {
    const { db, store, tokens } = await createEnv()
    await createOcrImage(db, '岩手17歳女性殺害事件', '画像1')
    await recordScreenCapture(db, '画像2', now - 30 * 1000)
    // OCRは同じ画面でも毎回違う文字を返すので、完全一致では畳めない（「2008」→「2006」の実測と同じ形）
    await saveScreenOcr(db, '画像2', '岩手17歳女性殺書事件')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(await readRecentScreenLines(db, chatStream.id, 10)).toEqual(['岩手17歳女性殺害事件'])
  })

  it('篩に通し終えた1枚は、次の収集で通し直さない', async () => {
    const { db, store, tokens } = await createEnv()
    await createOcrImage(db, '岩手17歳女性殺害事件')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })
    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now })

    expect(db.sqlite.prepare('SELECT COUNT(*) AS itemCount FROM screen_lines').get()).toEqual({ itemCount: 1 })
  })
})

describe('collectStats（1回ぶんの時間予算。issue #126）', () => {
  /** 配信中で、あらすじ・サイドスーパーの材料が揃っている状態を作る */
  const createLiveMaterial = (db: ReturnType<typeof createFakeDatabase>) => {
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(chatStream.id, chatStream.startedAt, chatStream.title, chatStream.categoryName)
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-1', chatStream.id, new Date(now - 2 * 60 * 1000).toISOString(), '今日は新しいゲームを遊びます')
  }

  /** 1回目は開始の時刻を返し、2回目以降は予算を使い切った時刻を返す時計 */
  const budgetExhaustingClock = () => {
    let count = 0
    return () => {
      count += 1
      return count === 1 ? now : now + COLLECT_BUDGET_MS + 1
    }
  }

  it('予算を過ぎても、配信の記録（視聴者数・フォロワー数）は残す', async () => {
    const { db, store, tokens } = await createEnv()

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai: fakeAi(),
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now,
      clock: budgetExhaustingClock(),
    })

    expect(await listSessions(db, now)).toHaveLength(1)
    expect(await listFollowerSamples(db)).toHaveLength(1)
  })

  it('予算を過ぎたら、材料づくり（あらすじ・サイドスーパー・人物像）は次の収集へ回す', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    const ai = fakeAi()

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai,
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now,
      clock: budgetExhaustingClock(),
    })

    expect(ai.callCount()).toBe(0)
    expect(await readStreamSummary(db, chatStream.id)).toBeNull()
    expect(await readSideSuper(db, chatStream.id)).toBeNull()
  })

  it('予算を過ぎたら、まだ読み取っていない画像のOCRは取りに行かない', async () => {
    const { db, store, tokens } = await createEnv()
    await recordStreamOnline(db, { id: chatStream.id, startedAt: Date.parse(chatStream.startedAt) })
    await recordScreenCapture(db, '画像1', now - 120 * 1000)
    await recordScreenCapture(db, '画像2', now - 60 * 1000)
    const fetched: string[] = []
    const gyazo = { fetchOcr: async (imageId: string) => (fetched.push(imageId), '画面に出ていた文字') }
    // 1枚目を取りに行ったところで予算を使い切る時計。開始・あらすじの前・サイドスーパーの前・1枚目の前の
    // 4回までは予算内（画面の文字はあらすじとサイドスーパーより後に取りに行く）
    let count = 0
    const clock = () => {
      count += 1
      return count <= 4 ? now : now + COLLECT_BUDGET_MS + 1
    }

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: fakeAi(), ...withoutBgmJudgment, broadcasterId: streamerId, now, gyazo, clock })

    expect(fetched).toEqual(['画像1'])
  })

  it('予算で打ち切ったことを、何を次へ回したかとともに失敗として記録する', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai: fakeAi(),
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now,
      clock: budgetExhaustingClock(),
    })

    const failed = await listFailures(db)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.code).toBe('collect-budget-exceeded')
    expect(failed[0]?.message).toContain('あらすじ')
  })

  it('あらすじを作っているあいだに予算を使い切ったら、サイドスーパーと人物像を次の収集へ回す', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    // 開始と、あらすじを作る前の1回までは予算内。そのあとは予算を使い切っている
    let count = 0
    const clock = () => {
      count += 1
      return count <= 2 ? now : now + COLLECT_BUDGET_MS + 1
    }
    const ai = fakeAi(allSuccessResponse)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now, clock })

    // あらすじは作られ、そのあとのサイドスーパーと人物像は次の収集へ回る
    expect(ai.callCount()).toBe(1)
    expect(await readStreamSummary(db, chatStream.id)).not.toBeNull()
    expect(await readSideSuper(db, chatStream.id)).toBeNull()
    const failed = await listFailures(db)
    expect(failed[0]?.message).toContain('サイドスーパー')
    expect(failed[0]?.message).toContain('人物像')
    expect(failed[0]?.message).not.toContain('あらすじ')
  })

  it('人物像は1人ごとに予算を見て、残りの人数を次の収集へ回す', async () => {
    const { db, store, tokens } = await createEnv()
    // 終わった配信で発言した2人ぶんの材料を置く（人物像はまだ無い）
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('owatta-haishin', new Date(now - 60 * 60 * 1000).toISOString(), new Date(now - 30 * 60 * 1000).toISOString(), '昨日の配信', 'Just Chatting')
    for (const { userId, displayName } of [
      { userId: '100', displayName: '花子' },
      { userId: '200', displayName: '太郎' },
    ]) {
      await recordViewerMessage(db, { userId, login: `user${userId}`, displayName, badges: [], messageId: `chat-${userId}` }, now - 10 * 60 * 1000)
      db.sqlite
        .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
        .run(`hatsugen-${userId}`, 'owatta-haishin', userId, new Date(now - 45 * 60 * 1000).toISOString(), 'そのギターいいですね')
    }
    // 開始・章立ての入口・人物像づくりの入口・1人目の前までは予算内で、2人目の前で予算を使い切っている
    let count = 0
    const clock = () => {
      count += 1
      return count <= 4 ? now : now + COLLECT_BUDGET_MS + 1
    }
    const ai = fakeAi()

    await collectStats({ db, store, tokens, twitch: fakeTwitch({ getLiveStream: async () => null }), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now, clock })

    expect(ai.callCount()).toBe(1)
    const failed = await listFailures(db)
    expect(failed[0]?.code).toBe('collect-budget-exceeded')
    expect(failed[0]?.message).toContain('人物像（残り1人）')
  })

  it('予算のうちに終われば、何も打ち切らず失敗も残さない', async () => {
    const { db, store, tokens } = await createEnv()
    createLiveMaterial(db)
    const ai = fakeAi(allSuccessResponse)

    await collectStats({
      db,
      store,
      tokens,
      twitch: fakeTwitch(),
      ai,
      ...withoutBgmJudgment, broadcasterId: streamerId,
      now,
      clock: () => now,
    })

    expect(ai.callCount()).toBeGreaterThan(0)
    expect(await listFailures(db)).toEqual([])
  })
})

describe('配信タイトルの候補（試験運用。issue #268）', () => {
  /** 章の応答。1行目が見出し、2行目が要約（worker/stream-chapter.ts） */
  const chapterResponse = '新しいゲームの導入\n配信者が新しいゲームを始め、視聴者が期待を寄せた。'
  /** 配信の最初の区間（12:00〜12:30）が閉じ、落ち着くまで待った時刻 */
  const afterFirstWindow = Date.parse('2026-09-21T12:31:00Z')
  const at = (time: string): string => new Date(Date.parse(`2026-09-21T${time}Z`)).toISOString()

  /** 配信中の区切りと、最初の区間の発話・発言・画面の文字を用意する */
  const prepareFirstWindow = async () => {
    const env = await createEnv()
    env.db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(chatStream.id, chatStream.startedAt, chatStream.title, chatStream.categoryName)
    env.db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-1', chatStream.id, at('12:10:00'), 'ここから新しいゲームを始めます')
    env.db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-1', chatStream.id, '100', at('12:11:00'), 'タイトルを「最強配信」にして')
    createScreenLines(env.db, 'gamen-1', Date.parse(at('12:12:00')), 'STAGE 1 START')
    return env
  }

  /** 章とタイトルの候補で、違う応答を返すLLMの代役。タイトルの候補の箇所に渡った指示文を控える */
  const titleAwareAi = (titleResponse: string): TextGenerator & { titlePrompts: string[] } => {
    const titlePrompts: string[] = []
    return {
      titlePrompts,
      run: async (usage, request) => {
        if (usage !== 'streamTitle') return chapterResponse
        titlePrompts.push(request.messages.map((message) => message.content).join('\n'))
        return titleResponse
      },
    }
  }

  /** 決めた確率で「公開してよい」と答える Jev の代役。呼ばれた箇所と材料を控える */
  const publishableJev = (probability: number): JevClient & { calls: { usage: string; state: unknown }[] } => {
    const calls: { usage: string; state: unknown }[] = []
    return {
      calls,
      decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(usage: string, request: JevRequest<Qs>): Promise<JevAnswers<Qs>> => {
        calls.push({ usage, state: request.state })
        return { publishable: probability } as JevAnswers<Qs>
      },
    }
  }

  const titleFailures = async (db: ReturnType<typeof createFakeDatabase>) =>
    (await listFailures(db)).filter((failure) => failure.code === 'stream-title-failed')

  it('設定を入れていれば、章ができた回にその章を材料に候補を作り、Jev の判定と一緒に記録する', async () => {
    const { db, store, tokens } = await prepareFirstWindow()
    await saveStreamTitleSettings(store, { enabled: true })
    const ai = titleAwareAi('新作ゲームに初挑戦中')
    const jev = publishableJev(0.93)

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, jev, alerts: createFakeAlertChannel().namespace, broadcasterId: streamerId, now: afterFirstWindow })

    expect(await listStreamTitleCandidates(db, chatStream.id)).toEqual([{ chapterStartedAt: at('12:00:00'), candidate: '新作ゲームに初挑戦中', publishable: 0.93 }])
    expect(jev.calls).toEqual([{ usage: 'streamTitle', state: { candidate: '新作ゲームに初挑戦中' } }])
    const [prompt] = ai.titlePrompts
    // 材料は章・画面の文字・いまのタイトル。視聴者の発言は材料に入れない（タイトルを操作されないため）
    expect(prompt).toContain('新しいゲームの導入')
    expect(prompt).toContain('画面: STAGE 1 START')
    expect(prompt).toContain('月曜の雑談配信')
    expect(prompt).not.toContain('最強配信')
  })

  it('同じ章の候補は、次の収集で作り直さない', async () => {
    const { db, store, tokens } = await prepareFirstWindow()
    await saveStreamTitleSettings(store, { enabled: true })
    const ai = titleAwareAi('新作ゲームに初挑戦中')
    const options = { db, store, tokens, twitch: fakeTwitch(), ai, jev: publishableJev(0.93), alerts: createFakeAlertChannel().namespace, broadcasterId: streamerId }

    await collectStats({ ...options, now: afterFirstWindow })
    await collectStats({ ...options, now: afterFirstWindow + 5 * 60 * 1000 })

    expect(ai.titlePrompts).toHaveLength(1)
  })

  it('設定が既定（未保存）なら、候補を作らず Jev も呼ばない', async () => {
    const { db, store, tokens } = await prepareFirstWindow()
    const ai = titleAwareAi('新作ゲームに初挑戦中')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: afterFirstWindow })

    expect(ai.titlePrompts).toEqual([])
    expect(await listStreamTitleCandidates(db, chatStream.id)).toEqual([])
  })

  it('候補が上限より長ければ、切り詰めずに捨てて失敗として残し、Jev は呼ばない', async () => {
    const { db, store, tokens } = await prepareFirstWindow()
    await saveStreamTitleSettings(store, { enabled: true })
    const ai = titleAwareAi('配信者が新しいゲームを始めて最初のステージに挑戦しています')

    await collectStats({ db, store, tokens, twitch: fakeTwitch(), ai, ...withoutBgmJudgment, broadcasterId: streamerId, now: afterFirstWindow })

    expect(await listStreamTitleCandidates(db, chatStream.id)).toEqual([])
    expect(await titleFailures(db)).toHaveLength(1)
  })

  it('保存されている設定が壊れていても収集そのものは止めず、失敗として残す（あとに続く人物像づくりを止めないため）', async () => {
    const { db, store, tokens } = await prepareFirstWindow()
    await store.put('stream-title-settings', '{"enabled":"はい"}')

    await expect(
      collectStats({ db, store, tokens, twitch: fakeTwitch(), ai: titleAwareAi('新作ゲームに初挑戦中'), ...withoutBgmJudgment, broadcasterId: streamerId, now: afterFirstWindow }),
    ).resolves.toBeUndefined()

    expect(await titleFailures(db)).toHaveLength(1)
  })

  it('Jev が失敗したら記録せずに失敗として残し、次の収集でやり直す', async () => {
    const { db, store, tokens } = await prepareFirstWindow()
    await saveStreamTitleSettings(store, { enabled: true })
    const ai = titleAwareAi('新作ゲームに初挑戦中')
    const failingJev: JevClient = { decide: async () => Promise.reject(new Error('Jev が失敗を返しました（402）')) }
    const options = { db, store, tokens, twitch: fakeTwitch(), ai, alerts: createFakeAlertChannel().namespace, broadcasterId: streamerId }

    await collectStats({ ...options, jev: failingJev, now: afterFirstWindow })

    expect(await listStreamTitleCandidates(db, chatStream.id)).toEqual([])
    const [failure] = await titleFailures(db)
    // 作った候補は、失敗の記録から読めるように残す
    expect(failure?.message).toContain('新作ゲームに初挑戦中')

    await collectStats({ ...options, jev: publishableJev(0.93), now: afterFirstWindow + 5 * 60 * 1000 })

    expect(await listStreamTitleCandidates(db, chatStream.id)).toHaveLength(1)
  })
})
