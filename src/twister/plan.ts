/**
 * ツイスターの指示の選び方
 *
 * 本物のツイスターではスピナーが手足と色を決め、どの円に置くかを人が選ぶ。ここでは「できるだけ絡み合う」ように、
 * 手足・色・円の組み合わせをまとめて選び、スピナーはその手足と色に止まる演出にする（純粋な乱数にはしない）。
 *
 * - 絡ませる指示（2回か3回）: 空いていて届く円のうち、相手の胴に近い円を優先する。同じ人が同じ手足を続けて動かすのは避ける。
 *   体の向きが急に裏返らないよう、両手が両足より前にある置き場所だけを候補にする
 * - 最後の指示: 空いているが届かない円を指す。届かなさが小さい（あと少しで届きそうな）円と、相手の胴に近い円を優先する
 *   （手を伸ばして、相手の上へ倒れ込むように）
 *
 * 揺らぎは渡された乱数（種から決まる）だけから作るので、同じ種からは同じ指示の並びになる。
 */
import { LIMBS, type Limb } from './body'
import { ALL_SPOTS, sameSpot, spotPosition, type Spot } from './mat'
import { INITIAL_SPOTS, PLAYER_FACINGS, opponentOf, type Placement, type PlayerIndex } from './players'
import { contactsOf, solvePose } from './pose'
import { distance, distanceToSegment, dot, flat, midpoint, sub } from './vec'

/** 1回の指示（だれの・どの手足を・どの円へ） */
export interface Move {
  readonly player: PlayerIndex
  readonly limb: Limb
  readonly spot: Spot
}

/** 1回の対戦の指示の並び */
export interface Plan {
  /** 絡ませる指示（2回か3回） */
  readonly moves: readonly Move[]
  /** 倒れ込ませる最後の指示（届かない円を指す） */
  readonly finalMove: Move
}

/** 届いたとみなす、手足の先と円のずれ（m） */
const REACH_TOLERANCE = 0.01
/** 届かないとみなす、手足の先と円のずれ（m）。少し伸ばせば届きそうな円では倒れ込む理由にならないので、はっきり離れた円にする */
export const UNREACHABLE_MISS = 0.15
/** 両手の中点が両足の中点より、始めの向きへ最低これだけ前にあること（m）。体の向きが裏返らないように */
const MIN_FORWARD_REACH = 0.3
/** 絡ませる指示の揺らぎの大きさ（m 相当）。相手の胴への近さの差がこれより小さい候補は、乱数で入れ替わる */
const ENTANGLE_JITTER = 0.3
/** 同じ人が同じ手足を続けて動かす候補の減点（m 相当） */
const SAME_LIMB_PENALTY = 0.2
/** 最後の指示で、相手の胴への近さに掛ける重みと揺らぎの大きさ */
const FINAL_OPPONENT_WEIGHT = 0.5
const FINAL_JITTER = 0.2
/** 絡ませる指示の回数（MIN_MOVES か MIN_MOVES + 1 回） */
const MIN_MOVES = 2

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

/** 置き場所のすべての手足が円に届き、両手が両足より前にあるか */
export const isReachable = (placement: Placement, player: PlayerIndex): boolean => {
  const contacts = contactsOf(placement)
  const forward = dot(sub(flat(midpoint(contacts.handL, contacts.handR)), flat(midpoint(contacts.footL, contacts.footR))), PLAYER_FACINGS[player])
  return forward >= MIN_FORWARD_REACH && reachMiss(placement, player) <= REACH_TOLERANCE
}

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
  const candidates = LIMBS.flatMap((limb) =>
    spots
      .filter((spot) => isReachable({ ...placements[player], [limb]: spot }, player))
      .map((spot) => ({
        item: { player, limb, spot },
        score: -entanglementDistance(placements, opponent, spot) - (limb === lastLimb ? SAME_LIMB_PENALTY : 0) + random() * ENTANGLE_JITTER,
      })),
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
  const count = MIN_MOVES + (random() < 0.5 ? 0 : 1)
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
