/**
 * 市町村紹介のカメラ（地図のどこを中心に、どれだけ拡大して映すか）
 *
 * ズームの進み具合（0 で日本全体、1 で市町村）から決める。座標は topo.ts が投影した平面の座標で、
 * 拡大率は「投影した座標の1あたりの画面の画素数」である。
 *
 * 拡大率は始まりと終わりの間を掛け算でならし（等比でならすと、ズームの速さが見た目で一定になる）、
 * 中心は「映している広さの変わり方」に合わせて動かす（拡大の初めに中心だけが先に飛んでいかないようにする）。
 */
import { LON_SCALE, type Bounds } from './topo'

/** 最初に映す日本全体の範囲（経緯度）。与那国島から根室まで、沖縄と小笠原も入る */
const JAPAN_WEST = 122.9
const JAPAN_EAST = 148.9
const JAPAN_SOUTH = 24
const JAPAN_NORTH = 45.6

/** 日本全体の範囲を投影した座標で表したもの */
export const JAPAN_BOUNDS: Bounds = {
  minX: JAPAN_WEST * LON_SCALE,
  minY: -JAPAN_NORTH,
  maxX: JAPAN_EAST * LON_SCALE,
  maxY: -JAPAN_SOUTH,
}

/** ズームしきったときに、市町村が箱の幅・高さに占める割合（上下の文字の帯に重ならない程度） */
export const TOWN_FRACTION = 0.45

/**
 * ズームしきったときに映す広さの下限（投影した座標。緯度にしておよそ0.15度）。
 * 東京の区のような小さな市町村を目いっぱい拡大すると、簡略化した形が角ばって見えるため
 */
export const MIN_TOWN_SPAN = 0.15

/** 映し方。投影した座標の (centerX, centerY) を箱の中心に置き、scale 倍して映す */
export interface Camera {
  readonly centerX: number
  readonly centerY: number
  readonly scale: number
}

/** a から b へ t（0〜1）だけ進めた値。t が 0 なら a、1 なら b そのものを返す */
const lerp = (a: number, b: number, t: number): number => a * (1 - t) + b * t

/**
 * ズームの進み具合から映し方を決める。
 *
 * @param zoom ズームの進み具合（0 で日本全体、1 で市町村。緩急は呼び出し側が付けたもの）
 * @param town 市町村の形の範囲（topo.ts の boundsOf）
 * @param width 箱の幅（CSS上の画素）
 * @param height 箱の高さ（CSS上の画素）
 */
export const cameraAt = (zoom: number, town: Bounds, width: number, height: number): Camera => {
  const startScale = Math.min(width / (JAPAN_BOUNDS.maxX - JAPAN_BOUNDS.minX), height / (JAPAN_BOUNDS.maxY - JAPAN_BOUNDS.minY))
  const townWidth = Math.max(town.maxX - town.minX, MIN_TOWN_SPAN)
  const townHeight = Math.max(town.maxY - town.minY, MIN_TOWN_SPAN)
  const endScale = Math.min((width * TOWN_FRACTION) / townWidth, (height * TOWN_FRACTION) / townHeight)

  const scale = startScale ** (1 - zoom) * endScale ** zoom
  // 映している広さ（拡大率の逆数）がどれだけ終わりに近づいたかで中心を動かす。広さが変わらないなら進み具合そのものを使う
  const progress = startScale === endScale ? zoom : (1 / startScale - 1 / scale) / (1 / startScale - 1 / endScale)
  return {
    centerX: lerp((JAPAN_BOUNDS.minX + JAPAN_BOUNDS.maxX) / 2, (town.minX + town.maxX) / 2, progress),
    centerY: lerp((JAPAN_BOUNDS.minY + JAPAN_BOUNDS.maxY) / 2, (town.minY + town.maxY) / 2, progress),
    scale,
  }
}
