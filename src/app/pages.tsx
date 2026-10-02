/**
 * アプリのページの一覧
 *
 * サイドバーの項目と、パスごとに描く中身をここで決める。
 * 実ファイルとして配信されるページ（overlay/stage/・overlay/backstage/・speech/reader/・transcript/relay/）は、ここには載せない。
 */
import { AppWindow, Bot, BrainCircuit, Camera, Captions, Gift, Layers, LayoutDashboard, MessagesSquare, Music, Pencil, Quote, Upload, Users, Volume2, Wrench, Zap, type LucideIcon } from 'lucide-react'
import type { AdminApi, Me } from '@/admin/api'
import { BackstagePage } from '@/backstage/backstage-page'
import type { BgmApi } from '@/bgm/api'
import { BgmPage } from '@/bgm/bgm-page'
import { MediaPage } from '@/admin/media-page'
import { RewardPage } from '@/admin/reward-page'
import { TriggerPage } from '@/admin/trigger-page'
import type { BotApi } from '@/bot/api'
import { BotPage } from '@/bot/bot-page'
import type { CommentApi } from '@/comments/api'
import { CommentsPage } from '@/comments/comments-page'
import { connectCommentFeed } from '@/comments/socket'
import type { DrawApi } from '@/draw/api'
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
import { TabPage } from '@/tab/tab-page'

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
  /** 発言した人のアイコンとバッジの画像の読み出し（コメントビューアーのページが使う） */
  commentApi: CommentApi
  /** 手書きで描いたものの読み書き（手書きのページが使う） */
  drawApi: DrawApi
  /** LLMの提供元とモデルの設定の読み書き（LLMのページが使う） */
  llmApi: LlmApi
  /** 合成オーバーレイの構成の読み書き（オーバーレイのページが使う） */
  overlayApi: OverlayLayoutAdminApi
  /** BGMの曲と、流す曲・音量の読み書き（BGMのページが使う） */
  bgmApi: BgmApi
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
  /** ページを探す窓（page-search.tsx）で、名前のほかに当てはまる言葉 */
  keywords?: readonly string[]
  render(context: PageContext): React.ReactNode
}

