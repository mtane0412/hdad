/**
 * 合成オーバーレイの構成（段とレイヤー）の読み取り
 *
 * OBSに載せるページを素材ごとに分けるとブラウザソースの数だけ Chromium のレンダラが立ち上がるため、
 * 素材を「レイヤー」として1枚のページ（overlay/index.html）に重ね、ブラウザソースは「段」（group）ごとに
 * 1つだけ置く（issue #101）。構成を持つのは Worker（KVの overlay-layout）で、このファイルは
 * 受け取った構成から「自分の段のレイヤー」と「箱に当てる位置」を決める部分だけを持つ。
 *
 * 通信もDOMも持ち込まないので、ここだけを取り出してテストできる（stage.ts がDOMを受け持つ）。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、レイヤーの形はここで定義する
 * （応答の形の確かめは api.ts が行う）。種類の一覧は worker/overlay-layout.ts の LAYER_KINDS と合わせる。
 * 注意: 位置と大きさは段の幅・高さに対する割合（％）で持つ。配信解像度が変わっても崩れないようにするためで、
 * CSSにもそのまま％で渡す。
 */

/** レイヤーに置ける素材の種類。worker/overlay-layout.ts の LAYER_KINDS と合わせる */
export const LAYER_KINDS = ['wallpaper', 'clock', 'chat', 'alerts', 'sideSuper', 'focus'] as const

/** レイヤーに置ける素材の種類 */
export type LayerKind = (typeof LAYER_KINDS)[number]

/** 段の中での位置と大きさ（段の幅・高さに対する割合。％） */
export interface LayerRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 重ねる素材1つ。worker/overlay-layout.ts の OverlayLayer と合わせる */
export interface OverlayLayer {
  readonly kind: LayerKind
  /** デザインID（壁紙・時計・チャットのみ。それ以外は空文字） */
  readonly id: string
  /** その素材のパラメータ（クエリ文字列のまま。解析は素材のスキーマで行う） */
  readonly params: string
  /** 置く段の名前 */
  readonly group: string
  readonly rect: LayerRect
}

/** レイヤーの箱に当てるCSSの値 */
export interface RectStyle {
  readonly left: string
  readonly top: string
  readonly width: string
  readonly height: string
}

/**
 * その段に置くレイヤーだけを取り出す。
 *
 * 並びは構成に保存された順のままにする。あとのものが前に重なるので、並びがそのまま重ねる順になる。
 */
export const layersInGroup = (layers: readonly OverlayLayer[], group: string): OverlayLayer[] =>
  layers.filter((layer) => layer.group === group)

/** 位置と大きさを、箱に当てるCSSの値（％）にする */
export const rectStyle = ({ x, y, width, height }: LayerRect): RectStyle => ({
  left: `${x}%`,
  top: `${y}%`,
  width: `${width}%`,
  height: `${height}%`,
})

/**
 * 構成にある段の名前を、重複なく現れた順で返す。
 *
 * 段の名前を間違えて開いたときに「この構成にある段」を並べて知らせるために使う。
 */
export const groupsOf = (layers: readonly OverlayLayer[]): string[] => [...new Set(layers.map((layer) => layer.group))]
