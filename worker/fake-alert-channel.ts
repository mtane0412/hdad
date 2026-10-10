/**
 * テスト用のアラートの配送先
 *
 * Durable Object の代わりに、押し出されたアラートを配列へ貯める。Worker のテストだけが使う
 * （プロダクションコードからは参照しない）。
 */
import type { AlertChannelNamespace } from './alert-channel'
import type { OverlayAlert } from './alert-event'
import type { BgmDuck, BgmNowPlaying } from './bgm-config'
import { STATUS } from './http'
import type { PomodoroSnapshot } from './pomodoro-timer'
import type { SpeechMute } from './speech-config'
import type { TaskDeskSnapshot } from './task-desk'
import type { KanjiQuizCall, KanjiQuizNotice, StreamStopOrder } from './kanji-quiz-call'
import type { OpinionBoardSnapshot } from './opinion'
import type { TextsSnapshot } from './text'
import type { TownTourAnswerMessage, TownTourCall } from './town-tour-call'
import type { TwisterCall } from './twister-call'
import type { WorkLogEntry } from './work-log'

interface FakeAlertChannelOptions {
  /** 配送先が失敗を返す場合（押し出し側が失敗を握りつぶさないことを確かめる） */
  shouldFail?: boolean
  /** 配信を止める命令を受け取る裏方のページがつながっていない場合（配送先は409を返す） */
  noStreamStopReceiver?: boolean
}

