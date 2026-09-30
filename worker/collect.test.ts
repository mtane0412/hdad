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
import { readSideSuper } from './side-super-store'
import { MAX_SIDE_SUPER_BODY_LENGTH } from './side-super'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'
import { getSession, listFailures, listFollowerSamples, listSessions, recordStreamOnline } from './stats-store'
import { AuthError, loadToken, saveToken, type StoredToken } from './token'
import { deleteViewer, readViewer, recordViewerMessage } from './viewer-store'
import { TwitchApiError, type LiveStream, type TwitchClient } from './twitch'
import { GyazoApiError } from './gyazo'
import { recordTranscript } from './transcript-store'
import { loadBgmPlayback, saveBgmPlayback, saveBgmSettings, saveBgmTracks, type BgmTrack } from './bgm-config'
import { createFakeAlertChannel } from './fake-alert-channel'
import type { JevAnswers, JevClient, JevQuestion, JevRequest } from './jev'
import { OCR_MAX_ATTEMPTS, listPendingOcr, readRecentScreenLines, recordScreenCapture, saveScreenOcr } from './screen-store'

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

/**
 * 篩を通ったあとの行（screen_lines）を1行だけ直に置く。
 *
 * あらすじ・サイドスーパーの材料として渡っているかを確かめるテストが使う。撮影から篩までの道のりは
 * 「画面の文字の取り込み」「篩」のテストが通るので、ここでは通し終えた形だけを用意する。
 */
const 画面に現れた行を作る = (
  db: ReturnType<typeof createFakeDatabase>,
  imageId: string,
  capturedAt: number,
  text: string,
  siftedAt = capturedAt,
): void => {
  const 撮った時刻 = new Date(capturedAt).toISOString()
  const 積んだ時刻 = new Date(siftedAt).toISOString()
  db.sqlite
    .prepare('INSERT INTO screen_captures (image_id, session_id, captured_at, ocr_text, sifted_at) VALUES (?, ?, ?, ?, ?)')
    .run(imageId, 雑談配信.id, 撮った時刻, text, 積んだ時刻)
  db.sqlite
    .prepare('INSERT INTO screen_lines (image_id, line_no, session_id, captured_at, text, sifted_at) VALUES (?, 0, ?, ?, ?, ?)')
    .run(imageId, 雑談配信.id, 撮った時刻, text, 積んだ時刻)
}

const AIの代役 = (
  response: string | Error = 'ギターの話をよくする常連さん',
): TextGenerator & { 呼ばれた数: () => number; 渡された材料: (usage: LlmUsage) => string[] } => {
  let 回数 = 0
  const 記録: { usage: LlmUsage; prompt: string }[] = []
  return {
    呼ばれた数: () => 回数,
    // 材料が漏れなくLLMへ渡っているかを、使う箇所（あらすじ・サイドスーパー）ごとに確かめられるようにする。
    // 箇条を分けずに全部の文面をまとめて見ると、片方への受け渡しが壊れても、もう片方に入っているだけで通ってしまう
    渡された材料: (usage) => 記録.filter((一件) => 一件.usage === usage).map((一件) => 一件.prompt),
    run: async (usage, request) => {
      回数 += 1
      記録.push({ usage, prompt: request.messages.map((message) => message.content).join('\n') })
      if (response instanceof Error) throw response
      return response
    },
  }
}

type 収集用のTwitch = Pick<TwitchClient, 'refresh' | 'getLiveStream' | 'getFollowerTotal' | 'getChannel'>

const Twitchの代役 = (overrides: Partial<収集用のTwitch> = {}): 収集用のTwitch => ({
  refresh: async () => {
    throw new Error('テストで想定していないトークンの更新です')
  },
  getLiveStream: async () => 雑談配信,
  getFollowerTotal: async () => 1234,
  getChannel: async () => ({ categoryName: 'Cuphead', title: '初見でボスラッシュ' }),
  ...overrides,
})

/** 呼ばれたら失敗させる Jev の代役。BGMの設定は既定でオフなので、BGMの切り替えを確かめないテストでは呼ばれない */
const 呼ばれないJev: JevClient = {
  decide: async () => {
    throw new Error('このテストでは Jev を呼ばないはずです')
  },
}

