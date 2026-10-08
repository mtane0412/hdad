/**
 * 合成オーバーレイの構成（オーバーレイと素材）の読み取り
 *
 * OBSに載せるページを素材ごとに分けるとブラウザソースの数だけ Chromium のレンダラが立ち上がるため、
 * 素材を1枚のページ（overlay/stage/index.html）に重ね、ブラウザソースは「オーバーレイ」ごとに1つだけ置く
 * （issue #101・#103）。**ここで言うオーバーレイは、OBSのブラウザソース1つ＝重なりの1枚**であり、
 * その中に壁紙・時計・チャットといった素材（items）を積む。構成を持つのは Worker（KVの overlay-layout）で、
 * このファイルは受け取った構成から「自分のオーバーレイの素材」と「箱に当てる位置」を決める部分だけを持つ。
 *
 * 通信もDOMも持ち込まないので、ここだけを取り出してテストできる（stage.ts がDOMを受け持つ）。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、形はここで定義する
 * （応答の形の確かめは api.ts が行う）。種類の一覧は worker/overlay-layout.ts の ITEM_KINDS と合わせる。
 * 注意: 位置と大きさはオーバーレイの幅・高さに対する割合（％）で持つ。配信解像度が変わっても崩れないように
 * するためで、CSSにもそのまま％で渡す。
 */

/** オーバーレイに置ける素材の種類。worker/overlay-layout.ts の ITEM_KINDS と合わせる */
export const ITEM_KINDS = ['wallpaper', 'clock', 'chat', 'alerts', 'sideSuper', 'focus', 'draw', 'bgm', 'tab', 'caption', 'workLog', 'taskDesk', 'pomodoro', 'townTour', 'twister', 'wipe', 'text'] as const

/** オーバーレイに置ける素材の種類 */
export type ItemKind = (typeof ITEM_KINDS)[number]

/**
 * 既定で用意するオーバーレイの名前。worker/overlay-layout.ts の DEFAULT_OVERLAY_NAMES と合わせる。
 *
 * 背面（ゲーム画面・アバターより後ろ）と前面（アバターより前）の2つで、配信者が増やせる。
 * 管理画面（src/overlay/form.ts の overlayNameChoices）が名前の選択肢の出発点に使う。
 */
export const DEFAULT_OVERLAY_NAMES = ['back', 'front'] as const

/**
 * オーバーレイ（＝OBSのブラウザソース1つ）に設定する推奨の大きさ（px）。
 *
 * 配信画面と同じ大きさにして、中の素材は割合（％）で置く。素材の推奨の大きさを割合へ直すときの
 * 基準にもなる（src/overlay/form.ts の defaultRectFor）。
 */
export const STAGE_SIZE = { width: 1920, height: 1080 } as const

/**
 * 素材の種類ごとの推奨の大きさ（配信画面に置くときのpx）。
 *
 * 管理画面が素材を追加するときの既定の大きさ（defaultRectFor）と、ギャラリーのプレビューの実寸
 * （src/app/pages.tsx の previewSize）の両方がここを見る。2か所に数を書くと、片方を直したときに
 * 「ギャラリーで確かめた大きさ」と「オーバーレイに置いたときの大きさ」が食い違う。
 *
 * 配信画面の隅に文言を出す素材（サイドスーパー・注目コメント・再生中の曲）とアラートは、素材のCSSが箱の中で
 * 寄せる場所を決めるので、余白ごと配信画面と同じ大きさにする。壁紙と手書きも画面いっぱいに描く
 * （手書きは描く画面と同じ縦横比でないと図が歪むので、配信画面と同じ大きさで使う）。タブの映像も、取り込むタブが
 * 1920×1080 までの横長なので配信画面と同じ大きさを推奨にする（縦横比が違えば箱の中で余白を空けて収める）。
 * 字幕も、下端に寄せる場所を素材のCSS（src/caption/caption.css）が決めるので配信画面と同じ大きさにする。
 * 時計とチャットボックスだけは画面の一部に置くものなので、ギャラリーが案内している大きさに合わせる。
 * 作業ログも画面の一部（横の余白）に縦に積むものなので、行が十行ほど収まる縦長の大きさにする。
 * 作業机も同じく横の余白に1人1行で積むので、作業ログと同じ大きさにする。
 * ポモドーロは残り時間と区間の名前を出す小さな札なので、時計と同じく画面の隅に置ける大きさにする。
 * 市町村紹介は日本地図を画面いっぱいに映してからズームするので、配信画面と同じ大きさにする。
 * ツイスターもマットを画面の真ん中に、スピナーと文言を画面の隅と上に出すので、配信画面と同じ大きさにする。
 * ワイプは右上に寄せた小さなアイコンの枠と、その下に出す吹き出しが収まる大きさにする（画面の右上に置く前提）。
 * テキストは画面の隅に置く札なので、本文の上限（4行）が収まる高さと、1行が折り返しすぎない幅にする。
 */
