/**
 * 意見ボードの Worker の呼び出し
 *
 * 2つの呼び出し手がある。
 * - 合成ページの素材「意見ボード」: ログインを持たないので、オーバーレイ用キー（URLの ?key=）で Worker に受け付けてもらう。
 *   意見ボードが変わるたびに WebSocket（OPINION_SOCKET_PATH）で丸ごと押し出してもらい、ここで読むのは開いたとき・つなぎ直したとき・
 *   定期的に取り戻す分だけである。人数は受け取らない（多数決に見せないため）
 * - アプリのページ（/opinions/）: ログインのセッションで、テーマを開き・締め切り、問いかけを替え、意見を隠す。人数ともとのコメントも読む。
 *   コメントの内訳と意見にならなかったコメントも読み、救い出し（下書き・意見にする・統合する）と論点の整理（名前・まとめる）を行う（issue #308）
 *
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 想定した形でなければエラーにする（Fail-Fast）。
 */
import { createCaller, isRecord, readList } from '../core/api'
import {
  OPINION_KINDS,
  isOpinionTheme,
  isOverlayOpinion,
  readOpinionBoard,
  type OpinionBoard,
  type OpinionKind,
  type OpinionTheme,
  type OverlayOpinion,
} from './entry'

const OVERLAY_PATH = '/api/overlay/opinions'
const ADMIN_PATH = '/api/admin/opinions'

/** 変わった意見ボードを押し出してもらう WebSocket のパス */
export const OPINION_SOCKET_PATH = '/api/overlay/opinions/socket'

/** 一度もつながらないまま閉じたときに出す、いちばんありそうな原因 */
export const OPINION_SOCKET_HINT = '意見ボードの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

/** 管理画面に出す、意見のもとになったコメント1件 */
export interface OpinionSource {
  readonly userName: string
  readonly text: string
}

/** 管理画面に出す意見1件（worker/opinion.ts の AdminOpinion と合わせる） */
export interface AdminOpinion extends OverlayOpinion {
  readonly hidden: boolean
  /** この意見を書いた人数 */
  readonly people: number
  /** もとになったコメント（書かれた順） */
  readonly sources: readonly OpinionSource[]
}

/** 管理画面に出す論点1つ */
export interface AdminTopic {
  readonly id: number
  readonly title: string
  readonly opinions: readonly AdminOpinion[]
}

/** コメントを規則で落とした理由（worker/opinion.ts の DropReason と合わせる） */
export const DROP_REASONS = ['command', 'emote', 'reaction'] as const
export type DropReason = (typeof DROP_REASONS)[number]

/** 救い出せるコメントの状態（worker/opinion.ts の RescuableStatus と合わせる） */
export const RESCUABLE_STATUSES = ['pending', 'dropped', 'filtered', 'ignored', 'failed'] as const
export type RescuableStatus = (typeof RESCUABLE_STATUSES)[number]

/** テーマを出しているあいだに受け取ったコメントの内訳（worker/opinion.ts の OpinionCommentCounts と合わせる） */
export interface OpinionCommentCounts {
  readonly received: number
  readonly used: number
  readonly pending: number
  readonly dropped: Readonly<Record<DropReason, number>>
  readonly filtered: number
  readonly ignored: number
  readonly failed: number
}

/** 意見にならなかったコメント1件（worker/opinion.ts の RescuableComment と合わせる） */
export interface RescuableComment {
  readonly id: number
  readonly userName: string
  readonly text: string
  readonly replyName: string | null
  readonly replyText: string | null
  readonly sentAt: string
  readonly status: RescuableStatus
  readonly dropReason: DropReason | null
  readonly jevScore: number | null
}

/** 管理画面に出す意見ボード。まだ一度もテーマを開いていなければ theme は null */
export interface AdminOpinionBoard {
  readonly theme: OpinionTheme | null
  readonly topics: readonly AdminTopic[]
  /** コメントの内訳 */
  readonly counts: OpinionCommentCounts
  /** 意見にならなかったコメント（新しい順） */
  readonly rescuable: readonly RescuableComment[]
}

