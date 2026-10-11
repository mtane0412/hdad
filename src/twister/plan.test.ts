/**
 * ツイスターの指示の選び方（plan.ts）のテスト
 *
 * 決めた流れは次のとおり。
 * - 絡ませる指示を5〜7回出す。手番はレイドした人から交互に回る
 * - 絡ませる指示は、空いていて届く円のうち、相手の胴に近い円と、手足が交差する円を選ぶ（純粋な乱数にせず、絡みやすい組み合わせを優先する）
 * - 体の向き（足から手へ）が始めの向きから MAX_HEADING_TURN までの置き場所なら候補にする（横を向く姿勢を許し、裏返る姿勢は除く）
 * - 最後に、届かない円を指す指示を出す（指された人は手を伸ばして倒れ込む）
 * - 同じ種からは同じ指示の並びになる
 */
import { describe, expect, it } from 'vitest'
import { LIMBS, type Limb } from './body'
import { createRandom } from '../core/background'
import { ALL_SPOTS, sameSpot, type Spot } from './mat'
import { CROSSING_BONUS, crossingCount, crossingsBetween, crossingsWithin, entanglementDistance, headingTurnOf, isReachable, MAX_HEADING_TURN, placementsAfter, planGame, reachMiss, UNREACHABLE_MISS, type Move } from './plan'
import { INITIAL_SPOTS, PLAYER_FACINGS, opponentOf, type Placement, type PlayerIndex } from './players'
import { contactsOf, solvePose } from './pose'

/** 試す種の数 */
const SEED_COUNT = 50

/** 倒れる直前に2人のあいだで手足が交差している対戦の割合の下限。手足の交差を加点する前は、半分ほどだった */
const MIN_CROSSED_GAME_RATIO = 0.75

/** 置き場所から2人の姿勢を解く */
const posesOf = (placements: readonly [Placement, Placement]) =>
  [solvePose(contactsOf(placements[0]), PLAYER_FACINGS[0]), solvePose(contactsOf(placements[1]), PLAYER_FACINGS[1])] as const

/** ある時点で、だれかの手足が置かれている円か */
const occupied = (placements: readonly [Placement, Placement], spot: Spot): boolean =>
  placements.some((placement) => LIMBS.some((limb) => sameSpot(placement[limb], spot)))

describe('planGame', () => {
  it('同じ種からは同じ指示の並びになる', () => {
    expect(planGame(createRandom(42))).toEqual(planGame(createRandom(42)))
  })

  it('絡ませる指示は5〜7回で、種によってどの回数も出る', () => {
    // 2〜3回では2人の体が触れ合う前に倒れ込んでしまうので、触れ合うまで手数を重ねる（#319）
    const counts = new Set(Array.from({ length: SEED_COUNT }, (_, seed) => planGame(createRandom(seed)).moves.length))
    expect([...counts].sort()).toEqual([5, 6, 7])
  })

  it('手番はレイドした人から交互に回り、最後の指示も続きの手番になる', () => {
    for (let seed = 0; seed < SEED_COUNT; seed += 1) {
      const plan = planGame(createRandom(seed))
      plan.moves.forEach((move, index) => expect(move.player).toBe(index % 2))
      expect(plan.finalMove.player).toBe(plan.moves.length % 2)
    }
  })

  it('絡ませる指示は、空いている円を指し、指された手足が届く', () => {
    for (let seed = 0; seed < SEED_COUNT; seed += 1) {
      const plan = planGame(createRandom(seed))
      plan.moves.forEach((move, index) => {
        const before = placementsAfter(plan.moves.slice(0, index))
        expect(occupied(before, move.spot), `種${seed}の${index + 1}回目`).toBe(false)
        expect(isReachable(placementsAfter(plan.moves.slice(0, index + 1))[move.player], move.player), `種${seed}の${index + 1}回目`).toBe(true)
      })
    }
  })

  it('最後の指示は、空いているが届かない円を指す', () => {
    for (let seed = 0; seed < SEED_COUNT; seed += 1) {
      const plan = planGame(createRandom(seed))
      const before = placementsAfter(plan.moves)
      const { player, limb, spot } = plan.finalMove
      expect(occupied(before, spot)).toBe(false)
      expect(reachMiss({ ...before[player], [limb]: spot }, player)).toBeGreaterThanOrEqual(UNREACHABLE_MISS)
    }
  })

  it('揺らぎが無ければ、1回目は届く円のうち「相手の胴への近さ」と「増える交差の加点」の合計がいちばん良い円を選ぶ', () => {
    const plan = planGame(() => 0)
    const first = plan.moves[0]
    if (first === undefined) throw new Error('指示がありません')
    const player: PlayerIndex = 0
    /** 候補の点数。相手の胴に近いほど、交差が増えるほど高い */
    const scoreOf = (limb: Limb, spot: Spot): number =>
      -entanglementDistance(INITIAL_SPOTS, opponentOf(player), spot) + crossingCount(posesOf([{ ...INITIAL_SPOTS[player], [limb]: spot }, INITIAL_SPOTS[1]])) * CROSSING_BONUS
    const candidates = LIMBS.flatMap((limb: Limb) =>
      ALL_SPOTS.filter((spot) => !occupied(INITIAL_SPOTS, spot))
        .filter((spot) => isReachable({ ...INITIAL_SPOTS[player], [limb]: spot }, player))
        .map((spot) => scoreOf(limb, spot)),
    )
    expect(scoreOf(first.limb, first.spot)).toBe(Math.max(...candidates))
  })
})

