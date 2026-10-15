/**
 * チャットで推理のゲームの読み書き（worker/chat-deduction-store.ts）のテスト
 *
 * 開催中のゲームは1つだけで、開始の確かめを1つの文で行うこと、終えたゲームは二度と終えられないこと、
 * 報酬をONにできなかったときに開始を取り消せることを、migrations/ を適用したメモリ上の SQLite で確かめる（issue #375）。
 */
import { describe, expect, it } from 'vitest'
import { answerQuestion, cancelGame, endGame, failQuestion, readCurrentGame, readGame, readLatestGame, reserveQuestion, startGame } from './chat-deduction-store'
import { createFakeDatabase } from './fake-database'

const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const LATER = NOW + 10 * 60 * 1000

describe('ゲームの開始（startGame）', () => {
  it('問題のIDと開始の時刻を持つ、開催中のゲームを作る', async () => {
    const db = createFakeDatabase()

    const game = await startGame(db, 'mount-fuji', NOW)

    expect(game).toEqual({ id: 1, problemId: 'mount-fuji', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null })
    expect(await readCurrentGame(db)).toEqual(game)
  })

  it('ほかのゲームが開催中なら作らず null を返す（開催中のゲームは1つだけ）', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)

    expect(await startGame(db, 'natsume-soseki', LATER)).toBeNull()
    expect((await readCurrentGame(db))?.problemId).toBe('mount-fuji')
  })

  it('前のゲームを終えていれば、次のゲームを作れる', async () => {
    const db = createFakeDatabase()
    const first = await startGame(db, 'mount-fuji', NOW)
    await endGame(db, first!.id, 'stopped', LATER)

    expect((await startGame(db, 'natsume-soseki', LATER))?.problemId).toBe('natsume-soseki')
  })
})

describe('ゲームの終了（endGame）', () => {
  it('開催中のゲームを終わり方と時刻をつけて終え、開催中のゲームを無くす', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)

    const ended = await endGame(db, game!.id, 'stopped', LATER)

    expect(ended).toEqual({ ...game, endedAt: '2026-10-15T12:10:00.000Z', endReason: 'stopped' })
    expect(await readCurrentGame(db)).toBeNull()
    expect(await readLatestGame(db)).toEqual(ended)
  })

  it('もう終えたゲーム・無いゲームなら何も書かず null を返す', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)
    await endGame(db, game!.id, 'stopped', LATER)

    expect(await endGame(db, game!.id, 'stopped', LATER + 1000)).toBeNull()
    expect(await endGame(db, 999, 'stopped', LATER)).toBeNull()
    expect((await readLatestGame(db))?.endedAt).toBe('2026-10-15T12:10:00.000Z')
  })
})

describe('開始の取り消し（cancelGame）', () => {
  it('開催中のゲームの行を消し、何も始まらなかったことにする（報酬をONにできなかったとき）', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)

    await cancelGame(db, game!.id)

    expect(await readCurrentGame(db)).toBeNull()
    expect(await readLatestGame(db)).toBeNull()
  })
})

describe('最後のゲームの読み取り（readLatestGame）', () => {
  it('一度もゲームを開いていなければ null を返す', async () => {
    expect(await readLatestGame(createFakeDatabase())).toBeNull()
  })
})

