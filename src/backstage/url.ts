/**
 * 裏方のページ（overlay/backstage/index.html）の、OBSに貼るURLの組み立て
 *
 * 画面（backstage-page.tsx）から分けてテストする（speech/url.ts と同じ扱い）。
 *
 * 裏方（読み上げ・画面の取り込み・BGM・配信の停止）は映すものを持たないので、位置も大きさも持たない。そのため合成ページ
 * （overlay/stage/）の素材にはせず、裏方だけの1枚にまとめている（issue #108）。どの裏方を動かすかは
 * 「このブラウザソースが何をするか」という構造の指定なので、合成ページの ?overlay=<名前> と同じくURLに持たせる
 * （配信中に変える設定ではないため、issue #86 でWorkerへ移した「設定」とは扱いを分ける）。
 *
 * 注意: URLを短く保つため、既定（読み上げを動かす・画面の取り込みとBGMと配信の停止は動かさない）と同じ指定は書き足さない。
 * 注意: 裏方をひとつも動かさないURLは組み立てない（貼っても何もしないブラウザソースを作らせない。
 *   素材を1つも持たないオーバーレイを保存しないのと同じ考え方）。
 */
/** 裏方のページのパス（overlay/backstage/index.html として配信される） */
const BACKSTAGE_PATH = '/overlay/backstage/'

/** このブラウザソースで動かす裏方 */
export interface BackstageTasks {
  /** チャットの読み上げ（VOICEVOX ENGINE に読ませる） */
  readonly speech: boolean
  /**
   * 配信画面の取り込み（OBS から撮った1枚を Worker へ送る）。
   *
   * 既定では動かさない。動かすには OBS の WebSocket サーバーと、Worker 側の Gyazo のアクセストークンの
   * 両方が要るので、何も用意していない配信者のブラウザソースが起動のたびに失敗を出さないようにする。
   */
  readonly screen: boolean
  /**
   * BGM（管理画面で選んだ曲を鳴らす）。
   *
   * 既定では鳴らさない。OBSに貼ってある裏方のブラウザソースが、曲を選んだ途端に黙って鳴り出さないようにする。
   */
  readonly bgm: boolean
  /**
   * 配信の停止（漢字クイズが時間切れのとき、OBS へ StopStream を送る。issue #302）。
   *
   * 既定では動かさない。OBS の WebSocket サーバーの用意が要るうえ、配信を止める力を持つので、選んだときだけ動かす。
   */
  readonly stop: boolean
}

/**
 * OBSのブラウザソースに貼るURLを組み立てる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param overlayKey オーバーレイ用キー
 * @param tasks 動かす裏方
 * @throws 裏方をひとつも動かさないとき
 */
export const backstageUrl = (origin: string, overlayKey: string, tasks: BackstageTasks): string => {
  if (!tasks.speech && !tasks.screen && !tasks.bgm && !tasks.stop) {
    throw new Error('動かす裏方を1つ以上選んでください（ひとつも動かさないブラウザソースは貼っても何もしません）')
  }
  const query = new URLSearchParams({ key: overlayKey })
  if (!tasks.speech) query.set('speech', 'false')
  if (tasks.screen) query.set('screen', 'true')
  if (tasks.bgm) query.set('bgm', 'true')
  if (tasks.stop) query.set('stop', 'true')
  return `${origin}${BACKSTAGE_PATH}?${query}`
}
