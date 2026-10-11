/**
 * ツイスターの指示の選び方
 *
 * 本物のツイスターではスピナーが手足と色を決め、どの円に置くかを人が選ぶ。ここでは「できるだけ絡み合う」ように、
 * 手足・色・円の組み合わせをまとめて選び、スピナーはその手足と色に止まる演出にする（純粋な乱数にはしない）。
 *
 * - 絡ませる指示（5〜7回）: 空いていて届く円のうち、相手の胴に近い円と、手足が上から見て交差する円を優先する。
 *   同じ人が同じ手足を続けて動かすのは避ける。
 *   体の向き（足から手へ）は始めの向きから MAX_HEADING_TURN まで回してよい（横を向く姿勢を許す）。それより回る置き場所は、
 *   体が裏返ってしまうので候補にしない
 * - 最後の指示: 空いているが届かない円を指す。届かなさが小さい（あと少しで届きそうな）円と、相手の胴に近い円を優先する
 *   （手を伸ばして、相手の上へ倒れ込むように）
 *
 * 揺らぎは渡された乱数（種から決まる）だけから作るので、同じ種からは同じ指示の並びになる。
 */
import { LIMB_CHAINS, LIMBS, type Limb, type Pose } from './body'
import { ALL_SPOTS, sameSpot, spotPosition, type Spot } from './mat'
import type { PosePair } from './physics'
import { INITIAL_SPOTS, PLAYER_FACINGS, opponentOf, type Placement, type PlayerIndex } from './players'
import { contactsOf, solvePose } from './pose'
import { cross, distance, distanceToSegment, dot, flat, length, midpoint, segmentsCrossFlat, sub, type Vec3 } from './vec'

/** 1回の指示（だれの・どの手足を・どの円へ） */
export interface Move {
  readonly player: PlayerIndex
  readonly limb: Limb
  readonly spot: Spot
}

/** 1回の対戦の指示の並び */
export interface Plan {
  /** 絡ませる指示（5〜7回） */
  readonly moves: readonly Move[]
  /** 倒れ込ませる最後の指示（届かない円を指す） */
  readonly finalMove: Move
}

/** 届いたとみなす、手足の先と円のずれ（m） */
const REACH_TOLERANCE = 0.01
/** 届かないとみなす、手足の先と円のずれ（m）。少し伸ばせば届きそうな円では倒れ込む理由にならないので、はっきり離れた円にする */
export const UNREACHABLE_MISS = 0.15
/**
 * 体の向き（両足の中点から両手の中点へ）を、始めの向きから回してよい角度の上限（ラジアン）。
 * 横を向く姿勢までは許し、それより回って両手が両足の後ろへ回り込む（体が裏返る）置き場所は候補にしない
 */
export const MAX_HEADING_TURN = (Math.PI * 4) / 9
/** 両手の中点と両足の中点の、水平の距離の下限（m）。これより近いと体の向きが決まらない */
const MIN_BODY_SPAN = 0.3
/** 手足の交差が1つ増える候補への加点（m 相当） */
export const CROSSING_BONUS = 0.3
/** 絡ませる指示の揺らぎの大きさ（m 相当）。相手の胴への近さの差がこれより小さい候補は、乱数で入れ替わる */
const ENTANGLE_JITTER = 0.3
/** 同じ人が同じ手足を続けて動かす候補の減点（m 相当） */
const SAME_LIMB_PENALTY = 0.2
/** 最後の指示で、相手の胴への近さに掛ける重みと揺らぎの大きさ */
const FINAL_OPPONENT_WEIGHT = 0.5
const FINAL_JITTER = 0.2
/**
 * 絡ませる指示の回数（MIN_MOVES 〜 MIN_MOVES + MOVE_COUNT_SPREAD 回）。
 * はじめの数手は自分の側で手足を動かすだけで、相手の胴に近い円へ届くのは4手目あたりからなので、触れ合うまで手数を重ねる
 */
