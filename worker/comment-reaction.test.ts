/**
 * 配信者の発話からのコメントへの反応の判定（comment-reaction.ts）のテスト
 *
 * 確定した発話を受け取るたびに、直前の数文の発話とまだ未読の視聴者の発言を Jev に渡し、発言ごとに
 * 「この発話はその発言への反応か」を判定させる。ここで確かめるのは次の点である。
 * - Jev へ渡す材料と質問の形（発言1件につき Noul を1問。質問の中に名前と本文を含める）
 * - しきい値以上と判定された発言だけを、Jev が付けた既読として記録し、画面へ知らせること
 * - 未読の発言が1件も無ければ Jev を呼ばないこと（新しい材料が無ければ呼ばない）
 * - Jev が失敗したら、黙って捨てずに投げること（呼び出し側が失敗として記録する）
 */
import { describe, expect, it } from 'vitest'
import { buildReactionRequest, judgeCommentReactions, REACTION_THRESHOLD } from './comment-reaction'
import { recordCommentRead } from './comment-read-store'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import type { JevAnswers, JevClient, JevQuestion, JevRequest, JevUsage } from './jev'

const broadcasterId = '999'
const now = Date.parse('2026-09-29T12:00:00.000Z')

describe('buildReactionRequest', () => {
  it('直前の発話と未読の発言を材料にし、発言ごとに「その発言への反応か」を尋ねる', () => {
    const request = buildReactionRequest(
      ['えーっと', '何時までかって聞かれたんだけど', '今日は11時くらいまでかな'],
      [
        { messageId: 'こうさんの質問', name: 'こう', text: '何時まで配信？' },
        { messageId: 'めいさんの感想', name: 'めい', text: 'このキャラ好き' },
      ],
    )

    expect(request.state).toEqual({
      transcript: ['えーっと', '何時までかって聞かれたんだけど', '今日は11時くらいまでかな'],
      recent_chat: [
        { user: 'こう', text: '何時まで配信？' },
        { user: 'めい', text: 'このキャラ好き' },
      ],
    })
    expect(Object.keys(request.questions)).toEqual(['c0', 'c1'])
    // 質問の名前はモデルに伝わらないので、誰のどの発言かを質問の中に書く
    expect(request.questions.c0).toMatchObject({ type: 'noul', instructions: expect.stringContaining('視聴者「こう」のチャット「何時まで配信？」') })
    expect(request.questions.c1).toMatchObject({ type: 'noul', instructions: expect.stringContaining('視聴者「めい」のチャット「このキャラ好き」') })
    // 境目があいまいな判定なので、「はい」「いいえ」に当たる場合を書く
    expect(request.questions.c0).toHaveProperty('criteria.true')
    expect(request.questions.c0).toHaveProperty('criteria.false')
  })
})

/** Jev の代役。渡された注文を控え、決めた確率を順に返す（c0 から順に） */
const fakeJev = (probability: readonly number[]): JevClient & { requestBody: JevRequest<Record<string, JevQuestion>>[]; spots: JevUsage[] } => {
  const requestBody: JevRequest<Record<string, JevQuestion>>[] = []
  const spots: JevUsage[] = []
  return {
    requestBody,
    spots,
    decide: async <Qs extends Readonly<Record<string, JevQuestion>>>(usage: JevUsage, request: JevRequest<Qs>): Promise<JevAnswers<Qs>> => {
      spots.push(usage)
      requestBody.push(request)
      // Noul の答えは確率そのもの。質問の名前（c0, c1…）の順に決めた確率を返す
      return Object.fromEntries(Object.keys(request.questions).map((name, index) => [name, probability[index]])) as JevAnswers<Qs>
    },
  }
}

