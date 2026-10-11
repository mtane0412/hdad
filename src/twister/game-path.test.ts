/**
 * ツイスターの対戦で、手足が相手の体を避ける経路で運ばれること（game.ts と path.ts）のテスト
 *
 * いまの弧だけで運ぶと、運ぶ手足が相手の体を突き抜けて押し返され、関節が速く動き、運び終えるのも遅れる（issue #325）。
 * 対戦を作るときに、指示ごとに経路の候補（path.ts の PATH_SHAPES）から1本選んで運ぶ。
 *
 * 対戦を作るのに時間がかかるので、いまの弧だけで運んでいたころに速い動きと遅れがとくに多かった種だけを調べる。
 */
import { describe, expect, it } from 'vitest'
import { JOINTS } from './body'
import { createGame, gameSceneAt, spinStartOf } from './game'
import { FAST_FRAME_STEP, PATH_SHAPES } from './path'
import { PLAYER_INDEXES } from './players'
import { restingOn } from './pose'
import { distance } from './vec'

/**
 * 調べる種。いまの弧だけで運んでいたころは、2つ合わせて倒れはじめるまでに1コマ5cmを超える動きが22件あり、
 * 運び終えた時刻に手足が円からいちばん離れていたのは 19.9cm だった（種1の3回目。相手の体に押し返されていた）
 */
const SEEDS = [1, 6] as const
/** 調べる種での、速く動いた関節の数（コマと関節の組）の上限。いまの弧だけのころ（22件）の半分 */
const MAX_FAST_STEPS = 11
/**
 * 運び終えた時刻の、手足と指された円とのずれの上限（m）。いまの弧だけのころ（19.9cm）の半分。
 * 遅れが残るのは、速い手番で1.2m運ぶ指示（追いかける速さの上限 physics.ts の MAX_FOLLOW_STEP に近い）
 */
const MAX_LANDING_GAP = 0.1
const FRAME_MS = 1000 / 60
/** 調べる種の対戦。作るのに時間がかかるので、ファイルの中で一度だけ作る */
const games = SEEDS.map((seed) => createGame(seed))

describe('手足を運ぶ経路', () => {
  it('指示ごと（最後の指示を含む）に、候補の形から1本の経路を選んでいる', () => {
    for (const game of games) {
      expect(game.paths, `種${game.seed}`).toHaveLength(game.plan.moves.length + 1)
      const swings = PATH_SHAPES.map((shape) => shape.swing)
      for (const path of game.paths) expect(swings).toContain(path.swing)
    }
  })

  it('倒れはじめるまでに、関節が速く動くことが、いまの弧だけで運んでいたころより少ない', () => {
    let fastSteps = 0
    for (const game of games) {
      let previous = gameSceneAt(game, 0).poses
      for (let elapsed = FRAME_MS; elapsed <= game.collapseStartMs; elapsed += FRAME_MS) {
        const current = gameSceneAt(game, elapsed).poses
        for (const player of PLAYER_INDEXES) {
          for (const joint of JOINTS) {
            if (distance(current[player][joint], previous[player][joint]) > FAST_FRAME_STEP) fastSteps += 1
          }
        }
        previous = current
      }
    }
    expect(fastSteps).toBeLessThanOrEqual(MAX_FAST_STEPS)
  })

  it('運んだ手足が運び終えた時刻に円から遅れる距離が、いまの弧だけで運んでいたころより小さい', () => {
    for (const game of games) {
      game.plan.moves.forEach((move, index) => {
        const pose = gameSceneAt(game, spinStartOf(index + 1)).poses[move.player]
        expect(distance(pose[move.limb], restingOn(move.spot, move.limb)), `種${game.seed}の${index + 1}回目`).toBeLessThanOrEqual(MAX_LANDING_GAP)
      })
    }
  })

  it('同じ種からは、同じ経路を選ぶ', () => {
    const [first] = games
    if (first === undefined) throw new Error('調べる対戦がありません')
    expect(createGame(first.seed).paths).toEqual(first.paths)
  })
})
