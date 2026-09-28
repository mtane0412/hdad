/**
 * アプリのページの一覧
 *
 * サイドバーの項目と、パスごとに描く中身をここで決める。カテゴリを増やしたらここに足す。
 * ギャラリーの素材ページ（/wallpaper/<id>/ など）と、実ファイルとして配信されるオーバーレイ（alerts/・side-super/overlay/・transcript/relay/・speech/reader/・focus/overlay/・overlay/stage/）は、ここには載せない。
 */
import { Bot, BrainCircuit, Captions, Clock, Image, Layers, LayoutDashboard, MessageSquare, PanelTop, Quote, Upload, Users, Volume2, Zap, type LucideIcon } from 'lucide-react'
import type { AdminApi, Me } from '@/admin/api'
import { MediaPage } from '@/admin/media-page'
import { TriggerPage } from '@/admin/trigger-page'
import type { BotApi } from '@/bot/api'
import { BotPage } from '@/bot/bot-page'
import { chats } from '@/chat/registry'
import type { FocusApi } from '@/focus/api'
import { FocusPage } from '@/focus/focus-page'
import { clocks } from '@/clock/registry'
import { Gallery } from '@/core/gallery/gallery'
import type { LlmApi } from '@/llm/api'
import { LlmPage } from '@/llm/llm-page'
import type { OverlayLayoutAdminApi } from '@/overlay/admin-api'
import { RECOMMENDED_ITEM_SIZES } from '@/overlay/layout'
import { OverlayPage } from '@/overlay/overlay-page'
import type { StatsApi } from '@/stats/api'
import { StatsPage } from '@/stats/stats-page'
import type { ViewerApi } from '@/viewers/api'
import { ViewerPage } from '@/viewers/viewer-page'
import { SideSuperPage } from '@/side-super/side-super-page'
import type { SpeechApi } from '@/speech/api'
import { SpeechPage } from '@/speech/speech-page'
import { TranscriptPage } from '@/transcript/transcript-page'
import { backgrounds } from '@/wallpaper/registry'

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
      { path: '/side-super/', name: 'サイドスーパー', icon: PanelTop, render: ({ me }) => <SideSuperPage overlayKey={me.overlayKey} /> },
      {
        path: '/focus/',
        name: '注目コメント',
        icon: Quote,
        // 取り上げるものはWorkerに保存されるので、オーバーレイはURLを貼り替えずに切り替わる
        render: ({ focusApi, me }) => <FocusPage api={focusApi} overlayKey={me.overlayKey} />,
      },
      {
        path: '/speech/',
        name: '読み上げ',
        icon: Volume2,
        // 読み上げのページはWorkerに置いた設定をオーバーレイ用キーで読む。botの状態は「読み上げない人」に足すために読む
        render: ({ speechApi, botApi, me }) => <SpeechPage api={speechApi} botApi={botApi} overlayKey={me.overlayKey} />,
      },
      {
        path: '/overlay/',
        name: 'オーバーレイ',
        icon: Layers,
        // 構成はWorkerに保存されるので、オーバーレイごとのブラウザソースのURLは貼り替えずに中身が切り替わる
        render: ({ overlayApi, me }) => <OverlayPage api={overlayApi} overlayKey={me.overlayKey} />,
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
    pages: [
      {
        path: '/wallpaper/',
        name: '壁紙',
        icon: Image,
        render: () => <Gallery definitions={backgrounds} noun="背景" basePath="/wallpaper/" previewSize={RECOMMENDED_ITEM_SIZES.wallpaper} />,
      },
      {
        path: '/clock/',
        name: '時計',
        icon: Clock,
        render: () => <Gallery definitions={clocks} noun="時計" basePath="/clock/" previewSize={RECOMMENDED_ITEM_SIZES.clock} />,
      },
      {
        path: '/chat/',
        name: 'チャット',
        icon: MessageSquare,
        // プレビューは常にサンプル表示（demo=true）にする。調整のたびにTwitchへ接続し直さないためと、
        // チャンネル名が未入力でも見た目を確かめられるようにするため。OBS用のURLには影響しない
        render: () => (
          <Gallery definitions={chats} noun="チャットボックス" basePath="/chat/" previewSize={RECOMMENDED_ITEM_SIZES.chat} previewOverrides={{ demo: true }} />
        ),
      },
      { path: '/media/', name: 'アップロード', icon: Upload, render: ({ api }) => <MediaPage api={api} /> },
    ],
  },
]

/** パスに当たるページ。なければ undefined（呼び出し側が「見つからない」画面を出す） */
export const findPage = (pathname: string): Page | undefined => PAGE_GROUPS.flatMap((group) => group.pages).find((page) => page.path === pathname)