/** サイドバーの項目。上から順に並ぶ（まとまりは「いつ開くか」で分ける） */
export const PAGE_GROUPS: readonly { label: string; pages: readonly Page[] }[] = [
  {
    // 配信しながら開いておく画面
    label: '配信中',
    pages: [
      { path: '/', keywords: ['統計', '配信の記録', 'フォロワー'], name: 'ダッシュボード', icon: LayoutDashboard, render: ({ statsApi }) => <StatsPage api={statsApi} /> },
      {
        path: '/comments/',
        keywords: ['チャット', '初コメ', '挨拶'],
        name: 'コメント',
        icon: MessagesSquare,
        // 発言と出来事は配送先（Durable Object）から WebSocket でその場で届く。開き直すと直近の履歴から並べ直す。
        // 発言は注目コメントのページと同じ Worker の経路で、注目コメントに設定できる
        render: ({ commentApi, focusApi }) => <CommentsPage api={commentApi} focusApi={focusApi} connect={connectCommentFeed} />,
      },
      {
        path: '/focus/',
        keywords: ['取り上げ', 'コメント'],
        name: '注目コメント',
        icon: Quote,
        // 取り上げるものはWorkerに保存されるので、オーバーレイはURLを貼り替えずに切り替わる
        render: ({ focusApi }) => <FocusPage api={focusApi} />,
      },
      {
        path: '/draw/',
        keywords: ['ペン', 'お絵描き'],
        name: '手書き',
        icon: Pencil,
        // 描いた線は中継先（Durable Object）を通って合成ページへその場で届き、引き終えたものはWorkerへ写して残す
        render: ({ drawApi }) => <DrawPage connect={connectDrawWriter} api={drawApi} />,
      },
      {
        path: '/bgm/',
        keywords: ['音楽', '曲', 'クレジット'],
        name: 'BGM',
        icon: Music,
        // 鳴らすのは裏方のページ（/backstage/ で BGM を入れる）で、流す曲と音量の切り替えは Worker が押し出す（issue #151）。
        // 曲にする音声は、アップロードのページで上げた素材から選ぶ
        render: ({ bgmApi, api }) => <BgmPage api={bgmApi} mediaApi={api} />,
      },
      { path: '/viewers/', keywords: ['常連', '人物像'], name: '視聴者', icon: Users, render: ({ viewerApi }) => <ViewerPage api={viewerApi} /> },
    ],
  },
  {
    // OBSに載せるもの・OBSのそばで動かすものの設定
    label: '配信画面',
    pages: [
      {
        path: '/overlay/',
        keywords: ['OBS', 'ブラウザソース', 'URL', '素材'],
        name: 'オーバーレイ',
        icon: Layers,
        // 構成はWorkerに保存されるので、オーバーレイごとのブラウザソースのURLは貼り替えずに中身が切り替わる
        render: ({ overlayApi, me }) => <OverlayPage api={overlayApi} overlayKey={me.overlayKey} />,
      },
      {
        path: '/backstage/',
        keywords: ['OBS', 'ブラウザソース', 'URL'],
        name: '裏方',
        icon: Wrench,
        // 映すものを持たない裏方（読み上げ・文字起こしの中継・画面の取り込み・BGM）を1つのブラウザソースにまとめるURLを出す（issue #108）
        render: ({ me }) => <BackstagePage overlayKey={me.overlayKey} />,
      },
      {
        path: '/tab/',
        keywords: ['Chrome', '拡張', 'ブラウザ'],
        name: 'タブの映像',
        icon: AppWindow,
        // 取り込みと送信・映さないサイトの管理は拡張（extension/）の中で行い、このページは拡張を配って使い方を案内するだけ
        render: () => <TabPage />,
      },
      { path: '/transcript/', keywords: ['ゆかコネNEO', '字幕', 'OBS'], name: '文字起こし', icon: Captions, render: ({ me }) => <TranscriptPage overlayKey={me.overlayKey} /> },
      {
        path: '/speech/',
        keywords: ['VOICEVOX', '棒読み'],
        name: '読み上げ',
        icon: Volume2,
        // 読み上げのページはWorkerに置いた設定をオーバーレイ用キーで読む。botの状態は「読み上げない人」に追加するために読む
        render: ({ speechApi, botApi, me }) => <SpeechPage api={speechApi} botApi={botApi} overlayKey={me.overlayKey} />,
      },
      {
        path: '/screen/',
        keywords: ['OCR', 'Gyazo', 'obs-websocket'],
        name: '画面の取り込み',
        icon: Camera,
        // 撮るのは裏方のページ（/backstage/ で動かすかどうかを選ぶ）で、この画面はつなぎ先と間隔の設定だけを持つ
        render: ({ screenApi }) => <ScreenPage api={screenApi} />,
      },
    ],
  },
  {
    // 出来事に合わせてbotやAIが動くもの
    label: '自動化',
    pages: [
      {
        path: '/triggers/',
        keywords: ['アラート', '通知', 'フォロー', 'レイド'],
        name: 'トリガー',
        icon: Zap,
        // botの接続状態も読む（未接続だとチャットとアナウンスの動作が動かないので、トリガーのページで知らせる）
        render: ({ api, botApi, me, onOverlayKeyChange }) => (
          <TriggerPage api={api} botApi={botApi} overlayKey={me.overlayKey} onOverlayKeyChange={onOverlayKeyChange} />
        ),
      },
      { path: '/bot/', keywords: ['コマンド', 'モデレーション'], name: 'チャットボット', icon: Bot, render: ({ botApi }) => <BotPage api={botApi} /> },
      {
        path: '/rewards/',
        keywords: ['報酬', 'チャネポ'],
        name: 'チャンネルポイント',
        icon: Gift,
        // 報酬の作成・編集・削除（issue #160）。交換されたときに何をするかはトリガーのページで決める
        render: ({ api }) => <RewardPage api={api} />,
      },
      { path: '/llm/', keywords: ['AI', 'モデル', 'OpenRouter', 'Workers AI'], name: 'LLM', icon: BrainCircuit, render: ({ llmApi }) => <LlmPage api={llmApi} /> },
    ],
  },
  {
    // アラートやBGMで使うファイル
    label: '素材',
    pages: [
      { path: '/media/', keywords: ['画像', '動画', '音声', '素材'], name: 'アップロード', icon: Upload, render: ({ api }) => <MediaPage api={api} /> },
    ],
  },
]

/** パスに当たるページ。なければ undefined（呼び出し側が「見つからない」画面を出す） */
export const findPage = (pathname: string): Page | undefined => PAGE_GROUPS.flatMap((group) => group.pages).find((page) => page.path === pathname)