/** BGMの切り替え（issue #153）を確かめないテストで渡す依存 */
const BGMの判定を使わない = { jev: 呼ばれないJev, alerts: createFakeAlertChannel().namespace }

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

    await collectStats({ db, store, twitch, ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(受け取った引数).toEqual([['保管中のアクセストークン', '12345']])
    expect((await getSession(db, 雑談配信.id))?.samples).toEqual([{ sampledAt: '2026-09-21T12:05:00.000Z', viewerCount: 42 }])
    expect(await listFollowerSamples(db)).toEqual([{ sampledAt: '2026-09-21T12:05:00.000Z', followerTotal: 1234 }])
    expect(await listFailures(db)).toEqual([])
  })

  it('配信していなければ、開いているセッションを閉じ、フォロワー数だけを記録する', async () => {
    const { db, store } = await 環境を作る()
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    const 五分後 = 現在時刻 + 5 * 60 * 1000
    await collectStats({ db, store, twitch: Twitchの代役({ getLiveStream: async () => null }), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 五分後 })

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

    await collectStats({ db, store, twitch, ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(使われたトークン).toEqual(['保管中のアクセストークン', '取り直したアクセストークン'])
    expect((await loadToken(store, 'broadcaster'))?.accessToken).toBe('取り直したアクセストークン')
    expect(await listSessions(db, 現在時刻)).toHaveLength(1)
  })

  it('トークンが保管されていなければ、黙って飛ばさず、失敗を記録してエラーにする', async () => {
    const { db, store } = await 環境を作る(null)

    await expect(collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })).rejects.toBeInstanceOf(AuthError)

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

    await expect(collectStats({ db, store, twitch, ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })).rejects.toBeInstanceOf(AuthError)

    expect((await listFailures(db))[0]?.code).toBe('relogin-required')
  })

  it('フォロワー数の取得に失敗しても、先に取れた配信の記録は残し、失敗を記録する', async () => {
    const { db, store } = await 環境を作る()
    const twitch = Twitchの代役({
      getFollowerTotal: async () => {
        throw new TwitchApiError(500, 'Twitchが 500 を返しました: Internal Server Error')
      },
    })

    await expect(collectStats({ db, store, twitch, ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })).rejects.toBeInstanceOf(TwitchApiError)

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

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

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

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(db.sqlite.prepare('SELECT message_id FROM transcripts').all()).toEqual([{ message_id: 'kyou-no-hatsuwa' }])
  })

  it('保持期間より古いコメントの既読・未読を消す（反応したかを見るのは配信中だけなので、終わった配信のぶんを残さない）', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保管中のトークン)
    const 二日 = 2 * 24 * 60 * 60 * 1000
    const 既読を足す = (messageId: string, at: number): void => {
      db.sqlite
        .prepare('INSERT INTO comment_reads (message_id, read, marked_by, updated_at) VALUES (?, ?, ?, ?)')
        .run(messageId, 1, 'manual', new Date(at).toISOString())
    }
    既読を足す('おとといの配信の発言', 現在時刻 - 二日)
    既読を足す('いまの配信の発言', 現在時刻)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(db.sqlite.prepare('SELECT message_id FROM comment_reads').all()).toEqual([{ message_id: 'いまの配信の発言' }])
  })

  it('保持期間より古い画面の取り込みの記録を消す（文字起こしと同じく、配信中だけ持つものであるため）', async () => {
    const db = createFakeDatabase()
    const store = createFakeStore()
    await saveToken(store, 'broadcaster', 保管中のトークン)
    const 三十日 = 30 * 24 * 60 * 60 * 1000
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('mukashi-no-haishin', new Date(現在時刻 - 三十日).toISOString(), new Date(現在時刻 - 三十日).toISOString(), '昔の配信', 'Just Chatting')
    const 取り込みを足す = (imageId: string, at: number): void => {
      db.sqlite
        .prepare('INSERT INTO screen_captures (image_id, session_id, captured_at) VALUES (?, ?, ?)')
        .run(imageId, 'mukashi-no-haishin', new Date(at).toISOString())
    }
    取り込みを足す('mukashi-no-gamen', 現在時刻 - 三十日)
    取り込みを足す('kyou-no-gamen', 現在時刻)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(db.sqlite.prepare('SELECT image_id FROM screen_captures').all()).toEqual([{ image_id: 'kyou-no-gamen' }])
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

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

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

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    // LLMの呼び出しそのものは、この配信のあらすじづくり（issue #65）で起きうる。ここで確かめたいのは
    // 「配信中の発言から人物像を作らないこと」なので、人物像が空のままであることで判断する
    expect(await readViewer(db, '100')).toMatchObject({ summary: '' })
  })

  it('LLMが失敗したら、収集自体は成功させたうえで失敗を記録し、材料は消さない（次の収集でやり直せるようにするため）', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(new Error('無料枠を使い切りました')), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

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

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(ai.呼ばれた数()).toBe(0)
    expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM stream_chat_messages').get()).toEqual({ count: 0 })
  })

  it('人物像を作る人のチャンネルを観測して記録し、その内容を材料に渡す', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)
    const 問い合わせたユーザーID: string[] = []
    const twitch = Twitchの代役({
      getChannel: async (_accessToken, userId) => {
        問い合わせたユーザーID.push(userId)
        return { categoryName: 'Cuphead', title: '初見でボスラッシュ' }
      },
    })
    const 渡された材料: string[] = []
    const ai: TextGenerator = {
      run: async (_usage, request) => {
        渡された材料.push(request.messages.map((message) => message.content).join('\n'))
        return 'ギターの話をよくする常連さん'
      },
    }

    await collectStats({ db, store, twitch, ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(問い合わせたユーザーID).toEqual(['100'])
    expect(await readViewer(db, '100')).toMatchObject({
      channel: { categoryName: 'Cuphead', title: '初見でボスラッシュ', checkedAt: '2026-09-21T12:05:00.000Z' },
    })
    // 観測した内容は、その回の人物像づくりの材料にも入る（次の収集まで待たせない）
    expect(渡された材料.join('\n')).toContain('初見でボスラッシュ')
  })

  it('チャンネルを観測できなくても、人物像づくりは続けて失敗だけを記録する', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)
    const twitch = Twitchの代役({
      getChannel: async () => {
        throw new TwitchApiError(502, 'TwitchにユーザーID 100 のチャンネルがありません')
      },
    })

    await collectStats({ db, store, twitch, ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(await readViewer(db, '100')).toMatchObject({ summary: 'ギターの話をよくする常連さん', channel: null })
    expect(await listFailures(db)).toEqual([
      { occurredAt: '2026-09-21T12:05:00.000Z', code: 'viewer-channel-failed', message: expect.stringContaining('チャンネルがありません') },
    ])
  })

  it('同じ収集で2人ぶん観測できなくても、両方の理由が残る（1行にまとめて記録するため）', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db, '100')
    await recordViewerMessage(db, { userId: '200', login: 'taro', displayName: '太郎', badges: [], messageId: 'chat-200' }, 現在時刻 - 10 * 60 * 1000)
    db.sqlite
      .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
      .run('hatsugen-200', 'owatta-haishin', '200', new Date(現在時刻 - 45 * 60 * 1000).toISOString(), 'こんばんは')
    const twitch = Twitchの代役({
      getChannel: async (_accessToken, userId) => {
        throw new TwitchApiError(502, `TwitchにユーザーID ${userId} のチャンネルがありません`)
      },
    })

    await collectStats({ db, store, twitch, ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    // 失敗の記録は「時刻と種類」で1行なので（migrations/0012_collection_failures_key.sql）、
    // 人ごとに記録すると後の人が前の人を上書きしてしまう。1行にまとめて両方を残す
    const 失敗 = await listFailures(db)
    expect(失敗).toHaveLength(1)
    expect(失敗[0]?.message).toContain('100')
    expect(失敗[0]?.message).toContain('200')
  })

  it('記録を消された人のチャンネルは問い合わせない（消えた人のためにTwitchを呼ばない）', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)
    await deleteViewer(db, '100')
    let 問い合わせた数 = 0
    const twitch = Twitchの代役({
      getChannel: async () => {
        問い合わせた数 += 1
        return { categoryName: 'Cuphead', title: '初見でボスラッシュ' }
      },
    })

    await collectStats({ db, store, twitch, ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(問い合わせた数).toBe(0)
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

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

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

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(ai.呼ばれた数()).toBe(SUMMARY_BATCH_SIZE)
  })

  it('古い材料は、人物像を作れないまま積み上がらないように消す', async () => {
    const { db, store } = await 環境を作る()
    await 終わった配信と発言を作る(db)
    db.sqlite
      .prepare('UPDATE stream_chat_messages SET sent_at = ?')
      .run(new Date(現在時刻 - STREAM_CHAT_RETENTION_MS - 1000).toISOString())

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(new Error('呼ばれないはず')), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

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
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(await readStreamSummary(db, 雑談配信.id)).toEqual({
      summary: '配信者は新しいゲームを始めたところです',
      transcriptsUntil: { at: new Date(現在時刻 - 2 * 60 * 1000).toISOString(), messageId: 'hatsuwa-1' },
      chatUntil: { at: new Date(現在時刻 - 60 * 1000).toISOString(), messageId: 'hatsugen-1' },
      screenUntil: { at: '', imageId: '', lineNo: -1 },
      updatedAt: new Date(現在時刻).toISOString(),
    })
  })

  it('画面に新しく現れた文字も材料にして、どこまで渡したかを目印に残す', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    画面に現れた行を作る(db, '1枚目', 現在時刻 - 90 * 1000, '岩手17歳女性殺害事件')
    const ai = AIの代役('配信者は未解決事件の資料を読んでいます')

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(ai.渡された材料('streamSummary').some((材料) => 材料.includes('岩手17歳女性殺害事件'))).toBe(true)
    expect((await readStreamSummary(db, 雑談配信.id))?.screenUntil).toEqual({
      at: new Date(現在時刻 - 90 * 1000).toISOString(),
      imageId: '1枚目',
      lineNo: 0,
    })
  })

  it('画面に新しく現れた文字しか無ければ、あらすじを作らない（読み取った文字だけを地の文にしないため）', async () => {
    const { db, store } = await 環境を作る()
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(雑談配信.id, 雑談配信.startedAt, '月曜の雑談配信', 'Just Chatting')
    画面に現れた行を作る(db, '1枚目', 現在時刻 - 90 * 1000, '岩手17歳女性殺害事件')

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(全部が成功する応答), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(await readStreamSummary(db, 雑談配信.id)).toBeNull()
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

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

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
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(ai.呼ばれた数()).toBe(0)
  })

  it('前回のあらすじのあとに新しい材料が無ければ、作り直さない', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(全部が成功する応答), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })
    const ai = AIの代役()

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 + 5 * 60 * 1000 })

    expect(ai.呼ばれた数()).toBe(0)
  })

  it('LLMが失敗しても収集は止めず、失敗を記録して前回のあらすじを残す', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-2', 雑談配信.id, new Date(現在時刻 + 60 * 1000).toISOString(), 'ボスに負けました')

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai: AIの代役(new Error('Workers AI の無料枠を使い切りました')),
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻 + 5 * 60 * 1000,
    })

    expect((await readStreamSummary(db, 雑談配信.id))?.summary).toBe('ギターの話をよくする常連さん')
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('stream-summary-failed')
    // 収集そのものは止まらないので、視聴者数は2回とも記録されている
    expect((await getSession(db, 雑談配信.id))?.samples).toHaveLength(2)
  })
})

