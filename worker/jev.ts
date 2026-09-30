/**
 * Jev の呼び出し
 *
 * Jev は TypeSafe の判定用のモデルで、文面を作らず、材料（state）と質問を渡すと質問ごとに型の決まった答えと
 * 確率を返す。OpenRouter の Decisions API から呼ぶ。このファイルが Jev への唯一の入口で、呼び出し側は
 * モデル名ではなく「どこで使うか」（JevUsage）だけを指名する（LLM の入口 llm.ts と同じ考え方）。
 *
 * 質問の型は3つある。
 * - Noul: 条件が成り立つか。答えは yes の確率（0〜1）
 * - Choice: 決まった選択肢のどれか。答えは選ばれた選択肢と確信度
 * - Score: 段階のどこにあたるか。答えは段階の位置（0 始まりの小数）と確信度
 *
 * 注意: LLM の入口（llm.ts）には載せない。あちらは chat/completions で文面（文字列）を返す作りで、
 * Jev は別の API で型の決まった答えを返すためである。
 * 注意: モデルは版を固定した名前にし、設定で選ばせない。答えの確率をしきい値と比べて使うので、しきい値は
 * 版ごとに観察して決めるものである。jev-latest のように中身が黙って変わる名前だと、しきい値が知らぬ間に合わなくなる。
 * 注意: 失敗は投げる（Fail-Fast）。頼んだ質問の答えが欠けている・型が違う場合も、「いいえ」や既定値として扱わない。
 * 注意: 使用状況は LLM と同じ表（llm_usage）へ、使う箇所ごとに足し込む。記録に失敗しても判定の結果は返し、
 * 黙って捨てずに collection_failures へ残す（llm.ts と同じ扱い）。
 * 注意: エンドポイントは API リファレンスに載っている /api/v1/api/alpha/decisions ではなく /api/alpha/decisions である
 * （前者は 404 を返すことを実際に呼んで確かめた。issue #145）。
 */
import type { Database } from './database'
import { recordLlmUsage } from './llm-usage-store'
import { recordFailure } from './stats-store'
import { withTimeout } from './timeout'

/** OpenRouter の Decisions API */
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'

/** 使うモデル。版を固定する（ファイル冒頭の注意を参照） */
export const JEV_MODEL = 'typesafe/jev-1.13'

/**
 * Jev の1回の呼び出しを待つ時間の上限（ミリ秒）。
 *
 * 実測では約250ms（最大でも330ms程度）で返るので、文面を作る LLM の60秒よりずっと短くとる。
 * 判定は配信中の出来事に合わせて呼ぶので、黙った相手を長く待っても役に立たない。
 */
export const JEV_TIMEOUT_MS = 10_000

/** 失敗の文面に載せる応答本文の長さ。理由が読める程度にとどめる */
const MAX_ERROR_BODY_LENGTH = 200

/** Jev を使う箇所。使用状況の記録で箇所ごとに分けて数える */
export const JEV_USAGES = ['commentReaction', 'bgm'] as const

/** Jev を使う箇所の1つ */
export type JevUsage = (typeof JEV_USAGES)[number]

/** 質問や選択肢の説明。文字列のほか、定義と例を分けて書くためのオブジェクト・配列も渡せる */
export type JevText = string | Readonly<Record<string, unknown>> | readonly unknown[]

/** 条件が成り立つかを尋ねる質問 */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: JevText
  /** 「はい」「いいえ」それぞれに当たる場合の説明。境目があいまいな判定では書いたほうが正しく判定される */
  readonly criteria?: { readonly true: JevText; readonly false: JevText }
}

/** 決まった選択肢のどれかを選ばせる質問 */
export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: JevText
  /** 選択肢の名前と、その説明 */
  readonly criteria: Readonly<Record<string, JevText>>
}

/** 段階のどこにあたるかを尋ねる質問 */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: JevText
  /** 段階の説明。低い段階から順に並べる */
  readonly criteria: readonly JevText[]
}

/** Jev への質問 */
export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Choice の答え */
export interface ChoiceAnswer {
  readonly choice: string
  /** 確信度。API では省かれうるので、返ってこなければ null */
  readonly confidence: number | null
}