const MIN_MOVES = 5
const MOVE_COUNT_SPREAD = 2

/** 指示の順に手足を動かした、2人の置き場所 */
export const placementsAfter = (moves: readonly Move[]): readonly [Placement, Placement] =>
  moves.reduce<readonly [Placement, Placement]>((placements, move) => {
    const moved = { ...placements[move.player], [move.limb]: move.spot }
    return move.player === 0 ? [moved, placements[1]] : [placements[0], moved]
  }, INITIAL_SPOTS)

/** 置き場所に手足を置いたとき、手足の先がいちばん離れてしまう円とのずれ（m） */
export const reachMiss = (placement: Placement, player: PlayerIndex): number => {
  const contacts = contactsOf(placement)
  const pose = solvePose(contacts, PLAYER_FACINGS[player])
  return Math.max(...LIMBS.map((limb) => distance(pose[limb], contacts[limb])))
}

/** 両足の中点から両手の中点への水平の向き（長さはそのまま） */
const bodySpanOf = (placement: Placement): Vec3 => {
  const contacts = contactsOf(placement)
  return sub(flat(midpoint(contacts.handL, contacts.handR)), flat(midpoint(contacts.footL, contacts.footR)))
}

/** 置き場所での体の向き（両足の中点から両手の中点へ）が、始めの向きからどれだけ回っているか（ラジアン、0〜π） */
export const headingTurnOf = (placement: Placement, player: PlayerIndex): number => {
  const span = bodySpanOf(placement)
  const facing = PLAYER_FACINGS[player]
  return Math.abs(Math.atan2(length(cross(facing, span)), dot(facing, span)))
}

/** 置き場所のすべての手足が円に届き、体の向きが始めの向きから回りすぎていないか */
export const isReachable = (placement: Placement, player: PlayerIndex): boolean =>
  length(bodySpanOf(placement)) >= MIN_BODY_SPAN && headingTurnOf(placement, player) <= MAX_HEADING_TURN && reachMiss(placement, player) <= REACH_TOLERANCE

/** 姿勢の手足1本ぶんの線分（付け根から先まで） */
const limbSegmentsOf = (pose: Pose): readonly (readonly [Vec3, Vec3])[] =>
  LIMBS.map((limb) => [pose[LIMB_CHAINS[limb].root], pose[limb]] as const)

/** 2本の手足の線分が、上から見て交差するか */
const limbsCross = (a: readonly [Vec3, Vec3], b: readonly [Vec3, Vec3]): boolean => segmentsCrossFlat(a[0], a[1], b[0], b[1])

/**
 * 上から見て交差している、2人のあいだの手足の組の数。
 * 手足は付け根から先までの線分とみなす（肘・膝の曲がりは見ない）。
 */
export const crossingsBetween = (poses: PosePair): number => {
  const first = limbSegmentsOf(poses[0])
  const second = limbSegmentsOf(poses[1])
  return first.flatMap((a) => second.filter((b) => limbsCross(a, b))).length
}

/** 上から見て交差している、同じ人の手足どうしの組の数（2人ぶんの合計） */
export const crossingsWithin = (poses: PosePair): number =>
  poses
    .map(limbSegmentsOf)
    .reduce((count, segments) => count + segments.flatMap((a, index) => segments.slice(index + 1).filter((b) => limbsCross(a, b))).length, 0)

/** 上から見て交差している手足の組の数。2人のあいだの組と、同じ人の手足どうしの組の両方を数える */
export const crossingCount = (poses: PosePair): number => crossingsBetween(poses) + crossingsWithin(poses)

/** 置き場所から2人の姿勢を解く */
const posesOf = (placements: readonly [Placement, Placement]): PosePair => [
  solvePose(contactsOf(placements[0]), PLAYER_FACINGS[0]),
  solvePose(contactsOf(placements[1]), PLAYER_FACINGS[1]),
]