describe('BGMの切り替え', () => {
  /** 雑談のときに流したい、落ち着いた曲 */
  const 雑談の曲: BgmTrack = {
    mediaId: 'media-zatsudan',
    title: 'ひだまりの午後',
    credit: '音楽: 甘茶の音楽工房',
    creditUrl: '',
    mood: 'ゆったりしたアコースティック',
    scene: '雑談・作業配信',
  }
  /** ゲームで盛り上がったときに流したい曲 */
  const 盛り上がる曲: BgmTrack = {
    mediaId: 'media-moriagari',
    title: '全力疾走',
    credit: '音楽: DOVA-SYNDROME',
    creditUrl: '',
    mood: 'テンポの速いロック',
    scene: 'ボス戦・盛り上がったとき',
  }

  /** 配信中で文字起こしがあり、雑談の曲を流していて、Jev に選ばせる設定を入れた状態を作る */
  const 雑談の曲を流している配信 = async () => {
    const { db, store } = await 環境を作る()
    await store.put('overlay-key', 'issued-overlay-key-0123456789abcdefghij')
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(雑談配信.id, 雑談配信.startedAt, '月曜の雑談配信', 'Just Chatting')
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-1', 雑談配信.id, new Date(現在時刻 - 2 * 60 * 1000).toISOString(), 'ボス戦だ、いくぞ！')
    await saveBgmTracks(store, [雑談の曲, 盛り上がる曲])
    await saveBgmPlayback(store, { mediaId: 雑談の曲.mediaId, volume: 0.4 })
    await saveBgmSettings(store, { judgeWithJev: true })
    return { db, store }
  }

  /** 決めた曲（選択肢の名前）を選ぶ Jev の代役。渡された注文を控える */
  const 曲を選ぶJev = (choice: string): JevClient & { 注文: JevRequest<Record<string, JevQuestion>>[] } => {
    const 注文: JevRequest<Record<string, JevQuestion>>[] = []
    return {
      注文,
      decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(_usage: unknown, request: JevRequest<Qs>): Promise<JevAnswers<Qs>> => {
        注文.push(request)
        return { track: { choice, confidence: 0.9 } } as JevAnswers<Qs>
      },
    }
  }

  it('あらすじを作り直したら、作ったあらすじと直近の発話を材料に Jev に曲を選ばせて切り替える', async () => {
    const { db, store } = await 雑談の曲を流している配信()
    const jev = 曲を選ぶJev('t1')
    const 配送 = createFakeAlertChannel()

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役('ボス戦に挑んでいます'), jev, alerts: 配送.namespace, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(jev.注文.map((注文) => 注文.state)).toEqual([{ summary: 'ボス戦に挑んでいます', transcript: ['ボス戦だ、いくぞ！'] }])
    expect((await loadBgmPlayback(store)).mediaId).toBe(盛り上がる曲.mediaId)
    expect(配送.pushedBgm.map((nowPlaying) => nowPlaying.track?.mediaId)).toEqual([盛り上がる曲.mediaId])
  })

  it('あらすじを作り直さなかった回は Jev を呼ばない（新しい材料が無ければ呼ばない）', async () => {
    const { db, store } = await 雑談の曲を流している配信()
    await saveBgmSettings(store, { judgeWithJev: false })
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(全部が成功する応答), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })
    await saveBgmSettings(store, { judgeWithJev: true })
    const jev = 曲を選ぶJev('t1')

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), jev, alerts: createFakeAlertChannel().namespace, broadcasterId: 配信者のID, now: 現在時刻 + 5 * 60 * 1000 })

    expect(jev.注文).toEqual([])
  })

  it('Jev が失敗しても収集は止めず、失敗を記録して曲はそのままにする', async () => {
    const { db, store } = await 雑談の曲を流している配信()
    const jev: JevClient = {
      decide: async () => {
        throw new Error('Jev が失敗を返しました（402）')
      },
    }

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(全部が成功する応答), jev, alerts: createFakeAlertChannel().namespace, broadcasterId: 配信者のID, now: 現在時刻 })

    expect((await loadBgmPlayback(store)).mediaId).toBe(雑談の曲.mediaId)
    const 失敗 = (await listFailures(db)).filter((failure) => failure.code === 'bgm-choice-failed')
    expect(失敗.map((failure) => failure.message)).toEqual([expect.stringContaining('402')])
    // あらすじのあとのサイドスーパーも作られている
    expect(await readSideSuper(db, 雑談配信.id)).not.toBeNull()
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
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(await readSideSuper(db, 雑談配信.id)).toEqual({
      lines: ['新作ゲーム', '初見プレイ中'],
      updatedAt: new Date(現在時刻).toISOString(),
    })
  })

  it('直近に画面へ現れた文字も材料にする', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    画面に現れた行を作る(db, '1枚目', 現在時刻 - 90 * 1000, 'ストームヴィル城')
    const ai = AIの代役('新作ゲーム\n城を攻略中')

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(ai.渡された材料('sideSuper').some((材料) => 材料.includes('ストームヴィル城'))).toBe(true)
  })

  it('前回のあとに画面へ新しい文字が現れていれば、喋りも発言も無くても作り直す', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(全部が成功する応答), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })
    const 五分後 = 現在時刻 + 5 * 60 * 1000
    // 撮ったのは前回サイドスーパーを作るより前で、篩を通って材料になったのはそのあと、という並びにする。
    // OCRの取得と篩は5分おきの収集で遅れて起きるので、実際にはこの並びが普通である
    画面に現れた行を作る(db, '1枚目', 現在時刻 - 60 * 1000, 'ストームヴィル城', 五分後 - 1000)
    const ai = AIの代役('新作ゲーム\n城を攻略中')

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 五分後 })

    expect(await readSideSuper(db, 雑談配信.id)).toEqual({ lines: ['新作ゲーム', '城を攻略中'], updatedAt: new Date(五分後).toISOString() })
  })

  it('配信していなければ、サイドスーパーを作らない', async () => {
    const { db, store } = await 環境を作る()

    await collectStats({
      db,
      store,
      twitch: Twitchの代役({ getLiveStream: async () => null }),
      ai: AIの代役(),
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(await readSideSuper(db, 雑談配信.id)).toBeNull()
  })

  it('前回作ったあとに新しい材料が無ければ、作り直さない', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(全部が成功する応答), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })
    const ai = AIの代役()

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 + 5 * 60 * 1000 })

    expect(ai.呼ばれた数()).toBe(0)
  })

  it('LLMが失敗しても収集は止めず、失敗を記録して前回のサイドスーパーを残す', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役('新作ゲーム\n初見プレイ中'), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-2', 雑談配信.id, new Date(現在時刻 + 60 * 1000).toISOString(), 'ボスに負けました')

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai: AIの代役(new Error('Workers AI の無料枠を使い切りました')),
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
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
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻,
    })

    expect(await readSideSuper(db, 雑談配信.id)).toBeNull()
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('side-super-failed')
  })
})