/** Score の答え */
export interface ScoreAnswer {
  /** 段階の位置（0 始まり。確率で重みづけした小数） */
  readonly score: number
  /** 確信度。API では省かれうるので、返ってこなければ null */
  readonly confidence: number | null
}

/** 質問の型に合った答えの形。Noul は yes の確率（数）そのもの */
export type JevAnswer<Q extends JevQuestion> = Q extends NoulQuestion ? number : Q extends ChoiceQuestion ? ChoiceAnswer : ScoreAnswer

/** 質問の名前ごとの答え */
export type JevAnswers<Qs extends Readonly<Record<string, JevQuestion>>> = { [K in keyof Qs]: JevAnswer<Qs[K]> }

/** Jev への注文 */
export interface JevRequest<Qs extends Readonly<Record<string, JevQuestion>>> {
  /** 判定の材料。文字列のほか、名前付きの項目を持つオブジェクト・配列も渡せる（質問から `transcript` のように指せる） */
  readonly state: unknown
  /** 質問。名前は答えを受け取るためのもので、モデルには意味が伝わらないので、質問の中身だけで意味が通るように書く */
  readonly questions: Qs
}

/**
 * 使う箇所を指名して判定させるもの。
 *
 * 同じ材料についての質問は1回にまとめて渡す（並列に評価されるので、質問を増やしても応答時間はほぼ変わらない）。
 * テストでは代役に差し替える。
 */
export interface JevClient {
  /** @throws Error 鍵が無い・質問が無い・Jev が失敗した・答えが欠けているか形が違う場合 */
  decide<Qs extends Readonly<Record<string, JevQuestion>>>(usage: JevUsage, request: JevRequest<Qs>): Promise<JevAnswers<Qs>>
}

/** 組み立てに必要なもの */
export interface JevOptions {
  /** OpenRouter への通信。テストで差し替えられるよう引数で受け取る */
  fetch: typeof fetch
  /** OpenRouter のAPIキー（Workerのシークレット OPENROUTER_API_KEY）。未設定なら undefined */
  apiKey: string | undefined
  /** 使用状況を記録するデータベース（D1。llm_usage と、記録に失敗したときの collection_failures） */
  db: Database
  /** 現在時刻（ミリ秒）を返すもの。記録する日の区切りに使う */
  now: () => number
  /** 1回の呼び出しを待つ時間の上限（ミリ秒）。既定は JEV_TIMEOUT_MS。短くできるのはテストのためである */
  timeoutMs?: number
}

/** 応答の使用量 */
interface JevTokenUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly costUsd: number
}

const 空の使用量: JevTokenUsage = { promptTokens: 0, completionTokens: 0, costUsd: 0 }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 数として読めなければ 0（使用量が読めないことを、判定そのものの失敗にはしない） */
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** 応答の usage から使用量を読む。Decisions API は input_tokens・output_tokens・cost の名前で返す */
const readUsage = (result: Record<string, unknown>): JevTokenUsage => {
  const usage = result.usage
  if (!isRecord(usage)) return 空の使用量
  return { promptTokens: asNumber(usage.input_tokens), completionTokens: asNumber(usage.output_tokens), costUsd: asNumber(usage.cost) }
}

/** 確信度を読む。省かれていれば null、数でなければ投げる */
const readConfidence = (answer: Record<string, unknown>, name: string): number | null => {
  if (answer.confidence === undefined) return null
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) {
    throw new Error(`Jev の答え「${name}」の確信度が数ではありません: ${JSON.stringify(answer)}`)
  }
  return answer.confidence
}

/**
 * 1つの質問の答えを、質問の型に合った形で読む。
 *
 * @throws Error 答えが欠けている・型が違う・値が範囲外の場合（黙って「いいえ」や既定値にしない）
 */
const readAnswer = (question: JevQuestion, answer: unknown, name: string): number | ChoiceAnswer | ScoreAnswer => {
  if (!isRecord(answer)) throw new Error(`Jev の応答に、質問「${name}」の答えがありません`)
  if (answer.type !== question.type) {
    throw new Error(`Jev の答え「${name}」の型が質問（${question.type}）と違います: ${JSON.stringify(answer)}`)
  }

  switch (question.type) {
    case 'noul': {
      const probability = answer.noul
      if (typeof probability !== 'number' || !(probability >= 0 && probability <= 1)) {
        throw new Error(`Jev の答え「${name}」の確率が 0〜1 の数ではありません: ${JSON.stringify(answer)}`)
      }
      return probability
    }
    case 'choice': {
      const choice = answer.choice
      if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) {
        throw new Error(`Jev の答え「${name}」が選択肢にありません（${String(choice)}）: ${JSON.stringify(answer)}`)
      }
      return { choice, confidence: readConfidence(answer, name) }
    }
    case 'score': {
      const score = answer.score
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new Error(`Jev の答え「${name}」の段階が数ではありません: ${JSON.stringify(answer)}`)
      }
      return { score, confidence: readConfidence(answer, name) }
    }
  }
}

