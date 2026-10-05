/**
 * 全国制覇マップの数と節目の一文（issue #252）
 *
 * 紹介の締めで日本全体へ引き、これまでに紹介した市町村を塗った地図と「制覇 35 / 1,747（2.0%）」を出す。
 * ここは、呼び出しが持つこれまでの記録（visited）と今回の市町村から、制覇数（今回を数える前と後）と節目の一文を決める。
 *
 * - 今回の市町村を数えるのは、流しきったら記録する紹介（レイドとキーワード）で、まだ紹介していない市町村のときだけ。
 *   試し再生（記録しない）と、紹介済みの市町村（全国制覇の後の2周目）では数えず、節目の一文も出さない
 * - 節目は、初めての都道府県・離島（地図の上で隣り合う市町村が無い市町村）・都道府県の全制覇・10件ごとの4つで、重なればすべて出す
 *
 * 全体の数と都道府県ごとの市町村は、地図の形から求めた境界（topo.ts の decodeTownBorders）の市町村を数える
 * （一覧と地図の1対1は towns.test.ts が検証している）。都道府県は、全国地方公共団体コードの上2桁で見分ける。
 *
 * 注意: 通信も DOM も持ち込まない。
 */
import type { TownBorders } from './topo'
import type { TownTourCall } from './tour'

/** 制覇数の節目にする件数の刻み */
const MILESTONE_STEP = 10

/** 都道府県を見分ける、全国地方公共団体コードの上の桁数 */
const PREFECTURE_CODE_LENGTH = 2

/** 制覇数と節目を決めるのに使う、呼び出しの項目 */
export type ConquestTown = Pick<TownTourCall, 'code' | 'prefecture' | 'name' | 'visited' | 'visit'>

/** 1件の再生の制覇マップ */
export interface Conquest {
  /** 今回を数える前の制覇数（これまでに紹介した市町村の数） */
  readonly before: number
  /** 今回を数えた制覇数。数えない再生（試し再生・紹介済み）では before と同じ */
  readonly after: number
  /** 全国の市町村の数 */
  readonly total: number
  /** これまでに紹介した市町村のコード（今回を含まない）。地図に塗る */
  readonly visited: ReadonlySet<string>
  /** 節目の一文（出す順）。数えない再生では空 */
  readonly milestones: readonly string[]
}

const prefectureCodeOf = (code: string): string => code.slice(0, PREFECTURE_CODE_LENGTH)

/**
 * 今回の市町村と、これまでの記録から制覇マップを決める。
 *
 * @param borders 地図の形から求めた境界。全体の数・都道府県ごとの市町村・離島の判定に使う
 * @throws 今回の市町村が地図に無いとき（地図の読み込みが壊れたとき。黙って数えない）
 */
export const conquestOf = (town: ConquestTown, borders: TownBorders): Conquest => {
  const neighbors = borders.adjacent.get(town.code)
  if (neighbors === undefined) throw new Error(`日本地図に、コード ${town.code} の市町村がありません`)
  const visited = new Set(town.visited)
  const before = visited.size
  const total = borders.adjacent.size
  if (town.visit === null || visited.has(town.code)) return { before, after: before, total, visited, milestones: [] }

  const after = before + 1
  const prefecture = prefectureCodeOf(town.code)
  const prefectureTowns = [...borders.adjacent.keys()].filter((code) => prefectureCodeOf(code) === prefecture)
  const isFirstInPrefecture = ![...visited].some((code) => prefectureCodeOf(code) === prefecture)
  const completesPrefecture = prefectureTowns.every((code) => code === town.code || visited.has(code))
  const milestones = [
    ...(isFirstInPrefecture ? [`${town.prefecture}に初上陸！`] : []),
    ...(neighbors.size === 0 ? [`離島の${town.name}に上陸！`] : []),
    ...(completesPrefecture ? [`${town.prefecture}を完全制覇！`] : []),
    ...(after % MILESTONE_STEP === 0 ? [`祝・${after}市町村制覇！`] : []),
  ]
  return { before, after, total, visited, milestones }
}

/** 制覇数の表記（「制覇 35 / 1,747（2.0%）」）。割合は小数第1位まで */
export const conquestLabelOf = (count: number, total: number): string =>
  `制覇 ${count.toLocaleString('ja-JP')} / ${total.toLocaleString('ja-JP')}（${((count / total) * 100).toFixed(1)}%）`