describe('collectStats（配信画面から読み取った文字の取得）', () => {
  /** 呼ばれた画像IDを覚え、決めておいた答えを返す Gyazo の代役 */
  const Gyazoの代役 = (答え: (imageId: string) => string | null | Error = () => '画面に出ていた文字') => {
    const 取りに行った: string[] = []
    return {
      取りに行った,
      fetchOcr: async (imageId: string) => {
        取りに行った.push(imageId)
        const 答 = 答え(imageId)
        if (答 instanceof Error) throw 答
        return 答
      },
    }
  }

  /** 配信中に1枚撮った状態を作る */
  const 撮った1枚を作る = async (db: ReturnType<typeof createFakeDatabase>, imageId = '画像1') => {
    await recordStreamOnline(db, { id: 雑談配信.id, startedAt: Date.parse(雑談配信.startedAt) })
    await recordScreenCapture(db, imageId, 現在時刻 - 60 * 1000)
  }

  it('まだ読み取っていない画像のOCRを取りに行き、取れた文字を記録する', async () => {
    const { db, store } = await 環境を作る()
    await 撮った1枚を作る(db)
    const gyazo = Gyazoの代役(() => '岩手17歳女性殺害事件')

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻, gyazo })

    expect(gyazo.取りに行った).toEqual(['画像1'])
    expect(await listPendingOcr(db, 10)).toEqual([])
    expect(db.sqlite.prepare('SELECT ocr_text FROM screen_captures').get()).toEqual({ ocr_text: '岩手17歳女性殺害事件' })
  })

  it('まだ生成されていなければ記録せず、次の収集に回す', async () => {
    const { db, store } = await 環境を作る()
    await 撮った1枚を作る(db)
    const gyazo = Gyazoの代役(() => null)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻, gyazo })

    expect(await listPendingOcr(db, 10)).toHaveLength(1)
    expect(await listFailures(db)).toEqual([])
  })

  it('取りに行っても生成されないままなら、上限で諦める', async () => {
    const { db, store } = await 環境を作る()
    await 撮った1枚を作る(db)
    const gyazo = Gyazoの代役(() => null)

    for (let 回 = 0; 回 < OCR_MAX_ATTEMPTS + 1; 回 += 1) {
      await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻, gyazo })
    }

    // 上限に達したあとの収集では、もう取りに行かない
    expect(gyazo.取りに行った).toHaveLength(OCR_MAX_ATTEMPTS)
  })

  it('Gyazo が失敗を返したら、失敗として記録したうえで収集そのものは続ける', async () => {
    const { db, store } = await 環境を作る()
    await 撮った1枚を作る(db)
    const gyazo = Gyazoの代役(() => new GyazoApiError(401, 'Gyazo からのOCRの取得が 401 で失敗しました: unauthorized'))

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻, gyazo })

    expect((await listFailures(db)).map((failure) => failure.code)).toContain('screen-ocr-failed')
    // 画面の文字が取れなくても、配信の記録は残す
    expect((await getSession(db, 雑談配信.id))?.samples).toHaveLength(1)
  })

  it('1枚目で失敗したら、残りは取りに行かない（同じ理由で続けて失敗するため）', async () => {
    const { db, store } = await 環境を作る()
    await 撮った1枚を作る(db, '画像1')
    await recordScreenCapture(db, '画像2', 現在時刻 - 30 * 1000)
    const gyazo = Gyazoの代役(() => new GyazoApiError(401, 'Gyazo からのOCRの取得が 401 で失敗しました: unauthorized'))

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻, gyazo })

    expect(gyazo.取りに行った).toEqual(['画像1'])
  })

  it('その画像が Gyazo から消えていたら（404）、その1枚だけを諦めて残りは取りに行く', async () => {
    const { db, store } = await 環境を作る()
    await 撮った1枚を作る(db, '消された画像')
    await recordScreenCapture(db, '残っている画像', 現在時刻 - 30 * 1000)
    const gyazo = Gyazoの代役((imageId) =>
      imageId === '消された画像' ? new GyazoApiError(404, 'Gyazo からのOCRの取得が 404 で失敗しました') : '画面に出ていた文字',
    )

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻, gyazo })

    expect(gyazo.取りに行った).toEqual(['消された画像', '残っている画像'])
    expect((await listFailures(db)).map((failure) => failure.code)).toContain('screen-ocr-failed')
    // 消された画像は、次の収集でもう取りに行かない（毎回そこで止まらないようにするため）
    expect(await listPendingOcr(db, 10)).toEqual([])
  })

  it('Gyazo のアクセストークンが無ければ、取りに行かない', async () => {
    const { db, store } = await 環境を作る()
    await 撮った1枚を作る(db)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(await listPendingOcr(db, 10)).toHaveLength(1)
    expect(await listFailures(db)).toEqual([])
  })
})

