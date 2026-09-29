/**
 * 手書きの道具（選べる色と太さ）
 *
 * 描く画面（/draw/）と合成ページ（overlay/stage/index.html）の両方がここを読む。2か所に持つと、
 * 片方だけ色を増やしたときに「送れるのに受け取り側が弾く」食い違いが起きる。
 *
 * 色は配信画面の上に載るので、あらかじめ選んだ数色から選ぶ形にする（配信中に色を作り込む場面がないため、
 * 任意の色を選べる入力は持たない）。線には縁取りを付けるので、明るい画面でも暗い画面でも沈まない
 * （縁取りの描き方は src/draw/view.ts）。
 *
 * やりとりに載せるのは色と太さの名前（id）だけで、実際の色の値と太さの比はここで引く。
 */

/** 選べる色1つ */
export interface DrawColor {
  readonly id: string
  /** 画面の道具箱に出す名前 */
  readonly label: string
  /** 描くのに使う色 */
  readonly value: string
}

/** 選べる太さ1つ */
export interface DrawWidth {
  readonly id: string
  /** 画面の道具箱に出す名前 */
  readonly label: string
  /** 箱の幅に対する比。800画素の箱での見え方を目安にしている */
  readonly ratio: number
}

/**
 * 選べる色。配信画面のどこに載せても見えるものを選んである。
 *
 * 黒を置いていないのは、縁取りが黒なので暗い線は縁取りと溶け合って形が分からなくなるためである。
 */
export const DRAW_COLORS: readonly DrawColor[] = [
  { id: 'white', label: '白', value: '#ffffff' },
  { id: 'yellow', label: '黄', value: '#ffd400' },
  { id: 'red', label: '赤', value: '#ff4d4d' },
  { id: 'blue', label: '青', value: '#4db8ff' },
  { id: 'green', label: '緑', value: '#4dff88' },
]

/** 選べる太さ。細い順に並べる（画面の並びがそのまま太さの順になる） */
export const DRAW_WIDTHS: readonly DrawWidth[] = [
  { id: 'thin', label: '細い', ratio: 0.005 },
  { id: 'medium', label: 'ふつう', ratio: 0.01 },
  { id: 'bold', label: '太い', ratio: 0.02 },
]

/** 何も選ばずに描き始めたときの色 */
export const DEFAULT_COLOR_ID = 'white'
/** 何も選ばずに描き始めたときの太さ */
export const DEFAULT_WIDTH_ID = 'medium'

/** 選べる色の名前か */
export const isColorId = (value: unknown): value is string => DRAW_COLORS.some(({ id }) => id === value)

/** 選べる太さの名前か */
export const isWidthId = (value: unknown): value is string => DRAW_WIDTHS.some(({ id }) => id === value)

/**
 * 名前から色を引く。
 *
 * @throws 一覧にない名前の場合（黙って既定に戻さない。検証を通っていない値が届いた印なので、
 *   原因に気付けるようにする）
 */
export const colorOf = (id: string): DrawColor => {
  const 色 = DRAW_COLORS.find((候補) => 候補.id === id)
  if (色 === undefined) throw new Error(`手書きの色「${id}」は選べません`)
  return 色
}

/**
 * 名前から太さを引く。
 *
 * @throws 一覧にない名前の場合
 */
export const widthOf = (id: string): DrawWidth => {
  const 太さ = DRAW_WIDTHS.find((候補) => 候補.id === id)
  if (太さ === undefined) throw new Error(`手書きの太さ「${id}」は選べません`)
  return 太さ
}