/** 意見を入れる論点。既にある論点か、新しく作る論点（worker/opinion.ts の TopicChoice と合わせる） */
export type TopicChoice = { readonly type: 'existing'; readonly id: number } | { readonly type: 'new'; readonly title: string }

/** 救い出したコメントから作る意見。下書きの応答と保存の本文で同じ形（worker/opinion.ts の RescuedOpinionInput と合わせる） */
export interface RescuedOpinion {
  readonly kind: OpinionKind
  readonly text: string
  readonly topic: TopicChoice
}

export interface OpinionOverlayApi {
  /** 最後に開いたテーマの意見ボードを読む（人数を含まない） */
  read(): Promise<OpinionBoard>
}

export interface OpinionApi {
  /** 最後に開いたテーマの意見ボードを、隠した意見・人数・もとのコメントを添えて読む */
  read(): Promise<AdminOpinionBoard>
  /** テーマを開き、開いたテーマを返す */
  openTheme(title: string): Promise<OpinionTheme>
  /** テーマを締め切り、締め切ったテーマを返す */
  closeTheme(id: number): Promise<OpinionTheme>
  /** 開いているテーマの、視聴者への問いかけを別のものに替え（Worker が LLM に作り直させる）、替えたテーマを返す */
  replacePrompt(id: number): Promise<OpinionTheme>
  /** 意見を隠す・隠すのをやめる */
  setHidden(id: number, hidden: boolean): Promise<void>
  /** 意見にならなかったコメントから、意見の下書きを Worker（LLM）に作らせる。保存はしない */
  draftOpinion(commentId: number): Promise<RescuedOpinion>
  /** 意見にならなかったコメントを、配信者が直した意見にする */
  rescueAsOpinion(commentId: number, opinion: RescuedOpinion): Promise<void>
  /** 意見にならなかったコメントを、既にある意見に統合する */
  joinOpinion(commentId: number, opinionId: number): Promise<void>
  /** 論点の名前を書き換える */
  renameTopic(topicId: number, title: string): Promise<void>
  /** 論点（topicId）を別の論点（intoId）にまとめる。まとめ先の名前が残る */
  mergeTopics(topicId: number, intoId: number): Promise<void>
}

const isOpinionSource = (value: unknown): value is OpinionSource => isRecord(value) && typeof value.userName === 'string' && typeof value.text === 'string'

const isAdminOpinion = (value: unknown): value is AdminOpinion =>
  isOverlayOpinion(value) &&
  isRecord(value) &&
  typeof value.hidden === 'boolean' &&
  typeof value.people === 'number' &&
  Array.isArray(value.sources) &&
  value.sources.every(isOpinionSource)

const isOneOf = <T extends string>(choices: readonly T[], value: unknown): value is T => choices.some((choice) => choice === value)

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

const isCommentCounts = (value: unknown): value is OpinionCommentCounts =>
  isRecord(value) &&
  isRecord(value.dropped) &&
  DROP_REASONS.every((reason) => isRecord(value.dropped) && isCount(value.dropped[reason])) &&
  [value.received, value.used, value.pending, value.filtered, value.ignored, value.failed].every(isCount)

const isRescuableComment = (value: unknown): value is RescuableComment =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.userName === 'string' &&
  typeof value.text === 'string' &&
  (value.replyName === null || typeof value.replyName === 'string') &&
  (value.replyText === null || typeof value.replyText === 'string') &&
  typeof value.sentAt === 'string' &&
  isOneOf(RESCUABLE_STATUSES, value.status) &&
  (value.dropReason === null || isOneOf(DROP_REASONS, value.dropReason)) &&
  (value.jevScore === null || typeof value.jevScore === 'number')

const isTopicChoice = (value: unknown): value is TopicChoice =>
  isRecord(value) && ((value.type === 'existing' && typeof value.id === 'number') || (value.type === 'new' && typeof value.title === 'string'))

