/**
 * 意見ボードの Worker の呼び出し
 *
 * 2つの呼び出し手がある。
 * - 合成ページの素材「意見ボード」: ログインを持たないので、オーバーレイ用キー（URLの ?key=）で Worker に受け付けてもらう。
 *   意見ボードが変わるたびに WebSocket（OPINION_SOCKET_PATH）で丸ごと押し出してもらい、ここで読むのは開いたとき・つなぎ直したとき・
 *   定期的に取り戻す分だけである。人数は受け取らない（多数決に見せないため）
 * - アプリのページ（/opinions/）: ログインのセッションで、テーマを開き・締め切り、意見を隠す。人数ともとのコメントも読む
 *
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 想定した形でなければエラーにする（Fail-Fast）。
 */
import { createCaller, isRecord, readList } from '../core/api'
import { isOpinionTheme, isOverlayOpinion, readOpinionBoard, type OpinionBoard, type OpinionTheme, type OverlayOpinion } from './entry'

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

/** 管理画面に出す意見ボード。まだ一度もテーマを開いていなければ theme は null */
export interface AdminOpinionBoard {
  readonly theme: OpinionTheme | null
  readonly topics: readonly AdminTopic[]
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
  /** 意見を隠す・隠すのをやめる */
  setHidden(id: number, hidden: boolean): Promise<void>
}

const isOpinionSource = (value: unknown): value is OpinionSource => isRecord(value) && typeof value.userName === 'string' && typeof value.text === 'string'

const isAdminOpinion = (value: unknown): value is AdminOpinion =>
  isOverlayOpinion(value) &&
  isRecord(value) &&
  typeof value.hidden === 'boolean' &&
  typeof value.people === 'number' &&
  Array.isArray(value.sources) &&
  value.sources.every(isOpinionSource)

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
  return { theme, topics: readList(body, 'topics', isAdminTopic) }
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
    setHidden: async (id, hidden) => {
      await send(`${ADMIN_PATH}/items/${id}`, 'PUT', { hidden })
    },
  }
}
