/**
 * 合成ページ（overlay/stage/index.html）の、OBSに貼るURLの組み立て
 *
 * 画面（overlay-page.tsx）から分けてテストする（サイドスーパー・注目コメントの url.ts と同じ扱い）。
 *
 * 注意: URLに入るのはオーバーレイ用キーとオーバーレイの名前だけである。どのオーバーレイにどの素材を
 * どこへ置くかは Worker が持つ構成（KVの overlay-layout）で決まるので、名前を変えないかぎりURLは変わらない
 * （issue #101 で狙った「OBSには触らず、アプリ上の編集だけで済む」ため）。
 * 注意: 合成ページの実ファイルを /overlay/stage/ に置くのは、/overlay/ をアプリのページ
 * （レイヤーを編集する管理画面）に使うためである（/side-super/ と同じ分け方）。
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

/**
 * 管理画面のプレビュー（iframe）に出す、同じ合成ページのURLを組み立てる。
 *
 * オーバーレイ用キーを付けないのは、プレビューでは Twitch にも Worker にもつながず、素材の中身をすべて
 * サンプルにするためである（?demo=true。issue #106 で懸念した「配信中のものに加えてもう1組動く」ことを
 * 無くす）。映す構成は Worker から読まずに親の窓から受け取るので（preview.ts）、編集中の位置と
 * パラメータがそのまま映る。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param name 映すオーバーレイの名前
 * @throws 名前が空の場合（何も映らないプレビューを開かせない）
 */
export const overlayPreviewUrl = (origin: string, name: string): string => {
  if (name === '') throw new Error('オーバーレイの名前が空です')
  return `${origin}${STAGE_PATH}?overlay=${encodeURIComponent(name)}&demo=true`
}

/**
 * オーバーレイを追加するときに、名前がURLのどこに載るかをその場で見せるための下書き用URLを組み立てる。
 *
 * オーバーレイ用キーを `…` に置き換えるのは、名前を打っているあいだ画面に出したままになるためである
 * （配信画面に映り込んでも読めないようにする。カードのURL欄を伏せ字にしているのと同じ理由）。
 * 貼るためのURLではないので、そのままOBSには使えない。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param name 追加しようとしているオーバーレイの名前
 * @throws 名前が空の場合（名前の載っていないURLを見せない）
 */
export const overlayStageUrlOutline = (origin: string, name: string): string => {
  if (name === '') throw new Error('オーバーレイの名前が空です')
  return `${origin}${STAGE_PATH}?key=…&overlay=${encodeURIComponent(name)}`
}
