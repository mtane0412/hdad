/**
 * ツイスターの指示の選び方（plan.ts）のテスト
 *
 * 決めた流れは次のとおり。
 * - 絡ませる指示を2回か3回出す。手番はレイドした人から交互に回る
 * - 絡ませる指示は、空いていて届く円のうち、相手の胴に近い円を選ぶ（純粋な乱数にせず、絡みやすい組み合わせを優先する）
 * - 最後に、届かない円を指す指示を出す（指された人は手を伸ばして倒れ込む）
 * - 同じ種からは同じ指示の並びになる
 */
import { describe, expect, it } from 'vitest'
import { LIMBS, type Limb } from './body'
import { createRandom } from '../core/background'
import { ALL_SPOTS, sameSpot, type Spot } from './mat'
import { entanglementDistance, isReachable, placementsAfter, planGame, reachMiss, UNREACHABLE_MISS, type Move } from './plan'
import { INITIAL_SPOTS, opponentOf, type Placement, type PlayerIndex } from './players'

/** 試す種の数 */
const SEED_COUNT = 50

/** ある時点で、だれかの手足が置かれている円か */
const occupied = (placements: readonly [Placement, Placement], spot: Spot): boolean =>
  placements.some((placement) => LIMBS.some((limb) => sameSpot(placement[limb], spot)))

describe('planGame', () => {
  it('同じ種からは同じ指示の並びになる', () => {
    expect(planGame(createRandom(42))).toEqual(planGame(createRandom(42)))
  })

  it('絡ませる指示は2回か3回で、種によってどちらも出る', () => {
    const counts = new Set(Array.from({ length: SEED_COUNT }, (_, seed) => planGame(createRandom(seed)).moves.length))
    expect([...counts].sort()).toEqual([2, 3])
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

  it('揺らぎが無ければ、1回目は届く円のうち相手の胴にいちばん近い円を選ぶ', () => {
    const plan = planGame(() => 0)
    const first = plan.moves[0]
    if (first === undefined) throw new Error('指示がありません')
    const player: PlayerIndex = 0
    const candidates = LIMBS.flatMap((limb: Limb) =>
      ALL_SPOTS.filter((spot) => !occupied(INITIAL_SPOTS, spot))
        .filter((spot) => isReachable({ ...INITIAL_SPOTS[player], [limb]: spot }, player))
        .map((spot) => entanglementDistance(INITIAL_SPOTS, opponentOf(player), spot)),
    )
    expect(entanglementDistance(INITIAL_SPOTS, opponentOf(player), first.spot)).toBe(Math.min(...candidates))
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