/** 円から、相手の胴（首の付け根から脚の付け根まで）の真下までの水平の距離（m）。小さいほど絡み合う */
export const entanglementDistance = (placements: readonly [Placement, Placement], opponent: PlayerIndex, spot: Spot): number => {
  const pose = solvePose(contactsOf(placements[opponent]), PLAYER_FACINGS[opponent])
  return distanceToSegment(spotPosition(spot), flat(pose.neck), flat(pose.pelvis))
}

/** だれの手足も置かれていない円 */
const freeSpots = (placements: readonly [Placement, Placement]): readonly Spot[] =>
  ALL_SPOTS.filter((spot) => !placements.some((placement) => LIMBS.some((limb) => sameSpot(placement[limb], spot))))

/** 候補のうち点数がいちばん高いもの。候補が無ければ投げる */
const best = <T,>(candidates: readonly { readonly item: T; readonly score: number }[], what: string): T => {
  const top = candidates.reduce<{ readonly item: T; readonly score: number } | null>((found, candidate) => (found === null || candidate.score > found.score ? candidate : found), null)
  if (top === null) throw new Error(`${what}の候補がありません`)
  return top.item
}

/** 絡ませる指示を1つ選ぶ */
const chooseEntanglingMove = (placements: readonly [Placement, Placement], player: PlayerIndex, lastLimb: Limb | null, random: () => number): Move => {
  const opponent = opponentOf(player)
  const spots = freeSpots(placements)
  const crossingsBefore = crossingCount(posesOf(placements))
  const candidates = LIMBS.flatMap((limb) =>
    spots
      .filter((spot) => isReachable({ ...placements[player], [limb]: spot }, player))
      .map((spot) => {
        const moved = { ...placements[player], [limb]: spot }
        const crossingGain = crossingCount(posesOf(player === 0 ? [moved, placements[1]] : [placements[0], moved])) - crossingsBefore
        return {
          item: { player, limb, spot },
          score:
            -entanglementDistance(placements, opponent, spot) +
            crossingGain * CROSSING_BONUS -
            (limb === lastLimb ? SAME_LIMB_PENALTY : 0) +
            random() * ENTANGLE_JITTER,
        }
      }),
  )
  return best(candidates, '絡ませる指示')
}

/** 倒れ込ませる最後の指示を選ぶ */
const chooseFinalMove = (placements: readonly [Placement, Placement], player: PlayerIndex, random: () => number): Move => {
  const opponent = opponentOf(player)
  const spots = freeSpots(placements)
  const candidates = LIMBS.flatMap((limb) =>
    spots.flatMap((spot) => {
      const miss = reachMiss({ ...placements[player], [limb]: spot }, player)
      if (miss < UNREACHABLE_MISS) return []
      return [
        {
          item: { player, limb, spot },
          score: -miss - entanglementDistance(placements, opponent, spot) * FINAL_OPPONENT_WEIGHT + random() * FINAL_JITTER,
        },
      ]
    }),
  )
  return best(candidates, '最後の指示')
}

/**
 * 1回の対戦の指示の並びを決める。
 *
 * @param random 種から決まる乱数（0以上1未満）。同じ乱数の並びからは同じ指示の並びになる
 * @throws 置ける候補が無い場合（始めの置き場所と円の並びでは起きない。起きたら計算の誤り）
 */
export const planGame = (random: () => number): Plan => {
  const count = MIN_MOVES + Math.floor(random() * (MOVE_COUNT_SPREAD + 1))
  const moves: Move[] = []
  const lastLimbs: [Limb | null, Limb | null] = [null, null]
  for (let index = 0; index < count; index += 1) {
    const player: PlayerIndex = index % 2 === 0 ? 0 : 1
    const move = chooseEntanglingMove(placementsAfter(moves), player, lastLimbs[player], random)
    moves.push(move)
    lastLimbs[player] = move.limb
  }
  const finalPlayer: PlayerIndex = count % 2 === 0 ? 0 : 1
  return { moves, finalMove: chooseFinalMove(placementsAfter(moves), finalPlayer, random) }
}