describe('collectStats（画面に新しく現れた文字の取り出し）', () => {
  /** 配信中に1枚撮り、その画面から読み取った文字まで用意する */
  const 読み取った1枚を作る = async (db: ReturnType<typeof createFakeDatabase>, 読み取った文字: string, imageId = '画像1') => {
    await recordStreamOnline(db, { id: 雑談配信.id, startedAt: Date.parse(雑談配信.startedAt) })
    await recordScreenCapture(db, imageId, 現在時刻 - 60 * 1000)
    await saveScreenOcr(db, imageId, 読み取った文字)
  }

  it('読み取った文字を篩に通し、残った行を積む', async () => {
    const { db, store } = await 環境を作る()
    await 読み取った1枚を作る(db, '岩手17歳女性殺害事件\nあ\n盛岡市のガソリンスタンド')

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    // 中身のない行（3文字未満）は落ちる
    expect(await readRecentScreenLines(db, 雑談配信.id, 10)).toEqual(['盛岡市のガソリンスタンド', '岩手17歳女性殺害事件'])
  })

  it('自前の文字（配信者の発話）は積まない', async () => {
    const { db, store } = await 環境を作る()
    await 読み取った1枚を作る(db, '岩手の事件について話します\n盛岡市のガソリンスタンド')
    await recordTranscript(db, { messageId: 't1', text: '岩手の事件について話します' }, 現在時刻 - 90 * 1000)

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(await readRecentScreenLines(db, 雑談配信.id, 10)).toEqual(['盛岡市のガソリンスタンド'])
  })

  it('同じ画面を撮り続けても、2枚目からは積まない', async () => {
    const { db, store } = await 環境を作る()
    await 読み取った1枚を作る(db, '岩手17歳女性殺害事件', '画像1')
    await recordScreenCapture(db, '画像2', 現在時刻 - 30 * 1000)
    // OCRは同じ画面でも毎回違う文字を返すので、完全一致では畳めない（「2008」→「2006」の実測と同じ形）
    await saveScreenOcr(db, '画像2', '岩手17歳女性殺書事件')

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(await readRecentScreenLines(db, 雑談配信.id, 10)).toEqual(['岩手17歳女性殺害事件'])
  })

  it('篩に通し終えた1枚は、次の収集で通し直さない', async () => {
    const { db, store } = await 環境を作る()
    await 読み取った1枚を作る(db, '岩手17歳女性殺害事件')

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })
    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻 })

    expect(db.sqlite.prepare('SELECT COUNT(*) AS 件数 FROM screen_lines').get()).toEqual({ 件数: 1 })
  })
})

