/**
 * Jev の呼び出し（jev.ts）のテスト
 *
 * Jev は TypeSafe の判定用のモデルで、OpenRouter の Decisions API から呼ぶ。材料（state）と質問を渡すと、
 * 質問ごとに型の決まった答え（Noul なら yes の確率）が返る。ここで確かめるのは次の点である。
 * - Decisions API へ、固定のモデル名・材料・質問を鍵付きで送ること
 * - Noul・Choice・Score の答えを、質問の型に合った形で返すこと
 * - 鍵が無い・失敗が返った・答えが欠けている・型が違う場合に、黙って既定値にせず投げること
 * - 呼び出しの使用状況を、成功でも失敗でも llm_usage に記録すること（LLM と同じ表に並べるため）
 * - 使用状況の記録に失敗しても、判定の結果はそのまま返し、失敗を collection_failures に残すこと
 * - Jev が応答を返さないとき、待ち続けずに TimeoutError にすること
 */
import { describe, expect, it } from 'vitest'
import { createFakeDatabase } from './fake-database'
import { createJev, JEV_MODEL, type JevOptions } from './jev'
import { TimeoutError } from './timeout'

const 現在時刻 = Date.parse('2026-09-29T01:23:45.000Z')

/** OpenRouter の応答の代役。渡されたリクエストを控える */
const 通信の代役 = (応答: Response): typeof fetch & { 呼ばれた: Request[] } => {
  const 呼ばれた: Request[] = []
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    呼ばれた.push(new Request(input as RequestInfo, init))
    return Promise.resolve(応答)
  }
  return Object.assign(impl as typeof fetch, { 呼ばれた })
}

/** Jev の応答（実際に返ってきた形を写したもの） */
const Jevの応答 = (answers: Record<string, unknown>, usage: Record<string, unknown> = { input_tokens: 967, output_tokens: 55, cost: 0.000040614 }): Response =>
  Response.json({ id: 'gen-dec-テスト', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', answers, usage })

/** 組み立てに要るもの。テストごとに通信とデータベースだけ差し替える */
const 条件 = (fetchImpl: typeof fetch, 上書き: Partial<JevOptions> = {}): JevOptions => ({
  fetch: fetchImpl,
  apiKey: 'openrouter-test-key',
  db: createFakeDatabase(),
  now: () => 現在時刻,
  ...上書き,
})

/** 配信者の発話が、そのコメントへの反応かを尋ねる質問 */
const 反応の質問 = {
  reacted: {
    type: 'noul' as const,
    instructions: '配信者の直近の発話（`transcript`）は、視聴者「たなか」のチャット「初見です」に対する反応ですか。',
    criteria: { true: '返事・お礼・答えなどで応じている', false: '応じていない' },
  },
}
const 反応の材料 = { transcript: ['あ、たなかさん初見ありがとうございます！'], recent_chat: [{ user: 'たなか', text: '初見です' }] }

describe('createJev（送るもの）', () => {
  it('Decisions API へ、固定のモデル名・材料・質問を鍵付きで送る', async () => {
    const fetchImpl = 通信の代役(Jevの応答({ reacted: { type: 'noul', noul: 0.93 } }))
    const jev = createJev(条件(fetchImpl))

    await jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })

    const [リクエスト] = fetchImpl.呼ばれた
    expect(リクエスト?.url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(リクエスト?.method).toBe('POST')
    expect(リクエスト?.headers.get('Authorization')).toBe('Bearer openrouter-test-key')
    expect(await リクエスト?.json()).toEqual({ model: JEV_MODEL, state: 反応の材料, questions: 反応の質問 })
  })

  it('モデルは版を固定した名前にする（しきい値は版ごとに観察して決めるため、中身が黙って変わる latest は使わない）', () => {
    expect(JEV_MODEL).toBe('typesafe/jev-1.13')
  })
})

describe('createJev（答えの読み取り）', () => {
  it('Noul の答えは yes の確率（数）で返す', async () => {
    const jev = createJev(条件(通信の代役(Jevの応答({ reacted: { type: 'noul', noul: 0.93 } }))))

    expect(await jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })).toEqual({ reacted: 0.93 })
  })

  it('Choice の答えは選ばれた選択肢と確信度で返す', async () => {
    const 応答 = Jevの応答({ tone: { type: 'choice', choice: 'question', confidence: 0.81, probabilities: { question: 0.81, greeting: 0.19 } } })
    const jev = createJev(条件(通信の代役(応答)))

    const 答え = await jev.decide('commentReaction', {
      state: 'このBGMなんて曲？',
      questions: { tone: { type: 'choice', instructions: 'このチャットは何をしていますか。', criteria: { question: '質問している', greeting: '挨拶している' } } },
    })

    expect(答え).toEqual({ tone: { choice: 'question', confidence: 0.81 } })
  })

  it('Score の答えは段階の位置と確信度で返す', async () => {
    const 応答 = Jevの応答({ urgency: { type: 'score', score: 1.99, confidence: 0.7, legend: { 0: '急がない', 1: 'ふつう', 2: '急ぐ' } } })
    const jev = createJev(条件(通信の代役(応答)))

    const 答え = await jev.decide('commentReaction', {
      state: '音ズレしてる？',
      questions: { urgency: { type: 'score', instructions: 'このチャットにどれだけ早く応じるべきですか。', criteria: ['急がない', 'ふつう', '急ぐ'] } },
    })

    expect(答え).toEqual({ urgency: { score: 1.99, confidence: 0.7 } })
  })

  it('確信度が返ってこなければ null にする（API では省かれうる項目なので、0 に丸めて確信が無いことにしない）', async () => {
    const jev = createJev(条件(通信の代役(Jevの応答({ tone: { type: 'choice', choice: 'greeting' } }))))

    const 答え = await jev.decide('commentReaction', {
      state: 'こんばんは',
      questions: { tone: { type: 'choice', instructions: 'このチャットは何をしていますか。', criteria: { question: '質問している', greeting: '挨拶している' } } },
    })

    expect(答え).toEqual({ tone: { choice: 'greeting', confidence: null } })
  })
})

