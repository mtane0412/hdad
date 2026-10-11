/**
 * 手足を運ぶ経路の形と、経路の良し悪しの測り方
 *
 * 手足は、もとの円から指された円へ弧を描いて運ぶ。弧の形は次の2つで決まる。
 * - height: 運ぶ途中で持ち上げる高さ（m）。半分運んだところでいちばん高い
 * - swing: 運ぶ途中で横へ回る幅（m）。上から見て、運ぶ向きの右（運ぶ向きと上向きの外積の側）が正
 *
 * いまの弧（指示ごとに決まった高さ）だけでは、運ぶ手足が相手の体を突き抜けて押し返され、関節が速く動く（issue #325）。
 * そこで、いまの弧に「少し高く・低く運ぶ」「左右へ少し回る」形を加えた候補（PATH_SHAPES）を用意し、対戦を作るときに
 * 候補ごとに運ぶあいだの姿勢を実際に押し出して記録し（game.ts の bakeStanding）、悪さ（windowScore）がいちばん小さい経路を選ぶ。
 *
 * 悪さは、速さ（1コマ FAST_FRAME_STEP を超えて動いた関節の数）・届くか（運び終えた時刻に手足の先が円からどれだけ離れているか）・
 * 相手の体を突き抜けるか（2人の骨どうしの突き抜けの深さ）の重みつきの和で、小さいほど良い。
 * 突き抜けは、骨（関節のあいだのカプセル）どうしのいちばん近い距離（vec.ts の segmentDistance）から測る。
 * 物理（physics.ts）は関節の粒と相手の骨の重なりだけを押し出すので、骨の途中どうしが交差していても気づかない。
 * 経路を選ぶときは骨どうしで測り、そうした交差も避ける。
 *
 * 候補の順は固定で、同点なら先の候補を選ぶ。乱数を使わないので、同じ種からは必ず同じ経路になる。
 */
import { BONES, JOINTS, type Pose } from './body'
import type { PosePair } from './physics'
import { PLAYER_INDEXES } from './players'
import { UP, add, cross, distance, flat, lerp, normalize, scale, segmentDistance, sub, vec, type Vec3 } from './vec'

/** 手足を運ぶ経路 */
export interface LimbPath {
  /** もとの円の上の位置 */
  readonly from: Vec3
  /** 指された円の上の位置 */
  readonly to: Vec3
  /** 半分運んだところで持ち上げる高さ（m） */
  readonly height: number
  /** 半分運んだところで横へ回る幅（m）。運ぶ向きの右が正 */
  readonly swing: number
}

/** 経路の形の候補（いまの弧からの差） */
export interface PathShape {
  /** いまの弧の高さに足す高さ（m）。負なら低く運ぶ */
  readonly height: number
  /** 横へ回る幅（m） */
  readonly swing: number
}

/** 高く・低く運ぶときに足し引きする高さ（m） */
const RAISE = 0.15
/** 横へ回るときの幅（m）。円の列の間隔（mat.ts の COLUMN_SPACING）の半分ほどにして、となりの円の上を通るくらいに留める */
const SWING = 0.18

/**
 * 経路の形の候補。先頭がいまの弧で、同点のときは先の候補を選ぶ。
 * 上から見て同じ道筋を通る形（高さだけを変える）を、横へ回る形より先に並べる。低く運ぶ形は、下に伏せた人が相手の体の下で
 * 手足を運ぶときに、持ち上げた腕が相手の脚に引っかからないようにするためのもの
 */
export const PATH_SHAPES: readonly PathShape[] = [
  { height: 0, swing: 0 },
  { height: RAISE, swing: 0 },
  { height: -RAISE, swing: 0 },
  { height: 0, swing: SWING },
  { height: 0, swing: -SWING },
  { height: RAISE, swing: SWING },
  { height: RAISE, swing: -SWING },
  { height: -RAISE, swing: SWING },
  { height: -RAISE, swing: -SWING },
]

/** 1コマ（60fps）で関節が速く動いたとみなす距離（m。秒速 3m） */
export const FAST_FRAME_STEP = 0.05
/** 運び終えた時刻に、手足が円に乗っているとみなすずれ（m） */
export const LANDED_TOLERANCE = 0.02
/** 運び終えるのが遅れたときに足す悪さ。速く動いた関節この数ぶんと同じに数える */
const LATE_PENALTY = 5
/** 運び終えるのが遅れたときに、ずれ1mあたりに足す悪さ */
const LATE_PER_METER = 100
/** 骨どうしの突き抜けの深さ1mあたりの悪さ（コマごとの深さの和に掛ける） */
const PENETRATION_PER_METER = 1

