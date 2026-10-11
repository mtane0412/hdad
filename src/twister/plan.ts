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
 * - 裏返る指示: 手の指示のうち、仰向けに裏返れば届く円へ手を運ぶ指示を、1人1回まで候補に加える（FLIP_BONUS を加点して混ぜる）。
 *   裏返った人は、その対戦のあいだ仰向け（ブリッジ）のままで、それより後の指示も仰向けの姿勢で届くかを見る。
 *   裏返ると人形の左右が入れ替わるので、腕が胴の下をくぐる・脚どうしがめり込む置き場所（isSelfClear）と、半分まで回したときに
 *   ほかの3本が円から離れる置き場所と、相手の胴が近くて下で回ることになる置き場所は候補にしない
 * - 最後の指示: 空いているが届かない円を指す。届かなさが小さい（あと少しで届きそうな）円と、相手の胴に近い円を優先する
 *   （手を伸ばして、相手の上へ倒れ込むように）
 *
 * 揺らぎは渡された乱数（種から決まる）だけから作るので、同じ種からは同じ指示の並びになる。
 */
import { LIMB_CHAINS, LIMBS, type Limb, type Pose } from './body'
import { ALL_SPOTS, sameSpot, spotPosition, type Spot } from './mat'
import type { PosePair } from './physics'
import { INITIAL_SPOTS, PLAYER_FACINGS, opponentOf, type Placement, type PlayerIndex } from './players'
import { contactsOf, restingOn, solvePose, type Contacts } from './pose'
import { UP, add, cross, distance, distanceToSegment, dot, flat, length, midpoint, scale, segmentDistance, segmentDistanceFlat, segmentsCrossFlat, sub, type Vec3 } from './vec'