const isRescuedOpinion = (value: unknown): value is RescuedOpinion =>
  isRecord(value) && isOneOf(OPINION_KINDS, value.kind) && typeof value.text === 'string' && isTopicChoice(value.topic)

const isAdminTopic = (value: unknown): value is AdminTopic =>
  isRecord(value) && typeof value.id === 'number' && typeof value.title === 'string' && Array.isArray(value.opinions) && value.opinions.every(isAdminOpinion)

/**
 * 管理画面の意見ボードを読む。
 *
 * @throws 想定した形でない場合
 */
const readAdminBoard = (body: unknown): AdminOpinionBoard => {
  const theme: unknown = isRecord(body) ? body.theme : undefined
  if (!(theme === null || isOpinionTheme(theme))) throw new Error('Workerの応答の theme が想定した形ではありません')
  const counts: unknown = isRecord(body) ? body.counts : undefined
  if (!isCommentCounts(counts)) throw new Error('Workerの応答の counts が想定した形ではありません')
  return { theme, topics: readList(body, 'topics', isAdminTopic), counts, rescuable: readList(body, 'rescuable', isRescuableComment) }
}

/**
 * 応答の draft を読む。
 *
 * @throws 想定した形でない場合
 */
const readDraft = (body: unknown): RescuedOpinion => {
  const draft = isRecord(body) ? body.draft : undefined
  if (!isRescuedOpinion(draft)) throw new Error('意見の下書きの応答の形が想定と違います')
  return draft
}

/**
 * 応答の theme を読む。
 *
 * @throws 想定した形でない場合
 */
const readTheme = (body: unknown): OpinionTheme => {
  const theme = isRecord(body) ? body.theme : undefined
  if (!isOpinionTheme(theme)) throw new Error('テーマの応答の形が想定と違います')
  return theme
}

/**
 * 合成ページからの読み出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createOpinionOverlayApi = (fetchImpl: typeof fetch, key: string): OpinionOverlayApi => {
  const call = createCaller(fetchImpl)
  const path = `${OVERLAY_PATH}?key=${encodeURIComponent(key)}`
  return {
    read: async () => readOpinionBoard(await call(path)),
  }
}

/**
 * アプリのページからの読み書きを組み立てる。
 *
 * @param fetchImpl 通信の実装（同上）
 */
export const createOpinionApi = (fetchImpl: typeof fetch): OpinionApi => {
  const call = createCaller(fetchImpl)
  const send = (path: string, method: string, body?: unknown): Promise<unknown> =>
    call(path, body === undefined ? { method } : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  return {
    read: async () => readAdminBoard(await call(ADMIN_PATH)),
    openTheme: async (title) => readTheme(await send(`${ADMIN_PATH}/themes`, 'POST', { title })),
    closeTheme: async (id) => readTheme(await send(`${ADMIN_PATH}/themes/${id}/close`, 'POST')),
    replacePrompt: async (id) => readTheme(await send(`${ADMIN_PATH}/themes/${id}/prompt`, 'POST')),
    setHidden: async (id, hidden) => {
      await send(`${ADMIN_PATH}/items/${id}`, 'PUT', { hidden })
    },
    draftOpinion: async (commentId) => readDraft(await send(`${ADMIN_PATH}/comments/${commentId}/draft`, 'POST')),
    rescueAsOpinion: async (commentId, opinion) => {
      await send(`${ADMIN_PATH}/comments/${commentId}/opinion`, 'POST', opinion)
    },
    joinOpinion: async (commentId, opinionId) => {
      await send(`${ADMIN_PATH}/comments/${commentId}/join`, 'POST', { opinionId })
    },
    renameTopic: async (topicId, title) => {
      await send(`${ADMIN_PATH}/topics/${topicId}`, 'PUT', { title })
    },
    mergeTopics: async (topicId, intoId) => {
      await send(`${ADMIN_PATH}/topics/${topicId}/merge`, 'POST', { into: intoId })
    },
  }
}
