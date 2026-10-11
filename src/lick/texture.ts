/**
 * 舌の模様（画素の並びをコードで作る）
 *
 * 舌の表と裏に貼る絵を、画像の素材を使わずに RGBA の画素の並びとして作る（描画の view.ts が three.js の DataTexture にする）。
 * - 表: 赤みの地に、細かく白っぽい糸状の乳頭と、ところどころ赤く大きい茸状の乳頭のブツブツ。真ん中に暗い溝、奥（根元）に白っぽい苔。
 *   凹凸（bump）も同じ並びで作り、乳頭は高く、溝は低くする
 * - 裏: 薄く紫がかった地に、真ん中の左右を青い血管がうねって通る
 *
 * 行の並びは根元（0行目）から舌先（最後の行）、列の並びは左端から右端（真ん中が溝）。
 * 同じ種からは同じ模様を作る（乱数は src/core/background.ts の createRandom だけを使う）。
 *
 * 注意: DOM も three.js も読み込まない（画素を計算するだけ）。
 */
import { createRandom } from '../core/background'

/** 舌の表の模様 */
export interface TongueTopTexture {
  /** 色（RGBA） */
  readonly color: Uint8ClampedArray
  /** 凹凸（RGBA。灰色で、明るいほど高い） */
  readonly bump: Uint8ClampedArray
}

/** 舌の裏の模様 */
export interface TongueBottomTexture {
  /** 色（RGBA） */
  readonly color: Uint8ClampedArray
}

type Rgb = readonly [number, number, number]

/** 表の地の色（濡れた赤み） */
const TOP_BASE: Rgb = [178, 44, 62]
/** 糸状の乳頭の色（白っぽい） */
const FILIFORM_COLOR: Rgb = [226, 150, 156]
/** 茸状の乳頭の色（赤い） */
const FUNGIFORM_COLOR: Rgb = [205, 28, 54]
/** 奥の苔の色（黄ばんだ白） */
const COATING_COLOR: Rgb = [236, 224, 200]
/** 裏の地の色（薄く紫がかった赤み） */
const BOTTOM_BASE: Rgb = [206, 118, 142]
/** 血管の色（青紫） */
const VEIN_COLOR: Rgb = [72, 78, 176]
/** 凹凸の地の高さ（0〜255） */
const BUMP_BASE = 128
/** 糸状・茸状の乳頭の数（1画素あたり）と半径（画素）と高さ */
const FILIFORM_DENSITY = 1 / 4
const FILIFORM_RADIUS = 1.1
const FILIFORM_HEIGHT = 30
const FUNGIFORM_DENSITY = 1 / 60
const FUNGIFORM_RADIUS = 2.6
const FUNGIFORM_HEIGHT = 55
/**
 * 乳頭を行の向きに縮める割合。舌は幅より長さのほうが4.3倍ほど長く、絵は縦にその分引き伸ばされて貼られるので、
 * 絵の上で縦に縮めておくと舌の上では丸く見える
 */
const PAPILLA_ASPECT = 4.3
/** 溝の幅（列の割合）・深さ（凹凸）・暗さ */
const GROOVE_WIDTH = 0.05
const GROOVE_DEPTH = 70
const GROOVE_DARKEN = 0.4
/** 苔の届く範囲（行の割合。根元からここまで）と濃さ */
const COATING_REACH = 0.35
const COATING_STRENGTH = 0.65
/** 苔のむらの粗さ（格子の数） */
const NOISE_GRID = 8
/** 血管の左右のずれ（列の割合）・うねりの幅と細かさ・太さ（列の割合） */
const VEIN_SPREAD = 0.14
const VEIN_WAVE = 0.03
const VEIN_FREQUENCY = 7
const VEIN_WIDTH = 0.018
/** 枝分かれした細い血管の数 */
const BRANCH_COUNT = 6

/** 0〜1 に収める */
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** 始まりと終わりをなめらかにする（0〜1 → 0〜1） */
const smooth = (t: number): number => t * t * (3 - 2 * t)

/** 2色を割合 amount（0〜1）で混ぜる */
const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
  from[0] + (to[0] - from[0]) * amount,
  from[1] + (to[1] - from[1]) * amount,
  from[2] + (to[2] - from[2]) * amount,
]

/** 0〜1 の格子の値をなめらかにつないだむら（値の雑音）を作る */
const createNoise = (random: () => number): ((s: number, t: number) => number) => {
  const grid = Array.from({ length: (NOISE_GRID + 1) ** 2 }, () => random())
  const at = (column: number, row: number): number => grid[row * (NOISE_GRID + 1) + column] ?? 0
  return (s, t) => {
    const x = clamp01(s) * NOISE_GRID
    const y = clamp01(t) * NOISE_GRID
    const column = Math.min(Math.floor(x), NOISE_GRID - 1)
    const row = Math.min(Math.floor(y), NOISE_GRID - 1)
    const fx = smooth(x - column)
    const fy = smooth(y - row)
    const top = at(column, row) + (at(column + 1, row) - at(column, row)) * fx
    const bottom = at(column, row + 1) + (at(column + 1, row + 1) - at(column, row + 1)) * fx
    return top + (bottom - top) * fy
  }
}

/** 画素の並びに色を書く */
const writeRgb = (data: Uint8ClampedArray, index: number, [red, green, blue]: Rgb): void => {
  data[index * 4] = red
  data[index * 4 + 1] = green
  data[index * 4 + 2] = blue
  data[index * 4 + 3] = 255
}

