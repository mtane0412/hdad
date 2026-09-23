/**
 * 視聴者ごとの記録の読み書き（viewer-store.ts）のテスト
 *
 * メモリ上のSQLite（fake-database.ts）に migrations/ を適用して確かめる。特に重要なのは次の3点。
 * - 初めて発言した人の行が作られ、2回目以降で最後に見た値が更新されること
 * - 同じ通知が再送されても、発言数が二重に増えないこと
 * - 書き込みの枠を節約するため、前回から一定時間が空くまで更新しないこと
 */
import { describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { deleteViewer, listViewers, readChatHistory, readViewer, recordViewerMessage, updateViewerNote } from './viewer-store'

const 現在時刻 = Date.UTC(2026, 8, 21, 12, 0, 0)
const 一分 = 60 * 1000

const 発言 = (上書き: Partial<Parameters<typeof recordViewerMessage>[1]> = {}) => ({
  userId: '100',
  login: 'hanako',
  displayName: '花子',
  badges: ['subscriber'],
  messageId: 'chat-message-1',
  ...上書き,
})

describe('recordViewerMessage', () => {
  it('初めて発言した人の行を作り、初回と最後の発言時刻に同じ値を入れる', async () => {
    const db = createFakeDatabase()

    await recordViewerMessage(db, 発言(), 現在時刻)

    const [viewer] = await listViewers(db, {})
    expect(viewer).toEqual({
      userId: '100',
      login: 'hanako',
      displayName: '花子',
      firstSeenAt: '2026-09-21T12:00:00.000Z',
      lastSeenAt: '2026-09-21T12:00:00.000Z',
      messageCount: 1,
      badges: ['subscriber'],
      note: '',
    })
  })

  it('バッジが1つも付いていない発言でも記録する', async () => {
    const db = createFakeDatabase()

    await recordViewerMessage(db, 発言({ badges: [] }), 現在時刻)

    const [viewer] = await listViewers(db, {})
    expect(viewer?.badges).toEqual([])
  })

  it('間隔が空いてからの2回目の発言で、最後の発言時刻・発言数・最後に見たバッジを更新する', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)

    await recordViewerMessage(db, 発言({ messageId: 'chat-message-2', badges: ['subscriber', 'vip'] }), 現在時刻 + 11 * 一分)

    const [viewer] = await listViewers(db, {})
    expect(viewer).toMatchObject({
      firstSeenAt: '2026-09-21T12:00:00.000Z',
      lastSeenAt: '2026-09-21T12:11:00.000Z',
      messageCount: 2,
      badges: ['subscriber', 'vip'],
    })
  })

  it('改名していれば、最後に見たログイン名と表示名を新しいものにする（照合には使わないので行は増やさない）', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)

    await recordViewerMessage(db, 発言({ messageId: 'chat-message-2', login: 'hanako2', displayName: '花子2' }), 現在時刻 + 11 * 一分)

    const viewers = await listViewers(db, {})
    expect(viewers).toHaveLength(1)
    expect(viewers[0]).toMatchObject({ login: 'hanako2', displayName: '花子2' })
  })

  it('前回の記録から10分経っていなければ、発言数を増やさない（D1の書き込みの枠を節約するため）', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)

    await recordViewerMessage(db, 発言({ messageId: 'chat-message-2' }), 現在時刻 + 9 * 一分)

    const [viewer] = await listViewers(db, {})
    expect(viewer).toMatchObject({ lastSeenAt: '2026-09-21T12:00:00.000Z', messageCount: 1 })
  })

  it('同じ通知が10分より後に再送されても、発言数を二重に増やさない', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)

    await recordViewerMessage(db, 発言(), 現在時刻 + 11 * 一分)

    const [viewer] = await listViewers(db, {})
    expect(viewer).toMatchObject({ messageCount: 1 })
  })

  it('別の人の発言なら、別の行を作る', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)

    await recordViewerMessage(db, 発言({ userId: '200', login: 'taro', displayName: '太郎', messageId: 'chat-message-2' }), 現在時刻)

    expect(await listViewers(db, {})).toHaveLength(2)
  })

  it('メモを書いた人が再び発言しても、メモは消えない', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)
    await updateViewerNote(db, '100', 'ゲームの話をよくする人')

    await recordViewerMessage(db, 発言({ messageId: 'chat-message-2' }), 現在時刻 + 11 * 一分)

    const [viewer] = await listViewers(db, {})
    expect(viewer?.note).toBe('ゲームの話をよくする人')
  })
})

