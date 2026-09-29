/**
 * アプリのページの一覧
 *
 * サイドバーの項目と、パスごとに描く中身をここで決める。
 * 実ファイルとして配信されるページ（overlay/stage/・overlay/backstage/・speech/reader/・transcript/relay/）は、ここには載せない。
 */
import { Bot, BrainCircuit, Camera, Captions, Layers, LayoutDashboard, Pencil, Quote, Upload, Users, Volume2, Wrench, Zap, type LucideIcon } from 'lucide-react'
import type { AdminApi, Me } from '@/admin/api'
import { BackstagePage } from '@/backstage/backstage-page'
import { MediaPage } from '@/admin/media-page'
import { TriggerPage } from '@/admin/trigger-page'
import type { BotApi } from '@/bot/api'
import { BotPage } from '@/bot/bot-page'
import { DrawPage } from '@/draw/draw-page'
import { connectDrawWriter } from '@/draw/socket'
import type { FocusApi } from '@/focus/api'
import { FocusPage } from '@/focus/focus-page'
import type { LlmApi } from '@/llm/api'
import { LlmPage } from '@/llm/llm-page'
import type { OverlayLayoutAdminApi } from '@/overlay/admin-api'
import { OverlayPage } from '@/overlay/overlay-page'
import type { StatsApi } from '@/stats/api'
import { StatsPage } from '@/stats/stats-page'
import type { ViewerApi } from '@/viewers/api'
import { ViewerPage } from '@/viewers/viewer-page'
import type { ScreenAdminApi } from '@/screen/api'
import { ScreenPage } from '@/screen/screen-page'
import type { SpeechApi } from '@/speech/api'
import { SpeechPage } from '@/speech/speech-page'
import { TranscriptPage } from '@/transcript/transcript-page'

/** ページが中身を描くのに使うもの */
export interface PageContext {
  api: AdminApi
  /** 配信の記録の読み出し（ダッシュボードが使う） */
  statsApi: StatsApi
  /** チャットボットの接続状態と送信（チャットボットのページが使う） */
  botApi: BotApi
  /** 視聴者の記録の読み書き（視聴者のページが使う） */
  viewerApi: ViewerApi
  /** 読み上げの設定の読み書き（読み上げのページが使う） */
  speechApi: SpeechApi
  /** 画面の取り込みの設定の読み書き（画面の取り込みのページが使う） */
  screenApi: ScreenAdminApi
  /** 注目コメント（いま取り上げているもの）の読み書き（注目コメントのページが使う） */
  focusApi: FocusApi
  /** LLMの提供元とモデルの設定の読み書き（LLMのページが使う） */
  llmApi: LlmApi
  /** 合成オーバーレイの構成の読み書き（オーバーレイのページが使う） */
  overlayApi: OverlayLayoutAdminApi
  me: Me
  /** オーバーレイ用キーを再発行した。ほかのページから戻ってきても新しいキーを出せるよう、枠が持つログイン情報を書き換える */
  onOverlayKeyChange(overlayKey: string): void
}

export interface Page {
  /** パス（末尾は必ずスラッシュ） */
  path: string
  /** サイドバーと見出しに出す名前 */
  name: string
  icon: LucideIcon
  render(context: PageContext): React.ReactNode
}

/** サイドバーの項目。上から順に並ぶ */
export const PAGE_GROUPS: readonly { label: string; pages: readonly Page[] }[] = [
  {
    label: '配信',
    pages: [
      { path: '/', name: 'ダッシュボード', icon: LayoutDashboard, render: ({ statsApi }) => <StatsPage api={statsApi} /> },
      { path: '/bot/', name: 'チャットボット', icon: Bot, render: ({ botApi }) => <BotPage api={botApi} /> },
      { path: '/viewers/', name: '視聴者', icon: Users, render: ({ viewerApi }) => <ViewerPage api={viewerApi} /> },
      { path: '/transcript/', name: '文字起こし', icon: Captions, render: ({ me }) => <TranscriptPage overlayKey={me.overlayKey} /> },
      {
        path: '/focus/',
        name: '注目コメント',
        icon: Quote,
        // 取り上げるものはWorkerに保存されるので、オーバーレイはURLを貼り替えずに切り替わる
        render: ({ focusApi }) => <FocusPage api={focusApi} />,
      },
      {
        path: '/speech/',
        name: '読み上げ',
        icon: Volume2,
        // 読み上げのページはWorkerに置いた設定をオーバーレイ用キーで読む。botの状態は「読み上げない人」に足すために読む
        render: ({ speechApi, botApi, me }) => <SpeechPage api={speechApi} botApi={botApi} overlayKey={me.overlayKey} />,
      },
      {
        path: '/screen/',
        name: '画面の取り込み',
        icon: Camera,
        // 撮るのは裏方のページ（/backstage/ で動かすかどうかを選ぶ）で、この画面はつなぎ先と間隔の設定だけを持つ
        render: ({ screenApi }) => <ScreenPage api={screenApi} />,
      },
      {
        path: '/draw/',
        name: '手書き',
        icon: Pencil,
        // 描いた線は中継先（Durable Object）を通って合成ページへ直接届くので、保存も読み出しも要らない
        render: () => <DrawPage connect={connectDrawWriter} />,
      },
      {
        path: '/overlay/',
        name: 'オーバーレイ',
        icon: Layers,
        // 構成はWorkerに保存されるので、オーバーレイごとのブラウザソースのURLは貼り替えずに中身が切り替わる
        render: ({ overlayApi, me }) => <OverlayPage api={overlayApi} overlayKey={me.overlayKey} />,
      },
      {
        path: '/backstage/',
        name: '裏方',
        icon: Wrench,
        // 映すものを持たない裏方（読み上げ・文字起こしの中継）を1つのブラウザソースにまとめるURLを出す（issue #108）
        render: ({ me }) => <BackstagePage overlayKey={me.overlayKey} />,
      },
      { path: '/llm/', name: 'LLM', icon: BrainCircuit, render: ({ llmApi }) => <LlmPage api={llmApi} /> },
      {
        path: '/triggers/',
        name: 'トリガー',
        icon: Zap,
        // botの接続状態も読む（未接続だとチャットとアナウンスの動作が動かないので、トリガーのページで知らせる）
        render: ({ api, botApi, me, onOverlayKeyChange }) => (
          <TriggerPage api={api} botApi={botApi} overlayKey={me.overlayKey} onOverlayKeyChange={onOverlayKeyChange} />
        ),
      },
    ],
  },
  {
    label: '素材',
    pages: [{ path: '/media/', name: 'アップロード', icon: Upload, render: ({ api }) => <MediaPage api={api} /> }],
  },
]

/** パスに当たるページ。なければ undefined（呼び出し側が「見つからない」画面を出す） */
export const findPage = (pathname: string): Page | undefined => PAGE_GROUPS.flatMap((group) => group.pages).find((page) => page.path === pathname)