/**
 * 応答から、頼んだ質問すべての答えを読む。
 *
 * @throws Error answers が無い、または頼んだ質問の答えのどれかが読めない場合
 */
const readAnswers = <Qs extends Readonly<Record<string, JevQuestion>>>(questions: Qs, result: Record<string, unknown>): JevAnswers<Qs> => {
  const answers = result.answers
  if (!isRecord(answers)) throw new Error(`Jev の応答を読めません（answers が見つかりません）: ${JSON.stringify(result).slice(0, MAX_ERROR_BODY_LENGTH)}`)
  const entries = Object.entries(questions).map(([name, question]) => [name, readAnswer(question, answers[name], name)] as const)
  // 質問の型ごとに readAnswer が形を確かめているので、名前ごとの答えの型は JevAnswers<Qs> に一致する
  return Object.fromEntries(entries) as JevAnswers<Qs>
}

/**
 * Jev を呼ぶものを組み立てる。
 *
 * 呼び出しには時間制限をかける（worker/timeout.ts。黙った相手を待ち続けて後ろの処理が止まらないようにする）。
 */
export const createJev = ({ fetch: 元の通信, apiKey, db, now, timeoutMs = JEV_TIMEOUT_MS }: JevOptions): JevClient => {
  const fetchImpl = withTimeout(元の通信, timeoutMs, 'Jev')

  /**
   * 1回の呼び出しを記録する。
   *
   * 記録できなくても投げない（呼び出し側は答えを受け取れているので、ここで投げると記録のために答えが失われる）。
   * 黙って捨てず collection_failures へ残し、それも失敗したらあきらめる（それ以上残す先が無い）。
   */
  const 記録する = async (tokens: JevTokenUsage, usage: JevUsage, failed: boolean): Promise<void> => {
    const 時刻 = now()
    try {
      await recordLlmUsage(db, { usage, provider: 'openrouter', model: JEV_MODEL, ...tokens, failed }, 時刻)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordFailure(db, 'llm-usage-record-failed', `Jev の使用状況（${usage}・${JEV_MODEL}）を記録できませんでした: ${message}`, 時刻).catch(
        () => undefined,
      )
    }
  }

  /** Decisions API へ送り、答えと使用量を読む */
  const 送る = async <Qs extends Readonly<Record<string, JevQuestion>>>(
    key: string,
    request: JevRequest<Qs>,
  ): Promise<{ answers: JevAnswers<Qs>; tokens: JevTokenUsage }> => {
    const response = await fetchImpl(DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state: request.state, questions: request.questions }),
    })
    if (!response.ok) {
      const body = (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH)
      throw new Error(`Jev が失敗を返しました（${response.status} ${JEV_MODEL}）: ${body}`)
    }
    const result: unknown = await response.json()
    if (!isRecord(result)) throw new Error(`Jev の応答を読めません: ${JSON.stringify(result)}`)
    return { answers: readAnswers(request.questions, result), tokens: readUsage(result) }
  }

  return {
    decide: async (usage, request) => {
      if (apiKey === undefined || apiKey === '') {
        throw new Error('Jev は OpenRouter から呼びますが、WorkerのシークレットOPENROUTER_API_KEYが設定されていません')
      }
      if (Object.keys(request.questions).length === 0) {
        throw new Error('Jev へ送る質問が1つもありません')
      }

      const result = await 送る(apiKey, request).catch(async (error: unknown) => {
        // 失敗も数える（残高不足が何回起きたかを読めるようにする）。数えたうえで、そのまま投げる
        await 記録する(空の使用量, usage, true)
        throw error
      })

      await 記録する(result.tokens, usage, false)
      return result.answers
    },
  }
}
