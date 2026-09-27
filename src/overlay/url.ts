/**
 * 合成ページ（overlay/stage/index.html）の、OBSに貼るURLの組み立て
 *
 * 画面（overlay-page.tsx）から分けてテストする（サイドスーパー・注目コメントの url.ts と同じ扱い）。
 *
 * 注意: URLに入るのはオーバーレイ用キーとオーバーレイの名前だけである。どのオーバーレイにどの素材を
 * どこへ置くかは Worker が持つ構成（KVの overlay-layout）で決まるので、名前を変えないかぎりURLは変わらない
 * （issue #101 で狙った「OBSには触らず、アプリ上の編集だけで済む」ため）。
 * 注意: 合成ページの実ファイルを /overlay/stage/ に置くのは、/overlay/ をアプリのページ
 * （レイヤーを編集する管理画面）に使うためである（/side-super/・/focus/ と同じ分け方）。
 */

/** 合成ページのパス（overlay/stage/index.html として配信される） */
const STAGE_PATH = '/overlay/stage/'

/**
 * オーバーレイ（＝OBSのブラウザソース1つ）ごとに貼るURLを組み立てる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param overlayKey オーバーレイ用キー
 * @param name 描くオーバーレイの名前
 * @throws 名前が空の場合（貼っても何も映らないURLを作らせない）
 */
export const overlayStageUrl = (origin: string, overlayKey: string, name: string): string => {
  if (name === '') throw new Error('オーバーレイの名前が空です')
  return `${origin}${STAGE_PATH}?key=${encodeURIComponent(overlayKey)}&overlay=${encodeURIComponent(name)}`
}
