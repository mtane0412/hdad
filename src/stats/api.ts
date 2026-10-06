/**
 * 配信の記録の読み出しAPIの呼び出し
 *
 * ダッシュボードはWorker（/api/admin/stats/*。配信タイトルの候補を作るかの設定は /api/admin/stream-title/settings）を
 * 同じサイトの相対パスで呼び出す。
 * worker/ のコードはブラウザ用のコードから読み込まない約束なので、応答の型はここで定義し、受け取るたびに形を確かめる。
 * 呼び出しと失敗の扱いは `@/core/api` に任せる。fetch を引数で受け取るのは、テストで差し替えるため。
 *
 * 注意: 応答が想定した形でなければエラーにする。黙って空の一覧にすると、記録が無いように見えてしまう（Fail-Fast）。
 */
import { createCaller, isRecord, readList } from '@/core/api'

const STATS_PATH = '/api/admin/stats'
const TITLE_SETTINGS_PATH = '/api/admin/stream-title/settings'

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

/** 配信の約30分ぶんで何が話されたかの記録（1章） */
export interface StreamChapter {
  /** 区間の始まり（ISO 8601・UTC） */
  startedAt: string
  /** 区間の終わり（ISO 8601・UTC） */
  endedAt: string
  /** 見出し */
  title: string
  /** 何が話されたかの要約 */
  summary: string
}

/**
 * 章ごとに作った配信タイトルの候補と、Jev の判定（試験運用。worker/stream-title-store.ts の StreamTitleCandidate と合わせる）。
 *
 * Twitch のタイトルは書き換えておらず、見比べるための記録である。
 */
export interface StreamTitleCandidate {
  /** 候補を作った章の始まり（ISO 8601・UTC）。章の startedAt と照らし合わせる */
  chapterStartedAt: string
  /** 配信者が書いた固定部分のあとに続ける一言 */
  candidate: string
  /** 配信タイトルとして公開してよいかを Jev に尋ねた、「よい」の確率（0〜1） */
  publishable: number
}

/** 配信タイトルの候補を作るかの設定（worker/stream-title-config.ts の StreamTitleSettings と合わせる） */
export interface StreamTitleSettings {
  enabled: boolean
}

/** 配信セッションと、その視聴者数の時系列（古い順）・章・あらすじ */
export interface SessionDetail {
  id: string
  startedAt: string
  endedAt: string | null
  title: string
  categoryName: string
  samples: ViewerSample[]
  /** 何が話されたかの記録（区間の始まった順）。まだ1章も無ければ空 */
  chapters: StreamChapter[]
  /** 章ごとに作った配信タイトルの候補（章の始まった順）。作っていなければ空 */
  titleCandidates: StreamTitleCandidate[]
  /** 最後に作った「これまでのあらすじ」。作っていなければ null */
  summary: string | null
  /** 作業机でみんなが作業した時間の合計（ミリ秒）と人数。誰も宣言しなかった配信では null */
  workTime: WorkTime | null
}

/** 作業机でみんなが作業した時間の合計（worker/stats-store.ts の SessionDetail の workTime と合わせる） */
export interface WorkTime {
  people: number
  totalMs: number
}

/** ある時点のフォロワー数。値が変わった時点だけが記録される */
export interface FollowerSample {
  sampledAt: string
  followerTotal: number
}

export interface StatsApi {
  /** 配信セッションの一覧（新しい順） */
  sessions(): Promise<SessionSummary[]>
  /** 配信セッションと視聴者数の時系列・章・あらすじ */
  session(id: string): Promise<SessionDetail>
  /** フォロワー数の時系列（古い順） */
  followers(): Promise<FollowerSample[]>
  /** 配信タイトルの候補を作るかの設定 */
  titleSettings(): Promise<StreamTitleSettings>
  /** 配信タイトルの候補を作るかの設定を保存し、保存された設定を返す */
  saveTitleSettings(settings: StreamTitleSettings): Promise<StreamTitleSettings>
}

/** 数値または null（記録が無いときは null が来る） */
const isNumberOrNull = (value: unknown): boolean => value === null || typeof value === 'number'

/** イベントの種類ごとの件数。種類は増えうるので、値がすべて数値であることだけを確かめる */
const isEventCounts = (value: unknown): value is Record<string, number> => isRecord(value) && Object.values(value).every((count) => typeof count === 'number')

const isViewerSample = (value: unknown): value is ViewerSample =>
  isRecord(value) && typeof value.sampledAt === 'string' && typeof value.viewerCount === 'number'

const isStreamChapter = (value: unknown): value is StreamChapter =>
  isRecord(value) &&
  typeof value.startedAt === 'string' &&
  typeof value.endedAt === 'string' &&
  typeof value.title === 'string' &&
  typeof value.summary === 'string'

const isStreamTitleCandidate = (value: unknown): value is StreamTitleCandidate =>
  isRecord(value) && typeof value.chapterStartedAt === 'string' && typeof value.candidate === 'string' && typeof value.publishable === 'number'

/** 応答の settings を読む。形が違えば「作らない」に読み替えずにエラーにする */
const readTitleSettings = (body: unknown): StreamTitleSettings => {
  const settings = isRecord(body) ? body.settings : undefined
  if (!isRecord(settings) || typeof settings.enabled !== 'boolean') {
    throw new Error(`Workerの ${TITLE_SETTINGS_PATH} の応答の settings が想定した形ではありません`)
  }
  return { enabled: settings.enabled }
}

const isWorkTime = (value: unknown): value is WorkTime => isRecord(value) && typeof value.people === 'number' && typeof value.totalMs === 'number'

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
      const chapters = readList(body, 'chapters', isStreamChapter)
      const titleCandidates = readList(body, 'titleCandidates', isStreamTitleCandidate)
      if (
        !isRecord(body) ||
        typeof body.id !== 'string' ||
        typeof body.startedAt !== 'string' ||
        !(body.endedAt === null || typeof body.endedAt === 'string') ||
        typeof body.title !== 'string' ||
        typeof body.categoryName !== 'string' ||
        !(body.summary === null || typeof body.summary === 'string') ||
        !(body.workTime === null || isWorkTime(body.workTime))
      ) {
        throw new Error('Workerの配信セッションの応答が想定した形ではありません')
      }
      return {
        id: body.id,
        startedAt: body.startedAt,
        endedAt: body.endedAt,
        title: body.title,
        categoryName: body.categoryName,
        samples,
        chapters,
        titleCandidates,
        summary: body.summary,
        workTime: body.workTime,
      }
    },

    followers: async () => readList(await call(`${STATS_PATH}/followers`), 'samples', isFollowerSample),

    titleSettings: async () => readTitleSettings(await call(TITLE_SETTINGS_PATH)),

    saveTitleSettings: async (settings) =>
      readTitleSettings(
        await call(TITLE_SETTINGS_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }),
      ),
  }
}
