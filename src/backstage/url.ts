/**
 * 裏方のページ（overlay/backstage/index.html）の、OBSに貼るURLの組み立て
 *
 * 画面（backstage-page.tsx）から分けてテストする（transcript/url.ts・speech/url.ts と同じ扱い）。
 *
 * 裏方（読み上げ・文字起こしの中継・画面の取り込み）は映すものを持たないので、位置も大きさも持たない。そのため合成ページ
 * （overlay/stage/）の素材にはせず、裏方だけの1枚にまとめている（issue #108）。どの裏方を動かすかは
 * 「このブラウザソースが何をするか」という構造の指定なので、合成ページの ?overlay=<名前> と同じくURLに持たせる
 * （配信中に変える設定ではないため、issue #86 でWorkerへ移した「設定」とは扱いを分ける）。
 *
 * 注意: URLを短く保つため、既定（読み上げと文字起こしを動かす・画面の取り込みは動かさない・既定のポート）と
 *   同じ指定は書き足さない。
 * 注意: 裏方をひとつも動かさないURLは組み立てない（貼っても何もしないブラウザソースを作らせない。
 *   素材を1つも持たないオーバーレイを保存しないのと同じ考え方）。
 */
import { assertTranscriptPort, DEFAULT_TRANSCRIPT_PORT } from '../transcript/url'

/** 裏方のページのパス（overlay/backstage/index.html として配信される） */
const BACKSTAGE_PATH = '/overlay/backstage/'

/** このブラウザソースで動かす裏方 */
export interface BackstageTasks {
  /** チャットの読み上げ（VOICEVOX ENGINE に読ませる） */
  readonly speech: boolean
  /** 文字起こしの中継（ゆかコネNEO の発話を Worker へ送る） */
  readonly transcript: boolean
  /**
   * 配信画面の取り込み（OBS から撮った1枚を Worker へ送る）。
   *
   * 既定では動かさない。動かすには OBS の WebSocket サーバーと、Worker 側の Gyazo のアクセストークンの
   * 両方が要るので、何も用意していない配信者のブラウザソースが起動のたびに失敗を出さないようにする。
   */
  readonly screen: boolean
  /** ゆかコネNEO の WebSocket のポート番号。文字起こしを動かすときだけ使う */
  readonly port: number
}

/**
 * OBSのブラウザソースに貼るURLを組み立てる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param overlayKey オーバーレイ用キー
 * @param tasks 動かす裏方とポート番号
 * @throws 裏方をひとつも動かさないとき、または文字起こしを動かすのにポートが読めないとき
 */
export const backstageUrl = (origin: string, overlayKey: string, tasks: BackstageTasks): string => {
  if (!tasks.speech && !tasks.transcript && !tasks.screen) {
    throw new Error('動かす裏方を1つ以上選んでください（ひとつも動かさないブラウザソースは貼っても何もしません）')
  }
  // ポートは文字起こしを動かすときだけ使う。動かさないなら読めない値でも咎めない（そのポートへはつながないため）
  if (tasks.transcript) assertTranscriptPort(tasks.port)

  const query = new URLSearchParams({ key: overlayKey })
  if (!tasks.speech) query.set('speech', 'false')
  if (!tasks.transcript) query.set('transcript', 'false')
  if (tasks.screen) query.set('screen', 'true')
  if (tasks.transcript && tasks.port !== DEFAULT_TRANSCRIPT_PORT) query.set('port', String(tasks.port))
  return `${origin}${BACKSTAGE_PATH}?${query}`
}
