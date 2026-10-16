/**
 * チャットで推理のゲームの読み書き（worker/chat-deduction-store.ts）のテスト
 *
 * 開催中のゲームは1つだけで、開始の確かめを1つの文で行うこと、終えたゲームは二度と終えられないこと、
 * 報酬をONにできなかったときに開始を取り消せることを、migrations/ を適用したメモリ上の SQLite で確かめる（issue #375）。
 */
import { describe, expect, it } from 'vitest'
import {
  answerQuestion,
  cancelGame,
  endGame,
  failQuestion,
  markGuessWrong,
  readCurrentGame,
  readGame,
  readGameCards,
  readLatestGame,
  reserveGuess,
  reserveQuestion,
  solveGame,
  startGame,
} from './chat-deduction-store'
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
  /** 上限は小さくして確かめる（1問あたり2件） */
  const LIMITS = { maxQuestionsPerGame: 2 }
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

  it('1問あたりの上限に達していれば、理由 limit で受け付けない', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)
    expect(await reserveQuestion(db, suzukiAsks('交換ID-2'), LIMITS, NOW + 1000)).toMatchObject({ status: 'pending' })

    expect(await reserveQuestion(db, tanakaAsks('交換ID-3'), LIMITS, LATER)).toMatchObject({ status: 'rejected', rejectReason: 'limit' })
  })

  it('答えられなかった（failed）質問は上限の数に入れない（ポイントを返したため）', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    const first = await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)
    await failQuestion(db, first!.id, 'LLMが失敗しました', NOW + 500)

    expect(await reserveQuestion(db, tanakaAsks('交換ID-2'), LIMITS, NOW + 1000)).toMatchObject({ status: 'pending' })
    expect(await reserveQuestion(db, suzukiAsks('交換ID-3'), LIMITS, NOW + 2000)).toMatchObject({ status: 'pending' })
  })

  it('同じ人が続けて送った質問も、間を空けずに受け付ける', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    await reserveQuestion(db, tanakaAsks('交換ID-1'), LIMITS, NOW)

    expect(await reserveQuestion(db, tanakaAsks('交換ID-2', '山ですか？'), LIMITS, NOW + 1)).toMatchObject({ status: 'pending' })
  })

  it('前のゲームの質問は、次のゲームの上限に入れない', async () => {
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
  const LIMITS = { maxQuestionsPerGame: 30 }
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

describe('解答の受け付けと正誤の記録（reserveGuess・markGuessWrong・solveGame。issue #377）', () => {
  /** 田中太郎さんの解答の交換 */
  const tanakaGuesses = (redemptionId: string, guess = '富士山') => ({
    redemptionId,
    userId: '田中太郎のユーザーID',
    userLogin: 'tanaka_taro',
    userName: '田中太郎',
    guess,
  })
  const suzukiGuesses = (redemptionId: string) => ({ ...tanakaGuesses(redemptionId), userId: '鈴木花子のユーザーID', userLogin: 'suzuki_hanako', userName: '鈴木花子' })

  it('開催中のゲームがあれば、照合待ち（pending）として残し、ゲームのIDを添えて返す', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)

    const guess = await reserveGuess(db, tanakaGuesses('交換ID-1'), NOW)

    expect(guess).toEqual({
      id: 1,
      gameId: game!.id,
      redemptionId: '交換ID-1',
      userId: '田中太郎のユーザーID',
      userLogin: 'tanaka_taro',
      userName: '田中太郎',
      guess: '富士山',
      status: 'pending',
      rejectReason: null,
      guessedAt: '2026-10-15T12:00:00.000Z',
      settledAt: null,
    })
  })

  it('同じ交換のIDが再送されたら何も書かず null を返す（二重に照合しない）', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    await reserveGuess(db, tanakaGuesses('交換ID-1'), NOW)

    expect(await reserveGuess(db, tanakaGuesses('交換ID-1'), LATER)).toBeNull()
  })

  it('開催中のゲームが無ければ、理由 no-game で受け付けなかった（rejected）として残す', async () => {
    const db = createFakeDatabase()

    expect(await reserveGuess(db, tanakaGuesses('交換ID-1'), NOW)).toMatchObject({ gameId: null, status: 'rejected', rejectReason: 'no-game', settledAt: '2026-10-15T12:00:00.000Z' })
  })

  it('不正解の解答は、不正解（wrong）として残す', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)
    const guess = await reserveGuess(db, tanakaGuesses('交換ID-1', '阿蘇山'), NOW)

    expect(await markGuessWrong(db, guess!.id, LATER)).toMatchObject({ status: 'wrong', settledAt: new Date(LATER).toISOString() })
  })

  it('正解の解答は、正解（correct）にしたうえでゲームを solved で終える', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)
    const guess = await reserveGuess(db, tanakaGuesses('交換ID-1'), NOW)

    expect(await solveGame(db, guess!.id, LATER)).toMatchObject({ status: 'correct', settledAt: new Date(LATER).toISOString() })
    expect(await readGame(db, game!.id)).toMatchObject({ endedAt: new Date(LATER).toISOString(), endReason: 'solved' })
  })

  it('受けたあとにほかの人が先に正解したら、正解にせず理由 closed で受け付けなかったことにする（正解者は1人だけ）', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)
    // 2人の正解がほぼ同時に届き、どちらもゲームの開催中に受けた
    const tanaka = await reserveGuess(db, tanakaGuesses('交換ID-1'), NOW)
    const suzuki = await reserveGuess(db, suzukiGuesses('交換ID-2'), NOW)

    await solveGame(db, tanaka!.id, NOW + 1000)
    const late = await solveGame(db, suzuki!.id, NOW + 2000)

    expect(late).toMatchObject({ status: 'rejected', rejectReason: 'closed' })
    // ゲームを終えた時刻は先に正解した田中太郎さんのもの
    expect(await readGame(db, game!.id)).toMatchObject({ endedAt: new Date(NOW + 1000).toISOString(), endReason: 'solved' })
  })

  it('受けたあとに配信者がゲームを打ち切っていたら、正解にせず理由 closed で受け付けなかったことにする', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)
    const guess = await reserveGuess(db, tanakaGuesses('交換ID-1'), NOW)
    await endGame(db, game!.id, 'stopped', NOW + 1000)

    expect(await solveGame(db, guess!.id, LATER)).toMatchObject({ status: 'rejected', rejectReason: 'closed' })
    expect(await readGame(db, game!.id)).toMatchObject({ endReason: 'stopped' })
  })
})

