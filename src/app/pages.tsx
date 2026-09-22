/**
 * アプリのページの一覧
 *
 * サイドバーの項目と、パスごとに描く中身をここで決める。カテゴリを増やしたらここに足す。
 * ギャラリーの素材ページ（/wallpaper/<id>/ など）と alerts/ は実ファイルとして配信されるので、ここには載せない。
 */
import { Bot, Clock, Image, LayoutDashboard, MessageSquare, Upload, Zap, type LucideIcon } from 'lucide-react'
import type { AdminApi, Me } from '@/admin/api'
import { MediaPage } from '@/admin/media-page'
import { TriggerPage } from '@/admin/trigger-page'
import type { BotApi } from '@/bot/api'
import { BotPage } from '@/bot/bot-page'
import { chats } from '@/chat/registry'
import { clocks } from '@/clock/registry'
import { Gallery } from '@/core/gallery/gallery'
import type { StatsApi } from '@/stats/api'
import { StatsPage } from '@/stats/stats-page'
import { backgrounds } from '@/wallpaper/registry'

/** ページが中身を描くのに使うもの */
export interface PageContext {
  api: AdminApi
  /** 配信の記録の読み出し（ダッシュボードが使う） */
  statsApi: StatsApi
  /** チャットボットの接続状態と送信（チャットボットのページが使う） */
  botApi: BotApi
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
      {
        path: '/triggers/',
        name: 'トリガー',
        icon: Zap,
        render: ({ api, me, onOverlayKeyChange }) => <TriggerPage api={api} overlayKey={me.overlayKey} onOverlayKeyChange={onOverlayKeyChange} />,
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
        render: () => <Gallery definitions={backgrounds} noun="背景" basePath="/wallpaper/" previewSize={{ width: 1920, height: 1080 }} />,
      },
      {
        path: '/clock/',
        name: '時計',
        icon: Clock,
        render: () => <Gallery definitions={clocks} noun="時計" basePath="/clock/" previewSize={{ width: 600, height: 240 }} />,
      },
      {
        path: '/chat/',
        name: 'チャット',
        icon: MessageSquare,
        // プレビューは常にサンプル表示（demo=true）にする。調整のたびにTwitchへ接続し直さないためと、
        // チャンネル名が未入力でも見た目を確かめられるようにするため。OBS用のURLには影響しない
        render: () => (
          <Gallery definitions={chats} noun="チャットボックス" basePath="/chat/" previewSize={{ width: 480, height: 800 }} previewOverrides={{ demo: true }} />
        ),
      },
      { path: '/media/', name: 'アップロード', icon: Upload, render: ({ api }) => <MediaPage api={api} /> },
    ],
  },
]

/** パスに当たるページ。なければ undefined（呼び出し側が「見つからない」画面を出す） */
export const findPage = (pathname: string): Page | undefined => PAGE_GROUPS.flatMap((group) => group.pages).find((page) => page.path === pathname)