describe('質問の受け付け（reserveQuestion）', () => {
  /** 上限は小さくして確かめる（1問あたり2件・同じ人の待ち時間は1分） */
  const LIMITS = { maxQuestionsPerGame: 2, cooldownMs: 60 * 1000 }
  /** 田中太郎さんの質問の交換 */
  const tanakaAsks = (redemptionId: string, question = '生き物ですか？') => ({
    redemptionId,
    userId: '田中太郎のユーザーID',
    userLogin: 'tanaka_taro',
    userName: '田中太郎',
    question,
  })
  const suzukiAsks = (redemptionId: string) => ({ ...tanakaAsks(redemptionId, '日本にありますか？'), userId: '鈴木花子のユーザーID', userLogin: 'suzuki_hanako', userName: '鈴木花子' })

  it('開催中のゲームがあれば、答え待ち（pending）として残し、ゲームのIDを添えて返す', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)

    const question = await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)

    expect(question).toEqual({
      id: 1,
      gameId: game!.id,
      redemptionId: '交換ID-1',
      userId: '田中太郎のユーザーID',
      userLogin: 'tanaka_taro',
      userName: '田中太郎',
      question: '生き物ですか？',
      status: 'pending',
      rejectReason: null,
      verdict: null,
      reply: null,
      failure: null,
      askedAt: '2026-10-15T12:00:00.000Z',
      settledAt: null,
    })
  })

  it('同じ交換のIDが再送されたら何も書かず null を返す（二重に答えない）', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)

    expect(await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW + 1000)).toBeNull()
  })

  it('開催中のゲームが無ければ、理由 no-game で受け付けなかった（rejected）として残す', async () => {
    const db = createFakeDatabase()

    const question = await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)

    expect(question).toMatchObject({ gameId: null, status: 'rejected', rejectReason: 'no-game', settledAt: '2026-10-15T12:00:00.000Z' })
  })

  it('1問あたりの上限に達していれば、理由 limit で受け付けない（受け付けなかった質問は数えない）', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)
    // 待ち時間の内に送った2件目は受け付けないので、上限の数には入らない
    expect(await reserveQuestion(db, tanakaAsks('交換ID-2'), LIMITS, NOW + 1000)).toMatchObject({ status: 'rejected', rejectReason: 'cooldown' })
    expect(await reserveQuestion(db, suzukiAsks('交換ID-3'), LIMITS, NOW + 2000)).toMatchObject({ status: 'pending' })

    expect(await reserveQuestion(db, tanakaAsks('交換ID-4'), LIMITS, LATER)).toMatchObject({ status: 'rejected', rejectReason: 'limit' })
  })

  it('答えられなかった（failed）質問は上限の数にも待ち時間にも入れない（ポイントを返したため）', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    const first = await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)
    await failQuestion(db, first!.id, 'LLMが失敗しました', NOW + 500)

    expect(await reserveQuestion(db, tanakaAsks('交換ID-2'), LIMITS, NOW + 1000)).toMatchObject({ status: 'pending' })
    expect(await reserveQuestion(db, suzukiAsks('交換ID-3'), LIMITS, NOW + 2000)).toMatchObject({ status: 'pending' })
  })

  it('同じ人でも待ち時間を過ぎていれば受け付ける', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)

    expect(await reserveQuestion(db, tanakaAsks('交換ID-2'), LIMITS, NOW + LIMITS.cooldownMs)).toMatchObject({ status: 'pending' })
  })

  it('前のゲームの質問は、次のゲームの上限にも待ち時間にも入れない', async () => {
    const db = createFakeDatabase()
    const first = await startGame(db, 'mount-fuji', NOW)
    await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)
    await reserveQuestion(db, suzukiAsks('交換ID-2'), LIMITS, NOW)
    await endGame(db, first!.id, 'stopped', NOW + 1000)
    await startGame(db, 'natsume-soseki', NOW + 2000)

    expect(await reserveQuestion(db, tanakaAsks('交換ID-3'), LIMITS, NOW + 3000)).toMatchObject({ status: 'pending' })
  })
})

describe('質問の答えと失敗の記録（answerQuestion・failQuestion）', () => {
  const LIMITS = { maxQuestionsPerGame: 30, cooldownMs: 60 * 1000 }
  const tanakaAsks = { redemptionId: '交換ID-1', userId: '田中太郎のユーザーID', userLogin: 'tanaka_taro', userName: '田中太郎', question: '日本にありますか？' }

  it('答え待ちの質問に、はい・いいえ・分からないと1文を書き、答えた（answered）にする', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    const question = await reserveQuestion(db, tanakaAsks, LIMITS, NOW)

    const answered = await answerQuestion(db, question!.id, { verdict: 'yes', reply: '静岡県と山梨県にまたがっています。' }, NOW + 3000)

    expect(answered).toMatchObject({ status: 'answered', verdict: 'yes', reply: '静岡県と山梨県にまたがっています。', settledAt: '2026-10-15T12:00:03.000Z' })
  })

  it('答えられなかった質問は、理由を残して失敗（failed）にする', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    const question = await reserveQuestion(db, tanakaAsks, LIMITS, NOW)

    const failed = await failQuestion(db, question!.id, 'LLMの返事が2行ではありませんでした', NOW + 3000)

    expect(failed).toMatchObject({ status: 'failed', failure: 'LLMの返事が2行ではありませんでした', verdict: null, settledAt: '2026-10-15T12:00:03.000Z' })
  })

  it('答え待ちでない質問には書かず null を返す（受け付けなかった・もう答えた質問を書き換えない）', async () => {
    const db = createFakeDatabase()
    const rejected = await reserveQuestion(db, tanakaAsks, LIMITS, NOW)

    expect(await answerQuestion(db, rejected!.id, { verdict: 'no', reply: '違います。' }, NOW)).toBeNull()
    expect(await failQuestion(db, rejected!.id, '失敗', NOW)).toBeNull()
  })
})

describe('ゲームの読み取り（readGame）', () => {
  it('IDでゲームを読む。無ければ null を返す', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)

    expect(await readGame(db, game!.id)).toEqual(game)
    expect(await readGame(db, 999)).toBeNull()
  })
})