/** ゆっくり動きだし、ゆっくり止まる（0〜1 → 0〜1） */
export const easeInOut = (progress: number): number => (progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2)

/**
 * 経路の上で、運ぶ進み具合 progress（0〜1）の位置。進み具合はゆっくり動きだしゆっくり止まるように緩め、
 * 持ち上げる高さと横へ回る幅は、緩めた進み具合の正弦（半分でいちばん大きい）に合わせる
 */
export const pointOnPath = (path: LimbPath, progress: number): Vec3 => {
  const eased = easeInOut(progress)
  const bulge = Math.sin(Math.PI * eased)
  // 上から見て運ぶ向きの右。もとの円と指された円が重なって向きが決まらないときは、横へ回らない
  const side = normalize(cross(flat(sub(path.to, path.from)), UP), vec(0, 0, 0))
  return add(lerp(path.from, path.to, eased), add(scale(UP, path.height * bulge), scale(side, path.swing * bulge)))
}

/** いまの弧に、候補の形を当てた経路 */
export const shapedPath = (base: LimbPath, shape: PathShape): LimbPath => ({ ...base, height: base.height + shape.height, swing: base.swing + shape.swing })

/**
 * 2人の骨どうしの突き抜けの深さの和（m）。骨はカプセルとみなし、中心の線分どうしの距離が太さの和より近い分を数える。
 * 関節が相手の骨から離れていても、骨の途中どうしが交差していれば数える
 */
export const bonePenetration = (a: Pose, b: Pose): number => {
  let total = 0
  for (const bone of BONES) {
    for (const other of BONES) {
      const depth = bone.radius + other.radius - segmentDistance(a[bone.from], a[bone.to], b[other.from], b[other.to])
      if (depth > 0) total += depth
    }
  }
  return total
}

/** 1コマ前の姿勢から FAST_FRAME_STEP を超えて動いた関節の数（2人ぶん） */
export const fastStepsBetween = (before: PosePair, after: PosePair): number =>
  PLAYER_INDEXES.reduce<number>((count, player) => count + JOINTS.filter((joint) => distance(after[player][joint], before[player][joint]) > FAST_FRAME_STEP).length, 0)

/** 運び終えた時刻のコマと、そのコマで手足の先が指された円からどれだけ離れているかの測り方 */
export interface Landing {
  /** 運び終えた時刻のコマの、渡す記録の中での番号（0から） */
  readonly frame: number
  /** 手足の先と、指された円の上の位置とのずれ（m） */
  readonly gapOf: (poses: PosePair) => number
}

/** 経路で運んだときの記録の良し悪し */
export interface WindowScore {
  /** 悪さ（小さいほど良い） */
  readonly cost: number
  /** 関節が速く動かず、運び終えるのも遅れなかったか。そうなら、ほかの候補を試さずにこの経路を選ぶ */
  readonly clean: boolean
}

/**
 * 経路で運んだあいだの記録の良し悪し。
 *
 * @param start 運びはじめる直前のコマの姿勢
 * @param frames 運びはじめてからのコマの姿勢（運び終えて手足を円に着けるまで）
 * @param landing 運び終えた時刻（運び終えを調べない最後の指示では null）
 * @param withPenetration 骨どうしの突き抜けも数えるか（ほかの候補と比べるときだけ数える。比べないときは重いので省く）
 */
export const windowScore = (start: PosePair, frames: readonly PosePair[], landing: Landing | null, withPenetration: boolean): WindowScore => {
  let fast = 0
  let penetration = 0
  let before = start
  for (const frame of frames) {
    fast += fastStepsBetween(before, frame)
    if (withPenetration) penetration += bonePenetration(frame[0], frame[1])
    before = frame
  }
  const landed = landing === null ? undefined : frames[landing.frame]
  const gap = landing === null || landed === undefined ? 0 : landing.gapOf(landed)
  const late = gap > LANDED_TOLERANCE
  return {
    cost: fast + (late ? LATE_PENALTY + gap * LATE_PER_METER : 0) + penetration * PENETRATION_PER_METER,
    clean: fast === 0 && !late,
  }
}
