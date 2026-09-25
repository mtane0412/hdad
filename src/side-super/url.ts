/**
 * サイドスーパーのオーバーレイの、OBSに貼るURLの組み立て
 *
 * 画面（side-super-page.tsx）から分けてテストする（transcript/url.ts と同じ扱い）。
 *
 * 注意: 既定と同じ値はURLに書き足さない。URLを短く保ち、貼り間違いを減らすためである
 * （relayUrl のポート番号と同じ扱い）。
 */

/** オーバーレイのパス（side-super/overlay/index.html として配信される） */
const OVERLAY_PATH = '/side-super/overlay/'

/** 画面のどちら側に出すか */
export type SideSuperPosition = 'left' | 'right'

/** 寄せる向きの既定。URLに書かなければこちらになる（src/side-super/stage.ts のスキーマと合わせる） */
export const DEFAULT_SIDE_SUPER_POSITION: SideSuperPosition = 'left'

/** 寄せる向きが既定でなければURLに書き足す。既定と同じ値は書かず、URLを短く保つ */
const 寄せる向きを足す = (base: string, position: SideSuperPosition): string =>
  position === DEFAULT_SIDE_SUPER_POSITION ? base : `${base}&position=${position}`

/**
 * OBSのブラウザソースに貼るURLを組み立てる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param overlayKey オーバーレイ用キー
 * @param position 画面のどちら側に出すか。既定（左上）ならURLに書き足さない
 */
export const sideSuperUrl = (origin: string, overlayKey: string, position: SideSuperPosition): string =>
  寄せる向きを足す(`${origin}${OVERLAY_PATH}?key=${encodeURIComponent(overlayKey)}`, position)

/**
 * サンプルの文言を流すデモのURLを組み立てる。
 *
 * デモは Worker に接続しないので、オーバーレイ用キーを付けない（src/side-super/stage.ts）。
 * 文言が作られるのを待たずに見栄えと配置を確かめるためのもので、OBSのブラウザソースにも
 * ブラウザのタブにも貼れる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param position 画面のどちら側に出すか。既定（左上）ならURLに書き足さない
 */
export const sideSuperDemoUrl = (origin: string, position: SideSuperPosition): string =>
  寄せる向きを足す(`${origin}${OVERLAY_PATH}?demo=true`, position)
