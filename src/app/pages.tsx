/**
 * アプリのページの一覧
 *
 * サイドバーの項目と、パスごとに描く中身をここで決める。
 * 実ファイルとして配信されるページ（overlay/stage/・overlay/backstage/・speech/reader/）は、ここには載せない。
 */
import { Bot, BrainCircuit, Gift, Layers, LayoutDashboard, MessagesSquare, Music, Pencil, Plug, Upload, Users, Zap, type LucideIcon } from 'lucide-react'
import type { AdminApi, Me } from '@/admin/api'
import { BackstagePage } from '@/backstage/backstage-page'
import type { BgmApi } from '@/bgm/api'
import { BgmPage } from '@/bgm/bgm-page'
import { connectBgmWatch } from '@/bgm/socket'
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
import type { LlmApi } from '@/llm/api'
import { LlmPage } from '@/llm/llm-page'
import type { OverlayLayoutAdminApi } from '@/overlay/admin-api'
import { OverlayPage } from '@/overlay/overlay-page'
import type { StatsApi } from '@/stats/api'
import { StatsPage } from '@/stats/stats-page'
import type { ViewerApi } from '@/viewers/api'
import { ViewerPage } from '@/viewers/viewer-page'
import type { ScreenAdminApi } from '@/screen/api'
import type { SpeechApi } from '@/speech/api'

/** ページが中身を描くのに使うもの */
export interface PageContext {
  api: AdminApi
  /** 配信の記録の読み出し（ダッシュボードが使う） */
  statsApi: StatsApi
  /** チャットボットの接続状態と送信（チャットボットのページが使う） */
  botApi: BotApi
  /** 視聴者の記録の読み書き（視聴者のページが使う） */
  viewerApi: ViewerApi
  /** 読み上げの設定の読み書き（コネクターのページの VOICEVOX の区画が使う） */
  speechApi: SpeechApi
  /** 画面の取り込みの設定の読み書き（コネクターのページの Gyazo の区画が使う） */
  screenApi: ScreenAdminApi
  /** 注目コメント（いま取り上げているもの）の読み書き（コメントのページが使う） */
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
        keywords: ['チャット', '初コメ', '挨拶', '注目コメント', '取り上げ'],
        name: 'コメント',
        icon: MessagesSquare,
        // 発言と出来事は配送先（Durable Object）から WebSocket でその場で届く。開き直すと直近の履歴から並べ直す。
        // 発言は行のボタンから注目コメントに設定できる（注目コメント専用のページは持たない）
        render: ({ commentApi, focusApi }) => <CommentsPage api={commentApi} focusApi={focusApi} connect={connectCommentFeed} />,
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
        // 鳴らすのは裏方のページ（/connectors/ で BGM を入れる）で、流す曲と音量の切り替えは Worker が押し出す（issue #151）。
        // 曲にする音声は、アップロードのページで上げた素材から選ぶ
        render: ({ bgmApi, api, me }) => <BgmPage api={bgmApi} mediaApi={api} overlayKey={me.overlayKey} connect={connectBgmWatch} />,
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
        path: '/connectors/',
        keywords: ['裏方', 'OBS', 'ブラウザソース', 'URL', 'VOICEVOX', '読み上げ', 'Web Speech API', '音声認識', '文字起こし', 'Gyazo', '画面の取り込み', 'OCR', 'HDAD-tab', 'タブの映像', 'Chrome', '拡張'],
        name: 'コネクター',
        icon: Plug,
        // 外部のサービスとつなぐものをまとめる。映すものを持たない裏方（VOICEVOX・Gyazo・BGM）を
        // 1つのブラウザソースにまとめるURLを出し（issue #108）、VOICEVOX・Gyazo の設定と HDAD-tab の配布、音声認識のオン・オフを同じページに並べる
        render: ({ me, speechApi, botApi, screenApi }) => (
          <BackstagePage overlayKey={me.overlayKey} speechApi={speechApi} botApi={botApi} screenApi={screenApi} />
        ),
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