export const RECOMMENDED_ITEM_SIZES: Readonly<Record<ItemKind, { readonly width: number; readonly height: number }>> = {
  wallpaper: STAGE_SIZE,
  clock: { width: 600, height: 240 },
  chat: { width: 480, height: 800 },
  alerts: STAGE_SIZE,
  sideSuper: STAGE_SIZE,
  focus: STAGE_SIZE,
  draw: STAGE_SIZE,
  bgm: STAGE_SIZE,
  tab: STAGE_SIZE,
  caption: STAGE_SIZE,
  workLog: { width: 560, height: 640 },
  taskDesk: { width: 560, height: 640 },
  pomodoro: { width: 420, height: 200 },
  townTour: STAGE_SIZE,
  twister: STAGE_SIZE,
  wipe: { width: 480, height: 460 },
  text: { width: 720, height: 220 },
}

/** オーバーレイの中での位置と大きさ（オーバーレイの幅・高さに対する割合。％） */
export interface ItemRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** オーバーレイに積む素材1つ。worker/overlay-layout.ts の OverlayItem と合わせる */
export interface OverlayItem {
  readonly kind: ItemKind
  /** デザインID（壁紙・時計・チャットのみ。それ以外は空文字） */
  readonly id: string
  /** その素材のパラメータ（クエリ文字列のまま。解析は素材のスキーマで行う） */
  readonly params: string
  readonly rect: ItemRect
}

/** オーバーレイ1つ（＝OBSのブラウザソース1つ）。worker/overlay-layout.ts の Overlay と合わせる */
export interface Overlay {
  readonly name: string
  /** 積む素材（並びがそのまま重ねる順。あとのものが前） */
  readonly items: readonly OverlayItem[]
}

/** 素材の箱に当てるCSSの値 */
export interface RectStyle {
  readonly left: string
  readonly top: string
  readonly width: string
  readonly height: string
}

/**
 * そのオーバーレイに積む素材だけを取り出す。
 *
 * 並びは構成に保存された順のままにする。あとのものが前に重なるので、並びがそのまま重ねる順になる。
 * その名前のオーバーレイが無ければ空を返す（呼び出し側が、構成にある名前を並べて知らせる）。
 */
export const itemsInOverlay = (overlays: readonly Overlay[], name: string): readonly OverlayItem[] =>
  overlays.find((overlay) => overlay.name === name)?.items ?? []

/** 位置と大きさを、箱に当てるCSSの値（％）にする */
export const rectStyle = ({ x, y, width, height }: ItemRect): RectStyle => ({
  left: `${x}%`,
  top: `${y}%`,
  width: `${width}%`,
  height: `${height}%`,
})

/**
 * 構成にあるオーバーレイの名前を、並んでいる順で返す。
 *
 * 名前を間違えて開いたときに「この構成にあるオーバーレイ」を並べて知らせるために使う。
 */
export const overlayNamesOf = (overlays: readonly Overlay[]): string[] => overlays.map((overlay) => overlay.name)