/** 押し出されたアラート・引き渡された接続を直接確かめられるよう、記録も一緒に返す */
export const createFakeAlertChannel = ({ shouldFail = false, noStreamStopReceiver = false }: FakeAlertChannelOptions = {}): {
  namespace: AlertChannelNamespace
  pushedAlerts: OverlayAlert[]
  /** 押し出された「いま流している曲」 */
  pushedBgm: BgmNowPlaying[]
  /** 押し出された作業ログの1行 */
  pushedWorkLog: WorkLogEntry[]
  /** 押し出された作業机 */
  pushedTaskDesk: TaskDeskSnapshot[]
  /** 押し出されたポモドーロのタイマー */
  pushedPomodoro: PomodoroSnapshot[]
  /** 押し出された市町村紹介の呼び出し */
  pushedTownTours: TownTourCall[]
  /** 押し出された都道府県当てクイズの正解者（呼び出しと同じ経路で、type: answer を持つ） */
  pushedTownTourAnswers: TownTourAnswerMessage[]
  /** 押し出されたツイスターの呼び出し */
  pushedTwisters: TwisterCall[]
  /** 押し出された配信のBGMを下げる知らせ */
  pushedBgmDucks: BgmDuck[]
  /** 押し出された読み上げのミュート */
  pushedSpeechMutes: SpeechMute[]
  /** 押し出されたテキストの一覧 */
  pushedTexts: TextsSnapshot[]
  /** 押し出された漢字クイズの出題 */
  pushedKanjiQuizzes: KanjiQuizCall[]
  /** 押し出された漢字クイズの知らせ（正解者・失敗。出題と同じ経路で、type を持つ） */
  pushedKanjiQuizNotices: KanjiQuizNotice[]
  /** 押し出された配信を止める命令 */
  pushedStreamStops: StreamStopOrder[]
  /** 押し出された意見ボード */
  pushedOpinions: OpinionBoardSnapshot[]
  /** WebSocketの接続として引き渡されたリクエスト */
  forwardedConnections: Request[]
  /** 接続をすべて閉じるよう頼まれたときに添えられた、新しいキーの目印（オーバーレイ用キーの再発行） */
  revokedKeyTags: string[]
} => {
  const evictedAlerts: OverlayAlert[] = []
  const evictedBgm: BgmNowPlaying[] = []
  const evictedWorkLog: WorkLogEntry[] = []
  const evictedTaskDesk: TaskDeskSnapshot[] = []
  const evictedPomodoro: PomodoroSnapshot[] = []
  const evictedTownTours: TownTourCall[] = []
  const evictedTownTourAnswers: TownTourAnswerMessage[] = []
  const evictedTwisters: TwisterCall[] = []
  const evictedBgmDucks: BgmDuck[] = []
  const evictedSpeechMutes: SpeechMute[] = []
  const evictedTexts: TextsSnapshot[] = []
  const evictedKanjiQuizzes: KanjiQuizCall[] = []
  const evictedKanjiQuizNotices: KanjiQuizNotice[] = []
  const evictedStreamStops: StreamStopOrder[] = []
  const evictedOpinions: OpinionBoardSnapshot[] = []
  const handedOverConnections: Request[] = []
  const revokedTags: string[] = []
  const id: DurableObjectId = { toString: () => 'alerts', equals: (other) => other.toString() === 'alerts', name: 'alerts' }

  return {
    pushedAlerts: evictedAlerts,
    pushedBgm: evictedBgm,
    pushedWorkLog: evictedWorkLog,
    pushedTaskDesk: evictedTaskDesk,
    pushedPomodoro: evictedPomodoro,
    pushedTownTours: evictedTownTours,
    pushedTownTourAnswers: evictedTownTourAnswers,
    pushedTwisters: evictedTwisters,
    pushedBgmDucks: evictedBgmDucks,
    pushedSpeechMutes: evictedSpeechMutes,
    pushedTexts: evictedTexts,
    pushedKanjiQuizzes: evictedKanjiQuizzes,
    pushedKanjiQuizNotices: evictedKanjiQuizNotices,
    pushedStreamStops: evictedStreamStops,
    pushedOpinions: evictedOpinions,
    forwardedConnections: handedOverConnections,
    revokedKeyTags: revokedTags,
    namespace: {
      idFromName: () => id,
      get: () => ({
        fetch: async (request: Request) => {
          if (shouldFail) return new Response(null, { status: STATUS.internalServerError })
          // WebSocketの接続（101）はテストの環境では作れないので、引き渡されたことだけを記録して200を返す
          if (request.headers.get('Upgrade') === 'websocket') {
            handedOverConnections.push(request)
            return new Response(null, { status: STATUS.ok })
          }
          const { pathname } = new URL(request.url)
          if (pathname === '/revoke') {
            revokedTags.push(((await request.json()) as { keyTag: string }).keyTag)
            return new Response(null, { status: STATUS.noContent })
          }
          if (pathname === '/push/stream-stop') {
            if (noStreamStopReceiver) return new Response(null, { status: STATUS.conflict })
            evictedStreamStops.push((await request.json()) as StreamStopOrder)
            return new Response(null, { status: STATUS.noContent })
          }
          if (pathname === '/push/bgm') evictedBgm.push((await request.json()) as BgmNowPlaying)
          else if (pathname === '/push/work-log') evictedWorkLog.push((await request.json()) as WorkLogEntry)
          else if (pathname === '/push/task-desk') evictedTaskDesk.push((await request.json()) as TaskDeskSnapshot)
          else if (pathname === '/push/pomodoro') evictedPomodoro.push((await request.json()) as PomodoroSnapshot)
          else if (pathname === '/push/twister') evictedTwisters.push((await request.json()) as TwisterCall)
          else if (pathname === '/push/bgm-duck') evictedBgmDucks.push((await request.json()) as BgmDuck)
          else if (pathname === '/push/speech-mute') evictedSpeechMutes.push((await request.json()) as SpeechMute)
          else if (pathname === '/push/text') evictedTexts.push((await request.json()) as TextsSnapshot)
          else if (pathname === '/push/opinions') evictedOpinions.push((await request.json()) as OpinionBoardSnapshot)
          else if (pathname === '/push/kanji-quiz') {
            const body = (await request.json()) as KanjiQuizCall | KanjiQuizNotice
            if ('type' in body) evictedKanjiQuizNotices.push(body)
            else evictedKanjiQuizzes.push(body)
          }
          else if (pathname === '/push/town-tour') {
            const body = (await request.json()) as TownTourCall | TownTourAnswerMessage
            if ('type' in body) evictedTownTourAnswers.push(body)
            else evictedTownTours.push(body)
          }
          else evictedAlerts.push((await request.json()) as OverlayAlert)
          return new Response(null, { status: STATUS.noContent })
        },
      }),
    },
  }
}
