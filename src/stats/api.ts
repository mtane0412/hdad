/**
 * 配信の記録の読み出しAPIの呼び出し
 *
 * ダッシュボードはWorker（/api/admin/stats/*）を同じサイトの相対パスで呼び出す。
 * worker/ のコードはブラウザ用のコードから読み込まない約束なので、応答の型はここで定義し、受け取るたびに形を確かめる。
 * 呼び出しと失敗の扱いは `@/core/api` に任せる。fetch を引数で受け取るのは、テストで差し替えるため。
 *
 * 注意: 応答が想定した形でなければエラーにする。黙って空の一覧にすると、記録が無いように見えてしまう（Fail-Fast）。
 */
import { createCaller, isRecord, readList } from '@/core/api'

const STATS_PATH = '/api/admin/stats'

/** 配信セッションの集計（一覧に出す1行ぶん） */
export interface SessionSummary {
  id: string
  /** 配信の開始日時（ISO 8601・UTC） */
  startedAt: string
  /** 配信中なら null */
  endedAt: string | null
  title: string
  categoryName: string
  /** 視聴者数の記録が無ければ null */
  averageViewers: number | null
  peakViewers: number | null
  /** 配信の開始から終了（配信中なら現在）までのフォロワー数の増減。記録が無ければ null */
  followerDelta: number | null
  /** イベントの種類（EventSubの type）ごとの件数 */
  eventCounts: Record<string, number>
}

/** ある時点の視聴者数 */
export interface ViewerSample {
  sampledAt: string
  viewerCount: number
}

/** 配信セッションと、その視聴者数の時系列（古い順） */
export interface SessionDetail {
  id: string
  startedAt: string
  endedAt: string | null
  title: string
  categoryName: string
  samples: ViewerSample[]
}

/** ある時点のフォロワー数。値が変わった時点だけが記録される */
export interface FollowerSample {
  sampledAt: string
  followerTotal: number
}

export interface StatsApi {
  /** 配信セッションの一覧（新しい順） */
  sessions(): Promise<SessionSummary[]>
  /** 配信セッションと視聴者数の時系列 */
  session(id: string): Promise<SessionDetail>
  /** フォロワー数の時系列（古い順） */
  followers(): Promise<FollowerSample[]>
}

/** 数値または null（記録が無いときは null が来る） */
const isNumberOrNull = (value: unknown): boolean => value === null || typeof value === 'number'

/** イベントの種類ごとの件数。種類は増えうるので、値がすべて数値であることだけを確かめる */
const isEventCounts = (value: unknown): value is Record<string, number> => isRecord(value) && Object.values(value).every((count) => typeof count === 'number')

const isViewerSample = (value: unknown): value is ViewerSample =>
  isRecord(value) && typeof value.sampledAt === 'string' && typeof value.viewerCount === 'number'

const isFollowerSample = (value: unknown): value is FollowerSample =>
  isRecord(value) && typeof value.sampledAt === 'string' && typeof value.followerTotal === 'number'

const isSessionSummary = (value: unknown): value is SessionSummary =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.startedAt === 'string' &&
  (value.endedAt === null || typeof value.endedAt === 'string') &&
  typeof value.title === 'string' &&
  typeof value.categoryName === 'string' &&
  isNumberOrNull(value.averageViewers) &&
  isNumberOrNull(value.peakViewers) &&
  isNumberOrNull(value.followerDelta) &&
  isEventCounts(value.eventCounts)

export const createStatsApi = (fetchImpl: typeof fetch): StatsApi => {
  const call = createCaller(fetchImpl)

  return {
    sessions: async () => readList(await call(`${STATS_PATH}/sessions`), 'sessions', isSessionSummary),

    session: async (id) => {
      const body = await call(`${STATS_PATH}/sessions/${encodeURIComponent(id)}`)
      const samples = readList(body, 'samples', isViewerSample)
      if (
        !isRecord(body) ||
        typeof body.id !== 'string' ||
        typeof body.startedAt !== 'string' ||
        !(body.endedAt === null || typeof body.endedAt === 'string') ||
        typeof body.title !== 'string' ||
        typeof body.categoryName !== 'string'
      ) {
        throw new Error('Workerの配信セッションの応答が想定した形ではありません')
      }
      return { id: body.id, startedAt: body.startedAt, endedAt: body.endedAt, title: body.title, categoryName: body.categoryName, samples }
    },

    followers: async () => readList(await call(`${STATS_PATH}/followers`), 'samples', isFollowerSample),
  }
}