describe('合成ページに並べるカードの読み取り（readGameCards。issue #378）', () => {
  const LIMITS = { maxQuestionsPerGame: 30 }
  /** 田中太郎さんの交換（質問・解答の両方に使う） */
  const tanaka = { userId: '田中太郎のユーザーID', userLogin: 'tanaka_taro', userName: '田中太郎' }
  const suzuki = { userId: '鈴木花子のユーザーID', userLogin: 'suzuki_hanako', userName: '鈴木花子' }

  it('答えた質問と正誤を決めた解答を、答え・正誤を決めた順に並べる', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)
    const first = await reserveQuestion(db, { ...tanaka, redemptionId: '交換ID-1', question: '生き物ですか？' }, LIMITS, NOW)
    const second = await reserveQuestion(db, { ...suzuki, redemptionId: '交換ID-2', question: '日本にありますか？' }, LIMITS, NOW + 1000)
    const wrong = await reserveGuess(db, { ...tanaka, redemptionId: '交換ID-3', guess: '琵琶湖' }, NOW + 2000)
    const correct = await reserveGuess(db, { ...suzuki, redemptionId: '交換ID-4', guess: '富士山' }, NOW + 3000)
    // 答えた順は受けた順と違ってよい（2つ目の質問のほうが先に答えが出た）
    await answerQuestion(db, second!.id, { verdict: 'yes', reply: '日本にあります。' }, NOW + 1500)
    await answerQuestion(db, first!.id, { verdict: 'no', reply: '生き物ではありません。' }, NOW + 1800)
    await markGuessWrong(db, wrong!.id, NOW + 2500)
    await solveGame(db, correct!.id, NOW + 3500)

    expect(await readGameCards(db, game!.id)).toEqual([
      { kind: 'question', id: second!.id, userName: '鈴木花子', text: '日本にありますか？', verdict: 'yes', reply: '日本にあります。' },
      { kind: 'question', id: first!.id, userName: '田中太郎', text: '生き物ですか？', verdict: 'no', reply: '生き物ではありません。' },
      { kind: 'guess', id: wrong!.id, userName: '田中太郎', text: '琵琶湖', correct: false },
      { kind: 'guess', id: correct!.id, userName: '鈴木花子', text: '富士山', correct: true },
    ])
  })

  it('答え待ち・失敗した・受け付けなかった質問と、照合待ち・受け付けなかった解答は並べない（ポイントを返したものは映さない）', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)
    await reserveQuestion(db, { ...tanaka, redemptionId: '交換ID-1', question: '答え待ちの質問' }, LIMITS, NOW)
    const failed = await reserveQuestion(db, { ...suzuki, redemptionId: '交換ID-2', question: 'LLM が答えられなかった質問' }, LIMITS, NOW)
    await failQuestion(db, failed!.id, 'LLM の返事が2行ではありません', NOW + 1000)
    await reserveGuess(db, { ...tanaka, redemptionId: '交換ID-3', guess: '照合待ちの解答' }, NOW)
    const late = await reserveGuess(db, { ...suzuki, redemptionId: '交換ID-4', guess: '富士山' }, NOW)
    await endGame(db, game!.id, 'stopped', NOW + 1000)
    await solveGame(db, late!.id, NOW + 2000)

    expect(await readGameCards(db, game!.id)).toEqual([])
  })

  it('ほかのゲームの質問と解答は並べない', async () => {
    const db = createFakeDatabase()
    const before = await startGame(db, 'mount-fuji', NOW)
    const question = await reserveQuestion(db, { ...tanaka, redemptionId: '交換ID-1', question: '生き物ですか？' }, LIMITS, NOW)
    await answerQuestion(db, question!.id, { verdict: 'no', reply: '生き物ではありません。' }, NOW)
    await endGame(db, before!.id, 'stopped', NOW + 1000)
    const after = await startGame(db, 'natsume-soseki', LATER)

    expect(await readGameCards(db, after!.id)).toEqual([])
  })
})
