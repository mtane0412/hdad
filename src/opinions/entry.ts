/**
 * 意見ボードの形と、紹介する意見の選び方
 *
 * 合成ページの素材「意見ボード」は、配信者が出したテーマについて視聴者のコメントから取り出した意見を、論点ごとに並べて映す（issue #306）。
 * 意見ボードは2つの道から届く。開いたとき・つなぎ直したとき・定期的に読む読み出し（api.ts）と、変わるたびに丸ごと届く押し出し
 * （WebSocket）である。どちらも丸ごとなので、届いたもので置き換えればよい。通信もDOMも持たないので、ここだけをテストできる。
 *
 * 多数決に見せないため、合成ページは人数を受け取らない。中央の「いま紹介している意見」も、人数ではなく意見を作った順に一定の時間ずつ
 * 回す（少数の意見にも同じだけ出番を回す）。何を紹介するかは現在時刻だけから決める（フレーム間の状態を持たない）。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、形はここで定義する（worker/opinion.ts の OpinionBoardSnapshot と合わせる）。
 * 想定した形でなければ投げる（Fail-Fast）。
 */
import { isRecord, readList } from '../core/api'

/** 意見の札の種類。issue は課題、solution は解決策、question は問い、insight は気づき（worker/opinion.ts の OPINION_KINDS と合わせる） */
export const OPINION_KINDS = ['issue', 'solution', 'question', 'insight'] as const
export type OpinionKind = (typeof OPINION_KINDS)[number]

/** 札の種類ごとの呼び名（worker/opinion.ts の OPINION_KIND_LABELS と合わせる） */
export const OPINION_KIND_LABELS: Readonly<Record<OpinionKind, string>> = {
  issue: '課題',
  solution: '解決策',
  question: '問い',
  insight: '気づき',
}

/** 「いま紹介している意見」を1件ずつ映す時間（ミリ秒）。1文（40文字まで）を読み切れる長さにする */
export const SPOTLIGHT_MS = 8000

/** 作ってからこの時間（ミリ秒）のあいだ、その意見を作ったばかりとして目立たせる */
export const FRESH_MS = 10_000

/** 合成ページの左右の枠それぞれに並べる論点の数（worker/opinion.ts の MAX_TOPICS の半分） */
export const TOPICS_PER_SIDE = 3

/** テーマ1件 */
export interface OpinionTheme {
  readonly id: number
  readonly title: string
  /** 開いた時刻（ISO 8601） */
  readonly openedAt: string
  /** 締め切った時刻（ISO 8601）。開いているあいだは null */
  readonly closedAt: string | null
}

/** 合成ページに出す意見1件。人数は持たない */
export interface OverlayOpinion {
  readonly id: number
  readonly kind: OpinionKind
  readonly text: string
  /** 最初にこの意見を書いた人の表示名 */
  readonly author: string
  /** 意見を作った時刻（ISO 8601） */
  readonly createdAt: string
}

/** 論点1つ。意見は新しい順 */
export interface OverlayTopic {
  readonly id: number
  readonly title: string
  readonly opinions: readonly OverlayOpinion[]
}

/** いまの意見ボード。まだ一度もテーマを開いていなければ theme は null */
export interface OpinionBoard {
  readonly theme: OpinionTheme | null
  /** 作った順の論点 */
  readonly topics: readonly OverlayTopic[]
}

/** 「いま紹介している意見」と、その論点の名前 */
export interface Spotlight {
  readonly topicTitle: string
  readonly opinion: OverlayOpinion
}

const isOneOf = <T extends string>(choices: readonly T[], value: unknown): value is T => choices.some((choice) => choice === value)

/** テーマとして読めるか */
export const isOpinionTheme = (value: unknown): value is OpinionTheme =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.title === 'string' &&
  typeof value.openedAt === 'string' &&
  (typeof value.closedAt === 'string' || value.closedAt === null)

/** 合成ページに出す意見1件として読めるか */
export const isOverlayOpinion = (value: unknown): value is OverlayOpinion =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  isOneOf(OPINION_KINDS, value.kind) &&
  typeof value.text === 'string' &&
  typeof value.author === 'string' &&
  typeof value.createdAt === 'string'

/** 論点1つとして読めるか（意見の形も確かめる） */
const isOverlayTopic = (value: unknown): value is OverlayTopic =>
  isRecord(value) && typeof value.id === 'number' && typeof value.title === 'string' && Array.isArray(value.opinions) && value.opinions.every(isOverlayOpinion)

/**
 * Worker の応答（読み出しと押し出しで同じ形）を、意見ボードとして読む。
 *
 * @throws 想定した形でない場合
 */
export const readOpinionBoard = (body: unknown): OpinionBoard => {
  const theme: unknown = isRecord(body) ? body.theme : undefined
  if (!(theme === null || isOpinionTheme(theme))) throw new Error('Workerの応答の theme が想定した形ではありません')
  return { theme, topics: readList(body, 'topics', isOverlayTopic) }
}

/**
 * WebSocket で押し出された文字列を、意見ボードとして読む。
 *
 * @throws JSONとして読めない・想定した形でない場合
 */
export const parseOpinionBoardMessage = (payload: string): OpinionBoard => {
  let body: unknown
  try {
    body = JSON.parse(payload)
  } catch {
    throw new Error('押し出された意見ボードをJSONとして読めません')
  }
  return readOpinionBoard(body)
}

/**
 * いまの時刻に紹介する意見を選ぶ。
 *
 * すべての論点の意見を作った順に並べ、SPOTLIGHT_MS ずつ順に回す。人数では選ばない（多数決に見せないため）。
 *
 * @returns 意見が1件も無ければ null
 */
export const spotlightAt = (topics: readonly OverlayTopic[], now: number): Spotlight | null => {
  const all = topics
    .flatMap((topic) => topic.opinions.map((opinion) => ({ topicTitle: topic.title, opinion })))
    .sort((left, right) => Date.parse(left.opinion.createdAt) - Date.parse(right.opinion.createdAt) || left.opinion.id - right.opinion.id)
  if (all.length === 0) return null
  return all[Math.floor(now / SPOTLIGHT_MS) % all.length] ?? null
}

/** 作ったばかりの意見か（作ってから FRESH_MS のあいだ） */
export const isFresh = (opinion: OverlayOpinion, now: number): boolean => now - Date.parse(opinion.createdAt) < FRESH_MS

/** 論点を作った順に、左の枠（最初の3つ）と右の枠（次の3つ）に分ける */
export const splitTopics = (topics: readonly OverlayTopic[]): { left: OverlayTopic[]; right: OverlayTopic[] } => ({
  left: topics.slice(0, TOPICS_PER_SIDE),
  right: topics.slice(TOPICS_PER_SIDE, TOPICS_PER_SIDE * 2),
})