describe('体の向きの縛り', () => {
  it('始めの置き場所では、体は始めの向きのまま（回っていない）', () => {
    expect(headingTurnOf(INITIAL_SPOTS[0], 0)).toBeCloseTo(0, 6)
    expect(headingTurnOf(INITIAL_SPOTS[1], 1)).toBeCloseTo(0, 6)
  })

  it('両手を横の列へ寄せて体が横を向いても、上限の角度までなら候補にする', () => {
    // レイドした人（0番）の両手を、足（黄と緑の0行目）の横の赤の列の0行目と1行目へ寄せる。体は始めの向きから70°ほど回る
    const sideways: Placement = { ...INITIAL_SPOTS[0], handR: { color: 'red', row: 0 }, handL: { color: 'red', row: 1 } }
    expect(headingTurnOf(sideways, 0)).toBeGreaterThan(Math.PI / 3)
    expect(headingTurnOf(sideways, 0)).toBeLessThanOrEqual(MAX_HEADING_TURN)
    expect(isReachable(sideways, 0)).toBe(true)
  })

  it('両手が両足より後ろへ回り込む置き場所は、上限の角度を超えるので候補にしない（体が裏返らないように）', () => {
    // 足を1行目へ進め、両手を赤の0行目と1行目に置くと、体は始めの向きから110°ほど回る
    const turnedBack: Placement = { footR: { color: 'yellow', row: 1 }, footL: { color: 'green', row: 1 }, handR: { color: 'red', row: 0 }, handL: { color: 'red', row: 1 } }
    expect(headingTurnOf(turnedBack, 0)).toBeGreaterThan(MAX_HEADING_TURN)
    expect(isReachable(turnedBack, 0)).toBe(false)
  })
})

describe('crossingCount', () => {
  it('始めの置き場所では、誰の手足も交差していない', () => {
    expect(crossingCount(posesOf(INITIAL_SPOTS))).toBe(0)
  })

  it('左手を右手の向こうへ置くと、自分の手足どうしの交差を数える', () => {
    // レイドした人（0番）の右手は黄の2行目にある。左手（緑の2行目）を、右手より外の赤の2行目へ置くと腕が交差する
    const crossedArms: readonly [Placement, Placement] = [{ ...INITIAL_SPOTS[0], handL: { color: 'red', row: 2 } }, INITIAL_SPOTS[1]]
    expect(crossingsWithin(posesOf(crossedArms))).toBe(1)
    expect(crossingsBetween(posesOf(crossedArms))).toBe(0)
  })

  it('脚を相手の腕の下へ差し込むと、2人のあいだの交差を数える', () => {
    // 置けるかは問わず、数え方だけを確かめる。レイドした人（0番）の左足を、配信者（1番）の右腕の先（緑の3行目）まで伸ばす
    const tangled: readonly [Placement, Placement] = [{ ...INITIAL_SPOTS[0], footL: { color: 'green', row: 3 } }, INITIAL_SPOTS[1]]
    expect(crossingsBetween(posesOf(tangled))).toBe(1)
  })
})

describe('planGame の絡み方', () => {
  it('多くの対戦で、倒れる直前に2人の手足が上から見て交差している', () => {
    let crossedGames = 0
    for (let seed = 0; seed < SEED_COUNT; seed += 1) {
      const plan = planGame(createRandom(seed))
      if (crossingsBetween(posesOf(placementsAfter(plan.moves))) > 0) crossedGames += 1
    }
    expect(crossedGames / SEED_COUNT).toBeGreaterThanOrEqual(MIN_CROSSED_GAME_RATIO)
  })
})

describe('placementsAfter', () => {
  it('指示の順に手足を動かした置き場所を返す', () => {
    const move: Move = { player: 1, limb: 'handR', spot: { color: 'blue', row: 2 } }
    const [raider, streamer] = placementsAfter([move])
    expect(raider).toEqual(INITIAL_SPOTS[0])
    expect(streamer.handR).toEqual({ color: 'blue', row: 2 })
    expect(streamer.footL).toEqual(INITIAL_SPOTS[1].footL)
  })
})

describe('entanglementDistance', () => {
  it('相手の胴の真下の円は、マットの隅の円より近い', () => {
    // 配信者（1番）の胴は、手（3行目）と足（5行目）のあいだの黄と緑の列の上にある
    const under = entanglementDistance(INITIAL_SPOTS, 1, { color: 'yellow', row: 4 })
    const corner = entanglementDistance(INITIAL_SPOTS, 1, { color: 'red', row: 0 })
    expect(under).toBeLessThan(corner)
  })
})