/** いま進んでいる配信・視聴者・発言・発話を用意する */
const seedStreamMaterial = () => {
  const db = createFakeDatabase()
  db.sqlite
    .prepare('INSERT INTO stream_sessions (id, started_at, ended_at, title, category_name) VALUES (?, ?, ?, ?, ?)')
    .run('いまの配信', '2026-09-29T11:00:00.000Z', null, '雑談', 'Just Chatting')
  const viewers = [
    ['111', 'たなか'],
    ['222', 'すずき'],
  ] as const
  for (const [userId, name] of viewers) {
    db.sqlite
      .prepare(
        `INSERT INTO viewers (user_id, login, display_name, first_seen_at, last_seen_at, message_count, last_badges, last_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, `login_${userId}`, name, '2026-09-01T00:00:00.000Z', '2026-09-29T12:00:00.000Z', 1, '[]', '')
  }
  const message = (messageId: string, userId: string, sentAt: string, text: string) =>
    db.sqlite.prepare('INSERT INTO stream_chat_messages (message_id, session_id, user_id, sent_at, text) VALUES (?, ?, ?, ?, ?)').run(messageId, 'いまの配信', userId, sentAt, text)
  const utterance = (messageId: string, spokenAt: string, text: string) =>
    db.sqlite.prepare('INSERT INTO transcripts (message_id, session_id, spoken_at, text) VALUES (?, ?, ?, ?)').run(messageId, 'いまの配信', spokenAt, text)
  return { db, message, utterance }
}

/** 記録された既読の行を読む */
const readRows = (db: ReturnType<typeof createFakeDatabase>) =>
  db.sqlite.prepare('SELECT message_id, read, marked_by FROM comment_reads ORDER BY message_id').all()

describe('judgeCommentReactions', () => {
  it('しきい値以上と判定された発言だけを、Jev が付けた既読として記録し、画面へ知らせる', async () => {
    const { db, message, utterance } = seedStreamMaterial()
    message('たなかさんの挨拶', '111', '2026-09-29T11:58:00.000Z', '初見です')
    message('すずきさんの感想', '222', '2026-09-29T11:59:00.000Z', 'ボス強そう')
    utterance('発話1', '2026-09-29T12:00:00.000Z', 'あ、たなかさん初見ありがとうございます！')
    const jev = fakeJev([0.93, 0.32])
    const deliveryTarget = createFakeCommentChannel()

    await judgeCommentReactions({ db, jev, comments: deliveryTarget.namespace, broadcasterId, now, transcriptMessageId: '発話1' })

    expect(jev.spots).toEqual(['commentReaction'])
    expect(readRows(db)).toEqual([{ message_id: 'たなかさんの挨拶', read: 1, marked_by: 'jev' }])
    expect(deliveryTarget.pushedItems).toEqual([
      { kind: 'read', id: expect.any(String), at: now, messageId: 'たなかさんの挨拶', read: true, by: 'jev' },
    ])
  })

  it('しきい値ちょうどは反応したものとして扱う', async () => {
    const { db, message, utterance } = seedStreamMaterial()
    message('すずきさんの質問', '222', '2026-09-29T11:59:00.000Z', 'このBGMなんて曲？')
    utterance('発話1', '2026-09-29T12:00:00.000Z', 'BGMはね、フリー素材のやつ使ってます')

    await judgeCommentReactions({ db, jev: fakeJev([REACTION_THRESHOLD]), comments: createFakeCommentChannel().namespace, broadcasterId, now, transcriptMessageId: '発話1' })

    expect(readRows(db)).toEqual([{ message_id: 'すずきさんの質問', read: 1, marked_by: 'jev' }])
  })

  it('直前の数文の発話を、喋った順に材料として渡す（返事は複数の文にまたがるため）', async () => {
    const { db, message, utterance } = seedStreamMaterial()
    message('すずきさんの質問', '222', '2026-09-29T11:57:00.000Z', '何時まで配信？')
    utterance('発話1', '2026-09-29T11:58:00.000Z', 'よし、次のステージ行きます')
    utterance('発話2', '2026-09-29T11:59:00.000Z', 'えーっと')
    utterance('発話3', '2026-09-29T11:59:30.000Z', '何時までかって聞かれたんだけど')
    utterance('発話4', '2026-09-29T12:00:00.000Z', '今日は11時くらいまでかな')
    const jev = fakeJev([0.93])

    await judgeCommentReactions({ db, jev, comments: createFakeCommentChannel().namespace, broadcasterId, now, transcriptMessageId: '発話4' })

    expect(jev.requestBody[0]?.state).toMatchObject({ transcript: ['えーっと', '何時までかって聞かれたんだけど', '今日は11時くらいまでかな'] })
  })

  it('きっかけの発話より後に届いた発話は材料に混ぜない（判定は応答のあとに回るので、そのあいだに次の発話が届くことがある）', async () => {
    const { db, message, utterance } = seedStreamMaterial()
    message('たなかさんの挨拶', '111', '2026-09-29T11:58:00.000Z', '初見です')
    utterance('発話1', '2026-09-29T11:59:00.000Z', 'あ、たなかさん初見ありがとうございます！')
    utterance('発話2', '2026-09-29T12:00:00.000Z', 'よし、次のステージ行きます')
    const jev = fakeJev([0.93])

    await judgeCommentReactions({ db, jev, comments: createFakeCommentChannel().namespace, broadcasterId, now, transcriptMessageId: '発話1' })

    expect(jev.requestBody[0]?.state).toMatchObject({ transcript: ['あ、たなかさん初見ありがとうございます！'] })
  })

  it('未読の発言が1件も無ければ、Jev を呼ばない（新しい材料が無ければ呼ばない）', async () => {
    const { db, message, utterance } = seedStreamMaterial()
    message('たなかさんの挨拶', '111', '2026-09-29T11:58:00.000Z', '初見です')
    await recordCommentRead(db, { messageId: 'たなかさんの挨拶', read: true, by: 'manual' }, now)
    utterance('発話1', '2026-09-29T12:00:00.000Z', 'よし、次のステージ行きます')
    const jev = fakeJev([])

    await judgeCommentReactions({ db, jev, comments: createFakeCommentChannel().namespace, broadcasterId, now, transcriptMessageId: '発話1' })

    expect(jev.requestBody).toEqual([])
  })

  it('候補にするのは直近の発言だけで、少し前の発言は Jev に渡さない', async () => {
    const { db, message, utterance } = seedStreamMaterial()
    message('ずっと前の発言', '111', '2026-09-29T11:30:00.000Z', 'さっきの話')
    message('いまの発言', '222', '2026-09-29T11:59:00.000Z', 'ボス強そう')
    utterance('発話1', '2026-09-29T12:00:00.000Z', 'このボス第二形態あるんだよなあ')
    const jev = fakeJev([0.1])

    await judgeCommentReactions({ db, jev, comments: createFakeCommentChannel().namespace, broadcasterId, now, transcriptMessageId: '発話1' })

    expect(jev.requestBody[0]?.state).toMatchObject({ recent_chat: [{ user: 'すずき', text: 'ボス強そう' }] })
  })

  it('画面へ知らせられなければ、Jev が付けた既読を取り消して投げる（次の発話の判定で、候補に戻して知らせ直せるようにする）', async () => {
    const { db, message, utterance } = seedStreamMaterial()
    message('たなかさんの挨拶', '111', '2026-09-29T11:58:00.000Z', '初見です')
    utterance('発話1', '2026-09-29T12:00:00.000Z', 'あ、たなかさん初見ありがとうございます！')
    const failingDeliveryTarget = createFakeCommentChannel({ shouldFail: true })

    await expect(
      judgeCommentReactions({ db, jev: fakeJev([0.93]), comments: failingDeliveryTarget.namespace, broadcasterId, now, transcriptMessageId: '発話1' }),
    ).rejects.toThrow('配送先へ送れませんでした')
    expect(readRows(db)).toEqual([])
  })

  it('Jev が失敗したら、黙って捨てずに投げる（呼び出し側が失敗として記録する）', async () => {
    const { db, message, utterance } = seedStreamMaterial()
    message('たなかさんの挨拶', '111', '2026-09-29T11:58:00.000Z', '初見です')
    utterance('発話1', '2026-09-29T12:00:00.000Z', 'あ、たなかさん初見ありがとうございます！')
    const failingJev: JevClient = {
      decide: async () => {
        throw new Error('Jev が失敗を返しました（402 typesafe/jev-1.13）')
      },
    }

    await expect(
      judgeCommentReactions({ db, jev: failingJev, comments: createFakeCommentChannel().namespace, broadcasterId, now, transcriptMessageId: '発話1' }),
    ).rejects.toThrow('402')
    expect(readRows(db)).toEqual([])
  })
})