describe('listViewers', () => {
  /** 名前と最後の発言時刻だけが違う人を並べる */
  const 三人を記録する = async (db: ReturnType<typeof createFakeDatabase>) => {
    await recordViewerMessage(db, 発言({ userId: '100', login: 'hanako', displayName: '花子', messageId: 'm1' }), 現在時刻)
    await recordViewerMessage(db, 発言({ userId: '200', login: 'hanabi', displayName: '花火', messageId: 'm2' }), 現在時刻 + 一分)
    await recordViewerMessage(db, 発言({ userId: '300', login: 'taro', displayName: '太郎', messageId: 'm3' }), 現在時刻 + 2 * 一分)
  }

  it('最後に発言した順（新しい順）に並べる', async () => {
    const db = createFakeDatabase()
    await 三人を記録する(db)

    expect((await listViewers(db, {})).map((viewer) => viewer.login)).toEqual(['taro', 'hanabi', 'hanako'])
  })

  it('ログイン名の前方一致で絞り込む', async () => {
    const db = createFakeDatabase()
    await 三人を記録する(db)

    expect((await listViewers(db, { loginPrefix: 'hana' })).map((viewer) => viewer.login)).toEqual(['hanabi', 'hanako'])
  })

  it('大文字で検索しても、ログイン名（小文字）に当てられる', async () => {
    const db = createFakeDatabase()
    await 三人を記録する(db)

    expect((await listViewers(db, { loginPrefix: 'HANA' })).map((viewer) => viewer.login)).toEqual(['hanabi', 'hanako'])
  })

  it('件数の上限を守る', async () => {
    const db = createFakeDatabase()
    await 三人を記録する(db)

    expect(await listViewers(db, { limit: 2 })).toHaveLength(2)
  })

  it('最後の発言日時が同じ人がページの境目にいても、続きで取りこぼさない', async () => {
    const db = createFakeDatabase()
    // チャットが活発なときは、別々の人の発言が同じミリ秒に記録されうる
    await recordViewerMessage(db, 発言({ userId: '100', login: 'ichiro', displayName: '一郎', messageId: 'm1' }), 現在時刻)
    await recordViewerMessage(db, 発言({ userId: '200', login: 'jiro', displayName: '二郎', messageId: 'm2' }), 現在時刻)
    await recordViewerMessage(db, 発言({ userId: '300', login: 'saburo', displayName: '三郎', messageId: 'm3' }), 現在時刻)

    const 一ページ目 = await listViewers(db, { limit: 2 })
    const 最後 = 一ページ目[一ページ目.length - 1]!
    const 続き = await listViewers(db, { before: 最後.lastSeenAt, beforeUserId: 最後.userId })

    expect([...一ページ目, ...続き].map((viewer) => viewer.userId).sort()).toEqual(['100', '200', '300'])
  })

  it('続きを読むときは、指定した時刻より前に発言した人だけを返す', async () => {
    const db = createFakeDatabase()
    await 三人を記録する(db)

    const 続き = await listViewers(db, { before: '2026-09-21T12:01:00.000Z' })

    expect(続き.map((viewer) => viewer.login)).toEqual(['hanako'])
  })
})

describe('readViewer', () => {
  it('ユーザーIDでその人ひとりの記録を返す（LLMに渡す材料を読むのに使う）', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)
    await updateViewerNote(db, '100', 'ギターの話が好き')

    expect(await readViewer(db, '100')).toEqual({
      userId: '100',
      login: 'hanako',
      displayName: '花子',
      firstSeenAt: '2026-09-21T12:00:00.000Z',
      lastSeenAt: '2026-09-21T12:00:00.000Z',
      messageCount: 1,
      badges: ['subscriber'],
      note: 'ギターの話が好き',
    })
  })

  it('記録のない人には null を返す', async () => {
    expect(await readViewer(createFakeDatabase(), '999')).toBeNull()
  })
})

describe('updateViewerNote', () => {
  it('記録のある人のメモを書き換える', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)

    expect(await updateViewerNote(db, '100', '常連さん')).toBe(true)
    const [viewer] = await listViewers(db, {})
    expect(viewer?.note).toBe('常連さん')
  })

  it('記録のない人なら false を返す（呼び出し側が404にできるようにするため）', async () => {
    const db = createFakeDatabase()

    expect(await updateViewerNote(db, '999', '常連さん')).toBe(false)
  })
})