/**
 * 乳頭を1つ押す（中心からの距離でなめらかに弱める）。
 * 凹凸を高くし、色をその乳頭の色へ寄せる。
 */
const stampPapilla = (
  size: number,
  heights: Float32Array,
  tints: Float32Array,
  centerX: number,
  centerY: number,
  radius: number,
  height: number,
  tintChannel: 0 | 1,
): void => {
  const reach = Math.ceil(radius * 2)
  const reachY = Math.ceil((radius * 2) / PAPILLA_ASPECT)
  for (let y = Math.max(0, Math.floor(centerY) - reachY); y <= Math.min(size - 1, Math.ceil(centerY) + reachY); y += 1) {
    for (let x = Math.max(0, Math.floor(centerX) - reach); x <= Math.min(size - 1, Math.ceil(centerX) + reach); x += 1) {
      const falloff = Math.exp(-(((x - centerX) ** 2 + ((y - centerY) * PAPILLA_ASPECT) ** 2) / (radius * radius)))
      const index = y * size + x
      heights[index] = (heights[index] ?? 0) + height * falloff
      // 色の寄せは2つの成分（0: 糸状、1: 茸状）に分けて足し、あとで割合として使う
      tints[index * 2 + tintChannel] = Math.max(tints[index * 2 + tintChannel] ?? 0, falloff)
    }
  }
}

/**
 * 舌の表の模様（色と凹凸）を作る。
 *
 * @param size 縦横の画素数
 * @param seed 乳頭の散らばり方と苔のむらを決める種
 */
export const tongueTopTexture = (size: number, seed: number): TongueTopTexture => {
  const random = createRandom(seed)
  const noise = createNoise(random)
  const heights = new Float32Array(size * size)
  const tints = new Float32Array(size * size * 2)
  for (let count = 0; count < size * size * FILIFORM_DENSITY; count += 1) {
    stampPapilla(size, heights, tints, random() * size, random() * size, FILIFORM_RADIUS, FILIFORM_HEIGHT, 0)
  }
  for (let count = 0; count < size * size * FUNGIFORM_DENSITY; count += 1) {
    stampPapilla(size, heights, tints, random() * size, random() * size, FUNGIFORM_RADIUS * (0.7 + random() * 0.6), FUNGIFORM_HEIGHT, 1)
  }

  const color = new Uint8ClampedArray(size * size * 4)
  const bump = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1)
    for (let x = 0; x < size; x += 1) {
      const s = x / (size - 1)
      const index = y * size + x
      const groove = Math.exp(-(((s - 0.5) / GROOVE_WIDTH) ** 2)) * Math.sin(Math.PI * t)
      const coating = smooth(clamp01((COATING_REACH - t) / COATING_REACH)) * (0.5 + 0.5 * noise(s, t)) * COATING_STRENGTH
      let rgb = mix(TOP_BASE, FILIFORM_COLOR, (tints[index * 2] ?? 0) * 0.6)
      rgb = mix(rgb, FUNGIFORM_COLOR, (tints[index * 2 + 1] ?? 0) * 0.8)
      rgb = mix(rgb, COATING_COLOR, coating)
      rgb = mix(rgb, [0, 0, 0], groove * GROOVE_DARKEN)
      writeRgb(color, index, rgb)
      const height = BUMP_BASE + (heights[index] ?? 0) - GROOVE_DEPTH * groove
      writeRgb(bump, index, [height, height, height])
    }
  }
  return { color, bump }
}

/**
 * 舌の裏の模様（色）を作る。
 *
 * @param size 縦横の画素数
 * @param seed 血管のうねりと枝分かれを決める種
 */
export const tongueBottomTexture = (size: number, seed: number): TongueBottomTexture => {
  const random = createRandom(seed)
  const noise = createNoise(random)
  const phases = [random() * Math.PI * 2, random() * Math.PI * 2]
  // 枝は太い血管の途中から外へ斜めに伸びる短い線（始まりの行・どちらの血管か・向きの傾き・長さ）
  const branches = Array.from({ length: BRANCH_COUNT }, () => ({
    from: 0.15 + random() * 0.6,
    side: random() < 0.5 ? -1 : 1,
    slope: 0.6 + random() * 1.2,
    length: 0.08 + random() * 0.12,
  }))
  const veinCenter = (side: number, t: number): number => 0.5 + side * VEIN_SPREAD + VEIN_WAVE * Math.sin(t * VEIN_FREQUENCY + (phases[side < 0 ? 0 : 1] ?? 0))

  const color = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1)
    // 血管は根元で太く濃く、舌先へ向かって細く薄れる
    const fade = clamp01((0.9 - t) / 0.3) * clamp01(t / 0.05)
    const width = VEIN_WIDTH * (1.3 - 0.6 * t)
    for (let x = 0; x < size; x += 1) {
      const s = x / (size - 1)
      let vein = 0
      for (const side of [-1, 1]) vein = Math.max(vein, Math.exp(-(((s - veinCenter(side, t)) / width) ** 2)) * fade)
      for (const branch of branches) {
        const along = t - branch.from
        if (along < 0 || along > branch.length) continue
        const center = veinCenter(branch.side, branch.from) + branch.side * along * branch.slope
        vein = Math.max(vein, Math.exp(-(((s - center) / (width * 0.45)) ** 2)) * fade * (1 - along / branch.length))
      }
      const base = mix(BOTTOM_BASE, [236, 170, 186], noise(s, t) * 0.25)
      writeRgb(color, y * size + x, mix(base, VEIN_COLOR, vein * 0.85))
    }
  }
  return { color }
}
