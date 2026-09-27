/**
 * 注目コメントのオーバーレイの、OBSに貼るURLの組み立て
 *
 * 画面（focus-page.tsx）から分けてテストする（サイドスーパー・文字起こしの url.ts と同じ扱い）。
 *
 * 注意: 取り上げるものはWorkerが持つので、URLには入れない（配信中に相手を変えるたびにOBSのURLを
 * 貼り替えることになるため。読み上げの設定をURLから移した issue #86 と同じ考え方）。
 */

/** オーバーレイのパス（focus/overlay/index.html として配信される。/focus/ はアプリのページに使う） */
const OVERLAY_PATH = '/focus/overlay/'

/**
 * OBSのブラウザソースに貼るURLを組み立てる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param overlayKey オーバーレイ用キー
 */
export const focusUrl = (origin: string, overlayKey: string): string => `${origin}${OVERLAY_PATH}?key=${encodeURIComponent(overlayKey)}`

/**
 * サンプルを流すデモのURLを組み立てる。
 *
 * デモは Worker に接続しないので、オーバーレイ用キーを付けない（src/focus/stage.ts）。
 * 取り上げるものが決まるのを待たずに見栄えと配置を確かめるためのもので、OBSのブラウザソースにも
 * ブラウザのタブにも貼れる（サイドスーパー・アラートの ?demo=true と同じ考え方）。
 *
 * @param origin このサイトの起点（window.location.origin）
 */
export const focusDemoUrl = (origin: string): string => `${origin}${OVERLAY_PATH}?demo=true`