describe('createJev（失敗）', () => {
  it('鍵が無ければ、呼ばずに投げる', async () => {
    const fetchImpl = 通信の代役(Jevの応答({ reacted: { type: 'noul', noul: 0.93 } }))
    const jev = createJev(条件(fetchImpl, { apiKey: undefined }))

    await expect(jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })).rejects.toThrow('OPENROUTER_API_KEY')
    expect(fetchImpl.呼ばれた).toHaveLength(0)
  })

  it('質問が1つも無ければ、呼ばずに投げる（判定するものが無いのに料金だけ払わない）', async () => {
    const fetchImpl = 通信の代役(Jevの応答({}))
    const jev = createJev(条件(fetchImpl))

    await expect(jev.decide('commentReaction', { state: 反応の材料, questions: {} })).rejects.toThrow('質問')
    expect(fetchImpl.呼ばれた).toHaveLength(0)
  })

  it('OpenRouter が失敗を返したら、状態コードと本文を添えて投げる', async () => {
    const jev = createJev(条件(通信の代役(new Response('{"error":{"message":"Insufficient credits"}}', { status: 402 }))))

    await expect(jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })).rejects.toThrow(/402.*Insufficient credits/s)
  })

  it('頼んだ質問の答えが欠けていたら投げる（欠けた答えを「いいえ」として扱わない）', async () => {
    const jev = createJev(条件(通信の代役(Jevの応答({}))))

    await expect(jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })).rejects.toThrow('reacted')
  })

  it('答えの型が質問の型と違ったら投げる', async () => {
    const jev = createJev(条件(通信の代役(Jevの応答({ reacted: { type: 'choice', choice: 'yes' } }))))

    await expect(jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })).rejects.toThrow('reacted')
  })

  it('Noul の確率が 0〜1 の数でなければ投げる', async () => {
    const jev = createJev(条件(通信の代役(Jevの応答({ reacted: { type: 'noul', noul: 1.5 } }))))

    await expect(jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })).rejects.toThrow('reacted')
  })

  it('Choice の答えが選択肢に無い名前なら投げる', async () => {
    const jev = createJev(条件(通信の代役(Jevの応答({ tone: { type: 'choice', choice: 'complaint' } }))))

    await expect(
      jev.decide('commentReaction', {
        state: 'こんばんは',
        questions: { tone: { type: 'choice', instructions: 'このチャットは何をしていますか。', criteria: { question: '質問している', greeting: '挨拶している' } } },
      }),
    ).rejects.toThrow('complaint')
  })

  it('Jev が応答を返さないと、待ち続けずに TimeoutError にする', async () => {
    const fetchImpl = (async () => await new Promise<Response>(() => undefined)) as typeof fetch
    const jev = createJev(条件(fetchImpl, { timeoutMs: 10 }))

    await expect(jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })).rejects.toBeInstanceOf(TimeoutError)
  })
})

describe('createJev（使用状況の記録）', () => {
  /** 記録された行を読む（テーブルの中身をそのまま確かめる） */
  const 記録を読む = (db: ReturnType<typeof createFakeDatabase>) =>
    db.sqlite.prepare('SELECT day, usage, provider, model, calls, failures, prompt_tokens, completion_tokens, cost_usd FROM llm_usage').all()

  it('応答に入っていたトークン数と実費を、LLM と同じ表へ箇所ごとに記録する', async () => {
    const db = createFakeDatabase()
    const jev = createJev(条件(通信の代役(Jevの応答({ reacted: { type: 'noul', noul: 0.93 } })), { db }))

    await jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })

    expect(記録を読む(db)).toEqual([
      {
        day: '2026-09-29',
        usage: 'commentReaction',
        provider: 'openrouter',
        model: JEV_MODEL,
        calls: 1,
        failures: 0,
        prompt_tokens: 967,
        completion_tokens: 55,
        cost_usd: 0.000040614,
      },
    ])
  })

  it('失敗した呼び出しも数える', async () => {
    const db = createFakeDatabase()
    const jev = createJev(条件(通信の代役(new Response('Internal Server Error', { status: 500 })), { db }))

    await expect(jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })).rejects.toThrow('500')
    expect(記録を読む(db)).toMatchObject([{ usage: 'commentReaction', provider: 'openrouter', calls: 0, failures: 1 }])
  })

  it('記録に失敗しても判定の結果はそのまま返し、失敗を collection_failures に残す', async () => {
    const 本物 = createFakeDatabase()
    // 使用状況の記録だけが失敗するデータベース（D1の書き込みの枠を使い切った場合の再現）
    const db = {
      ...本物,
      prepare: (sql: string) => {
        if (sql.includes('llm_usage')) throw new Error('D1の書き込みの枠を使い切りました')
        return 本物.prepare(sql)
      },
    }
    const jev = createJev(条件(通信の代役(Jevの応答({ reacted: { type: 'noul', noul: 0.93 } })), { db }))

    expect(await jev.decide('commentReaction', { state: 反応の材料, questions: 反応の質問 })).toEqual({ reacted: 0.93 })
    expect(本物.sqlite.prepare('SELECT code, message FROM collection_failures').all()).toMatchObject([
      { code: 'llm-usage-record-failed', message: expect.stringContaining('D1の書き込みの枠') },
    ])
  })
})
