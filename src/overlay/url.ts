/**
 * 合成ページ（overlay/stage/index.html）の、OBSに貼るURLの組み立て
 *
 * 画面（overlay-page.tsx）から分けてテストする（サイドスーパー・注目コメントの url.ts と同じ扱い）。
 *
 * 注意: URLに入るのはオーバーレイ用キーと段の名前だけである。どの段にどの素材をどこへ置くかは
 * Worker が持つ構成（KVの overlay-layout）で決まるので、段の名前を変えないかぎりURLは変わらない
 * （issue #101 で狙った「OBSには触らず、アプリ上の編集だけで済む」ため）。
 * 注意: 合成ページの実ファイルを /overlay/stage/ に置くのは、/overlay/ をアプリのページ
 * （レイヤーを編集する管理画面）に使うためである（/side-super/・/focus/ と同じ分け方）。
 */

/** 合成ページのパス（overlay/stage/index.html として配信される） */
const STAGE_PATH = '/overlay/stage/'

/**
 * 段ごとのOBSのブラウザソースに貼るURLを組み立てる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param overlayKey オーバーレイ用キー
 * @param group 描く段の名前
 * @throws 段の名前が空の場合（貼っても何も映らないURLを作らせない）
 */
export const overlayStageUrl = (origin: string, overlayKey: string, group: string): string => {
  if (group === '') throw new Error('段の名前が空です')
  return `${origin}${STAGE_PATH}?key=${encodeURIComponent(overlayKey)}&group=${encodeURIComponent(group)}`
}