/** 1回の指示（だれの・どの手足を・どの円へ） */
export interface Move {
  readonly player: PlayerIndex
  readonly limb: Limb
  readonly spot: Spot
  /** 手を運びながら、うつ伏せから仰向けに裏返る指示か */
  readonly flip: boolean
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
/** 裏返る指示の候補への加点（m 相当） */
const FLIP_BONUS = 0.8
/** 裏返る途中（半分まで回したとき）に、ほかの3本の手足の先が円から離れてよい距離（m） */
const FLIP_REACH_TOLERANCE = 0.02
/** 裏返る手を運ぶときに持ち上げる高さ（m）。仰向けへ回る体の上を越えさせる */
export const FLIP_ARC_HEIGHT = 0.5
/** 腕の骨（肩→肘・肘→手）と背骨（首→腰）を、これより近づけない（m。背骨と腕の太さの和）。近いと腕が胴の下をくぐって見える */
const ARM_TORSO_CLEARANCE = 0.16
/** 左右の脚の骨（付け根→膝・膝→足）を、これより近づけない（m。太ももの太さの和）。物理は自分の体どうしのぶつかりを持たないため、置き場所で避ける */
const LEG_CLEARANCE = 0.13
/** 2人の胴（首から腰）が上から見てこの距離（m）まで近づいたら、下になる人が伏せはじめる（game.ts） */
export const CROUCH_START_GAP = 0.3
/** 2人の胴が上から見てこの距離（m）まで近づいたら、下になる人は伏せきる */
export const CROUCH_FULL_GAP = 0.12

/** 指示の順に手足を動かした、2人の置き場所 */
export const placementsAfter = (moves: readonly Move[]): readonly [Placement, Placement] =>
  moves.reduce<readonly [Placement, Placement]>((placements, move) => {
    const moved = { ...placements[move.player], [move.limb]: move.spot }
    return move.player === 0 ? [moved, placements[1]] : [placements[0], moved]
  }, INITIAL_SPOTS)

/** 指示を終えた時点で、その人が仰向けに裏返っているか（裏返る指示を一度でも終えていれば、その後ずっと仰向け） */
export const supineAfter = (moves: readonly Move[], player: PlayerIndex): boolean => moves.some((move) => move.player === player && move.flip)

/** 指示を終えた時点の、2人それぞれが仰向けか */
const supinesAfter = (moves: readonly Move[]): Supines => [supineAfter(moves, 0), supineAfter(moves, 1)]

/** 置き場所に手足を置いた姿勢（仰向けなら裏返りきった姿勢） */
const poseAt = (placement: Placement, player: PlayerIndex, supine: boolean): Pose => solvePose(contactsOf(placement), PLAYER_FACINGS[player], { supine: supine ? 1 : 0 })

/** 姿勢の手足の先が、置き場所の円からいちばん離れてしまう距離（m） */
const missOf = (pose: Pose, placement: Placement): number => {
  const contacts = contactsOf(placement)
  return Math.max(...LIMBS.map((limb) => distance(pose[limb], contacts[limb])))
}

/** 置き場所に手足を置いたとき、手足の先がいちばん離れてしまう円とのずれ（m）。仰向けの人は仰向けの姿勢で見る */
export const reachMiss = (placement: Placement, player: PlayerIndex, supine = false): number => missOf(poseAt(placement, player, supine), placement)

/**
 * 腕が胴の下をくぐらず、左右の脚どうしもめり込んでいないか。
 * 仰向けでは人形の左右が入れ替わるので、置いたままの手足が反対側の付け根から伸びて、胴の下や反対の脚を通ることがある
 */
export const isSelfClear = (pose: Pose): boolean => {
  const armBones = (['L', 'R'] as const).flatMap((side) => [
    [pose[`shoulder${side}`], pose[`elbow${side}`]] as const,
    [pose[`elbow${side}`], pose[`hand${side}`]] as const,
  ])
  const armsClear = armBones.every(([from, to]) => segmentDistance(from, to, pose.neck, pose.pelvis) >= ARM_TORSO_CLEARANCE)
  const legBones = (side: 'L' | 'R') => [[pose[`hip${side}`], pose[`knee${side}`]] as const, [pose[`knee${side}`], pose[`foot${side}`]] as const]
  const legsClear = legBones('L').every(([a1, a2]) => legBones('R').every(([b1, b2]) => segmentDistance(a1, a2, b1, b2) >= LEG_CLEARANCE))
  return armsClear && legsClear
}

/** 両足の中点から両手の中点への水平の向き（長さはそのまま） */
const bodySpanOf = (contacts: Contacts): Vec3 => sub(flat(midpoint(contacts.handL, contacts.handR)), flat(midpoint(contacts.footL, contacts.footR)))

/** 体の向き（両足の中点から両手の中点へ）が、始めの向きからどれだけ回っているか（ラジアン、0〜π） */
const turnOf = (span: Vec3, player: PlayerIndex): number => {
  const facing = PLAYER_FACINGS[player]
  return Math.abs(Math.atan2(length(cross(facing, span)), dot(facing, span)))
}

/** 置き場所での体の向き（両足の中点から両手の中点へ）が、始めの向きからどれだけ回っているか（ラジアン、0〜π） */
export const headingTurnOf = (placement: Placement, player: PlayerIndex): number => turnOf(bodySpanOf(contactsOf(placement)), player)

/** 手足の先の位置で、両手と両足が重ならず（体の向きが決まり）、体の向きが回りすぎていないか */
const keepsHeading = (contacts: Contacts, player: PlayerIndex): boolean => {
  const span = bodySpanOf(contacts)
  return length(span) >= MIN_BODY_SPAN && turnOf(span, player) <= MAX_HEADING_TURN
}

/**
 * 置き場所のすべての手足が円に届き、体の向きが始めの向きから回りすぎていないか。
 * 仰向けの人は仰向けの姿勢で見て、腕が胴の下をくぐる・脚どうしがめり込む置き場所も除く
 */
export const isReachable = (placement: Placement, player: PlayerIndex, supine = false): boolean => {
  if (!keepsHeading(contactsOf(placement), player)) return false
  const pose = poseAt(placement, player, supine)
  return missOf(pose, placement) <= REACH_TOLERANCE && (!supine || isSelfClear(pose))
}

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

/** 2人それぞれが仰向けか */
type Supines = readonly [boolean, boolean]
const PRONE: Supines = [false, false]

/** 置き場所から2人の姿勢を解く（仰向けの人は仰向けで） */
const posesOf = (placements: readonly [Placement, Placement], supines: Supines = PRONE): PosePair => [
  poseAt(placements[0], 0, supines[0]),
  poseAt(placements[1], 1, supines[1]),
]

/** 円から、相手の胴（首の付け根から脚の付け根まで）の真下までの水平の距離（m）。小さいほど絡み合う */
export const entanglementDistance = (placements: readonly [Placement, Placement], opponent: PlayerIndex, spot: Spot, supines: Supines = PRONE): number => {
  const pose = poseAt(placements[opponent], opponent, supines[opponent])
  return distanceToSegment(spotPosition(spot), flat(pose.neck), flat(pose.pelvis))
}

/** 胴の近さ（上から見た距離）から、下になる人を伏せさせる度合い（0〜1）。0 なら2人の胴は離れている */
export const crouchOf = (poses: PosePair): number => {
  const gap = segmentDistanceFlat(poses[0].neck, poses[0].pelvis, poses[1].neck, poses[1].pelvis)
  return Math.min(Math.max((CROUCH_START_GAP - gap) / (CROUCH_START_GAP - CROUCH_FULL_GAP), 0), 1)
}

/** 裏返るときに上がる側（運ぶ手の側） */
export const rollSideOf = (limb: Limb): 1 | -1 => LIMB_CHAINS[limb].side

/**
 * 裏返る指示で、半分まで回したときの姿勢。運ぶ手は、もとの円と指された円の中点の FLIP_ARC_HEIGHT 上にある
 * （game.ts が手を運ぶ弧の頂点と同じ位置）
 */
export const flipMidPose = (placement: Placement, move: Move): Pose => {
  const contacts = contactsOf(placement)
  const hand = add(midpoint(restingOn(placement[move.limb], move.limb), restingOn(move.spot, move.limb)), scale(UP, FLIP_ARC_HEIGHT))
  return solvePose({ ...contacts, [move.limb]: hand }, PLAYER_FACINGS[move.player], { supine: 0.5, rollSide: rollSideOf(move.limb) })
}

/**
 * 裏返る指示として成り立つか。仰向けの姿勢で届き（腕が胴をくぐらず脚もめり込まない）、半分まで回したときにほかの3本が円に届き、
 * 回す前後で2人の胴が離れている（相手の下で回らない）
 */
const isFlipPossible = (placements: readonly [Placement, Placement], move: Move, opponentSupine: boolean): boolean => {
  const { player, limb, spot } = move
  const moved = { ...placements[player], [limb]: spot }
  if (!isReachable(moved, player, true)) return false
  const contacts = contactsOf(placements[player])
  const middle = flipMidPose(placements[player], move)
  if (LIMBS.some((other) => other !== limb && distance(middle[other], contacts[other]) > FLIP_REACH_TOLERANCE)) return false
  const supinesBefore: Supines = player === 0 ? [false, opponentSupine] : [opponentSupine, false]
  const supinesAfter: Supines = player === 0 ? [true, opponentSupine] : [opponentSupine, true]
  const after: readonly [Placement, Placement] = player === 0 ? [moved, placements[1]] : [placements[0], moved]
  return crouchOf(posesOf(placements, supinesBefore)) === 0 && crouchOf(posesOf(after, supinesAfter)) === 0
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

/** 絡ませる指示を1つ選ぶ。まだ裏返っていない人の手の指示には、裏返る指示の候補も加える */
const chooseEntanglingMove = (placements: readonly [Placement, Placement], supines: Supines, player: PlayerIndex, lastLimb: Limb | null, random: () => number): Move => {
  const opponent = opponentOf(player)
  const spots = freeSpots(placements)
  const crossingsBefore = crossingCount(posesOf(placements, supines))
  const supineAfterMove: Supines = player === 0 ? [true, supines[1]] : [supines[0], true]
  const candidates = LIMBS.flatMap((limb) =>
    spots.flatMap((spot) => {
      const moved = { ...placements[player], [limb]: spot }
      const after: readonly [Placement, Placement] = player === 0 ? [moved, placements[1]] : [placements[0], moved]
      const scoreOf = (flip: boolean): number =>
        -entanglementDistance(placements, opponent, spot, supines) +
        (crossingCount(posesOf(after, flip ? supineAfterMove : supines)) - crossingsBefore) * CROSSING_BONUS -
        (limb === lastLimb ? SAME_LIMB_PENALTY : 0) +
        (flip ? FLIP_BONUS : 0) +
        random() * ENTANGLE_JITTER
      const plain = isReachable(moved, player, supines[player]) ? [{ item: { player, limb, spot, flip: false }, score: scoreOf(false) }] : []
      const canFlip = !supines[player] && LIMB_CHAINS[limb].arm && isFlipPossible(placements, { player, limb, spot, flip: true }, supines[opponent])
      return canFlip ? [...plain, { item: { player, limb, spot, flip: true }, score: scoreOf(true) }] : plain
    }),
  )
  return best(candidates, '絡ませる指示')
}

/** 倒れ込ませる最後の指示を選ぶ */
const chooseFinalMove = (placements: readonly [Placement, Placement], supines: Supines, player: PlayerIndex, random: () => number): Move => {
  const opponent = opponentOf(player)
  const spots = freeSpots(placements)
  const candidates = LIMBS.flatMap((limb) =>
    spots.flatMap((spot) => {
      // 届かない円でも、伸ばしきったところで体の向きが保たれる円にする。両手と両足の中点が重なると、体の向き（pose.ts の forward）が
      // 一瞬で裏返り、姿勢が飛ぶ（運ぶ前と運び終えた向きがどちらも回りすぎていなければ、途中も回りすぎない）
      if (!keepsHeading({ ...contactsOf(placements[player]), [limb]: restingOn(spot, limb) }, player)) return []
      const miss = reachMiss({ ...placements[player], [limb]: spot }, player, supines[player])
      if (miss < UNREACHABLE_MISS) return []
      return [
        {
          item: { player, limb, spot, flip: false },
          score: -miss - entanglementDistance(placements, opponent, spot, supines) * FINAL_OPPONENT_WEIGHT + random() * FINAL_JITTER,
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
    const move = chooseEntanglingMove(placementsAfter(moves), supinesAfter(moves), player, lastLimbs[player], random)
    moves.push(move)
    lastLimbs[player] = move.limb
  }
  const finalPlayer: PlayerIndex = count % 2 === 0 ? 0 : 1
  return { moves, finalMove: chooseFinalMove(placementsAfter(moves), supinesAfter(moves), finalPlayer, random) }
}