describe('collectStats（1回ぶんの時間予算。issue #126）', () => {
  /** 配信中で、あらすじ・サイドスーパーの材料が揃っている状態を作る */
  const 配信中の材料を作る = (db: ReturnType<typeof createFakeDatabase>) => {
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, NULL, ?, ?)')
      .run(雑談配信.id, 雑談配信.startedAt, 雑談配信.title, 雑談配信.categoryName)
    db.sqlite
      .prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)')
      .run('hatsuwa-1', 雑談配信.id, new Date(現在時刻 - 2 * 60 * 1000).toISOString(), '今日は新しいゲームを遊びます')
  }

  /** 1回目は開始の時刻を返し、2回目以降は予算を使い切った時刻を返す時計 */
  const 予算を使い切る時計 = () => {
    let 回数 = 0
    return () => {
      回数 += 1
      return 回数 === 1 ? 現在時刻 : 現在時刻 + COLLECT_BUDGET_MS + 1
    }
  }

  it('予算を過ぎても、配信の記録（視聴者数・フォロワー数）は残す', async () => {
    const { db, store } = await 環境を作る()

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai: AIの代役(),
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻,
      clock: 予算を使い切る時計(),
    })

    expect(await listSessions(db, 現在時刻)).toHaveLength(1)
    expect(await listFollowerSamples(db)).toHaveLength(1)
  })

  it('予算を過ぎたら、材料づくり（あらすじ・サイドスーパー・人物像）は次の収集へ回す', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    const ai = AIの代役()

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai,
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻,
      clock: 予算を使い切る時計(),
    })

    expect(ai.呼ばれた数()).toBe(0)
    expect(await readStreamSummary(db, 雑談配信.id)).toBeNull()
    expect(await readSideSuper(db, 雑談配信.id)).toBeNull()
  })

  it('予算を過ぎたら、まだ読み取っていない画像のOCRは取りに行かない', async () => {
    const { db, store } = await 環境を作る()
    await recordStreamOnline(db, { id: 雑談配信.id, startedAt: Date.parse(雑談配信.startedAt) })
    await recordScreenCapture(db, '画像1', 現在時刻 - 120 * 1000)
    await recordScreenCapture(db, '画像2', 現在時刻 - 60 * 1000)
    const 取りに行った: string[] = []
    const gyazo = { fetchOcr: async (imageId: string) => (取りに行った.push(imageId), '画面に出ていた文字') }
    // 1枚目を取りに行ったところで予算を使い切る時計（開始の1回と、1枚目の前の1回までは予算内）
    let 回数 = 0
    const clock = () => {
      回数 += 1
      return 回数 <= 2 ? 現在時刻 : 現在時刻 + COLLECT_BUDGET_MS + 1
    }

    await collectStats({ db, store, twitch: Twitchの代役(), ai: AIの代役(), ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻, gyazo, clock })

    expect(取りに行った).toEqual(['画像1'])
  })

  it('予算で打ち切ったことを、何を次へ回したかとともに失敗として記録する', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai: AIの代役(),
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻,
      clock: 予算を使い切る時計(),
    })

    const 失敗 = await listFailures(db)
    expect(失敗).toHaveLength(1)
    expect(失敗[0]?.code).toBe('collect-budget-exceeded')
    expect(失敗[0]?.message).toContain('あらすじ')
  })

  it('あらすじを作っているあいだに予算を使い切ったら、サイドスーパーと人物像を次の収集へ回す', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    // 開始と、あらすじを作る前の1回までは予算内。そのあとは予算を使い切っている
    let 回数 = 0
    const clock = () => {
      回数 += 1
      return 回数 <= 2 ? 現在時刻 : 現在時刻 + COLLECT_BUDGET_MS + 1
    }
    const ai = AIの代役(全部が成功する応答)

    await collectStats({ db, store, twitch: Twitchの代役(), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻, clock })

    // あらすじは作られ、そのあとのサイドスーパーと人物像は次の収集へ回る
    expect(ai.呼ばれた数()).toBe(1)
    expect(await readStreamSummary(db, 雑談配信.id)).not.toBeNull()
    expect(await readSideSuper(db, 雑談配信.id)).toBeNull()
    const 失敗 = await listFailures(db)
    expect(失敗[0]?.message).toContain('サイドスーパー')
    expect(失敗[0]?.message).toContain('人物像')
    expect(失敗[0]?.message).not.toContain('あらすじ')
  })

  it('人物像は1人ごとに予算を見て、残りの人数を次の収集へ回す', async () => {
    const { db, store } = await 環境を作る()
    // 終わった配信で発言した2人ぶんの材料を置く（人物像はまだ無い）
    db.sqlite
      .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
      .run('owatta-haishin', new Date(現在時刻 - 60 * 60 * 1000).toISOString(), new Date(現在時刻 - 30 * 60 * 1000).toISOString(), '昨日の配信', 'Just Chatting')
    for (const { userId, 表示名 } of [
      { userId: '100', 表示名: '花子' },
      { userId: '200', 表示名: '太郎' },
    ]) {
      await recordViewerMessage(db, { userId, login: `user${userId}`, displayName: 表示名, badges: [], messageId: `chat-${userId}` }, 現在時刻 - 10 * 60 * 1000)
      db.sqlite
        .prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)')
        .run(`hatsugen-${userId}`, 'owatta-haishin', userId, new Date(現在時刻 - 45 * 60 * 1000).toISOString(), 'そのギターいいですね')
    }
    // 開始・人物像づくりの入口・1人目の前までは予算内で、2人目の前で予算を使い切っている
    let 回数 = 0
    const clock = () => {
      回数 += 1
      return 回数 <= 3 ? 現在時刻 : 現在時刻 + COLLECT_BUDGET_MS + 1
    }
    const ai = AIの代役()

    await collectStats({ db, store, twitch: Twitchの代役({ getLiveStream: async () => null }), ai, ...BGMの判定を使わない, broadcasterId: 配信者のID, now: 現在時刻, clock })

    expect(ai.呼ばれた数()).toBe(1)
    const 失敗 = await listFailures(db)
    expect(失敗[0]?.code).toBe('collect-budget-exceeded')
    expect(失敗[0]?.message).toContain('人物像（残り1人）')
  })

  it('予算のうちに終われば、何も打ち切らず失敗も残さない', async () => {
    const { db, store } = await 環境を作る()
    配信中の材料を作る(db)
    const ai = AIの代役(全部が成功する応答)

    await collectStats({
      db,
      store,
      twitch: Twitchの代役(),
      ai,
      ...BGMの判定を使わない, broadcasterId: 配信者のID,
      now: 現在時刻,
      clock: () => 現在時刻,
    })

    expect(ai.呼ばれた数()).toBeGreaterThan(0)
    expect(await listFailures(db)).toEqual([])
  })
})
