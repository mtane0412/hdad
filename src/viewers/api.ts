/**
 * 視聴者の記録のAPIの呼び出し
 *
 * 視聴者のページはWorker（/api/admin/viewers）を同じサイトの相対パスで呼び出す。
 * worker/ のコードはブラウザ用のコードから読み込まない約束なので、応答の型はここで定義し、受け取るたびに形を確かめる。
 * 呼び出しと失敗の扱いは `@/core/api` に任せる。fetch を引数で受け取るのは、テストで差し替えるため。
 *
 * 注意: 応答が想定した形でなければエラーにする。黙って空の一覧にすると、記録が無いように見えてしまう（Fail-Fast）。
 */
import { createCaller, isRecord, readList } from '@/core/api'

const VIEWERS_PATH = '/api/admin/viewers'

/** チャットで発言した人1人ぶんの記録 */
export interface Viewer {
  userId: string
  login: string
  displayName: string
  /** このチャンネルで初めて発言した日時（ISO 8601・UTC） */
  firstSeenAt: string
  /** 最後に発言した日時（ISO 8601・UTC） */
  lastSeenAt: string
  /** 通算の発言数（Workerが更新の間隔を空けているので、実際の発言数より少なくなる） */
  messageCount: number
  /** 最後に見たバッジの種類の名前（broadcaster・moderator・vip・subscriber など） */
  badges: string[]
  /** 配信者が手で書いたメモ */
  note: string
  /** 配信が終わったあとにLLMが作った人物像。まだ作っていない人では空文字 */
  summary: string
  /** その人物像を作った日時（ISO 8601・UTC）。まだ作っていない人では null */
  summarizedAt: string | null
}

/** 一覧の絞り込み */
export interface ViewerQuery {
  /** ログイン名の前方一致。空なら絞り込まない */
  search?: string
  /** この日時より前に発言した人だけを返す。続きを読むときは一覧の最後の lastSeenAt を渡す */
  before?: string
  /** `before` と同じ日時の人をどこまで読んだかの目印。続きを読むときは一覧の最後の userId を渡す */
  beforeUserId?: string
  /** 一度に取る件数。指定しなければWorkerの既定（50件）になる */
  limit?: number
}

export interface ViewerApi {
  /** 記録のある人の一覧（最後に発言した順） */
  list(query: ViewerQuery): Promise<Viewer[]>
  /** メモを保存する。保存された内容を返す */
  saveNote(userId: string, note: string): Promise<string>
  /** 人ごとの記録を消す */
  remove(userId: string): Promise<void>
}

const isStringArray = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === 'string')

const isViewer = (value: unknown): value is Viewer =>
  isRecord(value) &&
  typeof value.userId === 'string' &&
  typeof value.login === 'string' &&
  typeof value.displayName === 'string' &&
  typeof value.firstSeenAt === 'string' &&
  typeof value.lastSeenAt === 'string' &&
  typeof value.messageCount === 'number' &&
  isStringArray(value.badges) &&
  typeof value.note === 'string' &&
  typeof value.summary === 'string' &&
  (value.summarizedAt === null || typeof value.summarizedAt === 'string')

export const createViewerApi = (fetchImpl: typeof fetch): ViewerApi => {
  const call = createCaller(fetchImpl)

  return {
    list: async ({ search, before, beforeUserId, limit }) => {
      // 空の値をクエリに載せないのは、Worker側の「指定なし」と区別する必要がないため（載せても同じ意味になる）
      const params = new URLSearchParams()
      if (search !== undefined && search !== '') params.set('search', search)
      if (before !== undefined && before !== '') params.set('before', before)
      if (beforeUserId !== undefined && beforeUserId !== '') params.set('beforeUserId', beforeUserId)
      if (limit !== undefined) params.set('limit', String(limit))
      const query = params.toString()
      return readList(await call(query === '' ? VIEWERS_PATH : `${VIEWERS_PATH}?${query}`), 'viewers', isViewer)
    },

    saveNote: async (userId, note) => {
      const body = await call(`${VIEWERS_PATH}/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      })
      if (!isRecord(body) || typeof body.note !== 'string') throw new Error('Workerのメモの保存の応答が想定した形ではありません')
      return body.note
    },

    remove: async (userId) => {
      await call(`${VIEWERS_PATH}/${encodeURIComponent(userId)}`, { method: 'DELETE' })
    },
  }
}
