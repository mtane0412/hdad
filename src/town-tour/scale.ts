/**
 * 市町村の大きさを、身近なものに置き換えた文にする（issue #250）
 *
 * ズームが市町村に着地したとき、名前の下に添える文を組み立てる。数字は LLM に作らせず、同梱した公的な統計
 * （stats.json の人口と面積）と、Worker が押し出したいま見ている人数だけから決める（docs/principles.md の方針11）。
 * - 人口はそのまま出し、面積は山手線の内側の何個分かで出す
 * - 人口は、いま見ている人数で挑むとひとり何人倒せば制圧できるか、に置き換える。レイドの人数が少なくても割合のように
 *   「小ささ」が目立たず、遊びとして読める言い方にしてある
 *
 * 注意: 見ている人数が分からない（配信中でない）とき・人口の記録が無い村（北方領土）では、挑む文を出さない。
 */

/** 山手線の内側の面積（km²）。一般に言われる概算で、一次資料の値ではない（docs/decisions/town-tour.md） */
const YAMANOTE_INNER_AREA = 63

/** これ未満の個数は小数2桁で出す（いちばん小さい舟橋村でも0にならないように） */
const TWO_DECIMALS_BELOW = 0.1
/** これ以上の個数は整数で出す */
const INTEGER_FROM = 10

/**
 * いま見ている人数。レイドでは最後に記録した同接にレイドの人数を足した数、キーワードと試し再生では最後に記録した同接
 * （worker/town-tour-call.ts の TownTourAudience と同じ形）
 */
export interface TownTourAudience {
  readonly kind: 'raid' | 'live'
  readonly count: number
}

/** 大きさの文の材料 */
export interface TownScale {
  /** 市町村の名前（最後の字（市・町・村・区）を「この村」のように使う） */
  readonly name: string
  /** 住民基本台帳の人口。記録が無い村（北方領土の6村）は null */
  readonly population: number | null
  /** 面積（km²） */
  readonly area: number
  /** いま見ている人数。分からない（配信中でない）ときは null */
  readonly audience: TownTourAudience | null
}

/** 数を桁区切りで書く（1954588 → 1,954,588） */
const formatCount = (count: number): string => count.toLocaleString('ja-JP')

/** 面積を山手線の内側の個数で書く。個数の大きさに応じて小数の桁を変える */
const yardstickOf = (area: number): string => {
  const ratio = area / YAMANOTE_INNER_AREA
  const digits = ratio < TWO_DECIMALS_BELOW ? 2 : ratio < INTEGER_FROM ? 1 : 0
  return `面積は山手線の内側の約${ratio.toFixed(digits)}個分`
}

/** 挑む人数の言い方（レイドなら「レイドを合わせた50人」） */
const audienceLabelOf = (audience: TownTourAudience): string =>
  audience.kind === 'raid' ? `レイドを合わせた${formatCount(audience.count)}人` : `いまの${formatCount(audience.count)}人`

/**
 * 着地で名前の下に添える文を、上から順に返す（1行目は人口と面積、2行目は挑む文で、出せないときは1行だけ）
 */
export const scaleLinesOf = ({ name, population, area, audience }: TownScale): string[] => {
  if (population === null) return [`人口の記録なし（北方領土） ・ ${yardstickOf(area)}`]
  const summary = `人口 ${formatCount(population)}人 ・ ${yardstickOf(area)}`
  if (audience === null || audience.count < 1) return [summary]
  // 端数が出たら切り上げる（ひとりでも倒し損ねると制圧できないため）
  const perPerson = Math.ceil(population / audience.count)
  return [summary, `${audienceLabelOf(audience)}で挑むと、ひとり${formatCount(perPerson)}人倒せばこの${name.slice(-1)}を制圧`]
}