describe('deleteViewer', () => {
  it('記録のある人を消す', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)

    expect(await deleteViewer(db, '100')).toBe(true)
    expect(await listViewers(db, {})).toEqual([])
  })

  it('記録のない人なら false を返す', async () => {
    const db = createFakeDatabase()

    expect(await deleteViewer(db, '999')).toBe(false)
  })
})

describe('readChatHistory', () => {
  const 一日 = 24 * 60 * 一分

  it('記録が1件もない人なら、このチャンネルで初めての発言として返す', async () => {
    const db = createFakeDatabase()

    expect(await readChatHistory(db, { userId: '100', messageId: 'chat-message-1' }, 現在時刻)).toEqual({
      firstChatEver: true,
      daysSinceLastChat: null,
    })
  })

  it('記録を作った発言と同じ発言IDなら、再送されても初めての発言として返す', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)

    expect(await readChatHistory(db, { userId: '100', messageId: 'chat-message-1' }, 現在時刻 + 一分)).toEqual({
      firstChatEver: true,
      daysSinceLastChat: null,
    })
  })

  it('同じ人の2回目以降の発言は、初めての発言ではないとして返す', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)
    await recordViewerMessage(db, 発言({ messageId: 'chat-message-2' }), 現在時刻 + 11 * 一分)

    expect(await readChatHistory(db, { userId: '100', messageId: 'chat-message-2' }, 現在時刻 + 11 * 一分)).toEqual({
      firstChatEver: false,
      daysSinceLastChat: 11 * 一分 / 一日,
    })
  })

  it('記録を更新した発言なら、その発言が空けた間隔を返す', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)

    await recordViewerMessage(db, 発言({ messageId: 'chat-message-2' }), 現在時刻 + 30 * 一日)

    expect(await readChatHistory(db, { userId: '100', messageId: 'chat-message-2' }, 現在時刻 + 30 * 一日)).toEqual({
      firstChatEver: false,
      daysSinceLastChat: 30,
    })
  })

  it('同じ通知が再送されても、空けた間隔の答えを変えない（1通目が途中で失敗していてもアラートが鳴るようにするため）', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)
    await recordViewerMessage(db, 発言({ messageId: 'chat-message-2' }), 現在時刻 + 30 * 一日)

    // 再送では記録を更新しないので（last_message_id が同じ）、last_seen_at は30日後のまま据え置かれる
    await recordViewerMessage(db, 発言({ messageId: 'chat-message-2' }), 現在時刻 + 30 * 一日 + 一分)

    expect(await readChatHistory(db, { userId: '100', messageId: 'chat-message-2' }, 現在時刻 + 30 * 一日 + 一分)).toEqual({
      firstChatEver: false,
      daysSinceLastChat: 30,
    })
  })

  it('間隔を空けるために記録しなかった発言では、いまの最後の発言時刻からの短い間隔を返す（久しぶりの発言に続く連投で二度当てはまらないようにするため）', async () => {
    const db = createFakeDatabase()
    await recordViewerMessage(db, 発言(), 現在時刻)
    // 30日ぶりの発言。これは記録され、30日の間隔が読める
    await recordViewerMessage(db, 発言({ messageId: 'chat-message-2' }), 現在時刻 + 30 * 一日)
    // その1分後の発言。10分経っていないので記録されない
    await recordViewerMessage(db, 発言({ messageId: 'chat-message-3' }), 現在時刻 + 30 * 一日 + 一分)

    expect(await readChatHistory(db, { userId: '100', messageId: 'chat-message-3' }, 現在時刻 + 30 * 一日 + 一分)).toEqual({
      firstChatEver: false,
      daysSinceLastChat: 一分 / 一日,
    })
  })

  it('この列を足す前からある行（記録を作った発言のIDを持たない）は、初めての発言ではないとして返す', async () => {
    const db = createFakeDatabase()
    db.sqlite
      .prepare(
        `INSERT INTO viewers (user_id, login, display_name, first_seen_at, last_seen_at, message_count, last_badges, last_message_id, first_message_id)
         VALUES ('100', 'hanako', '花子', '2026-08-01T12:00:00.000Z', '2026-08-01T12:00:00.000Z', 5, '', 'chat-message-0', '')`,
      )
      .run()

    expect(await readChatHistory(db, { userId: '100', messageId: 'chat-message-1' }, 現在時刻)).toEqual({
      firstChatEver: false,
      daysSinceLastChat: 51,
    })
  })
})
