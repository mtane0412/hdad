/**
 * ツイスターの1回の対戦の進み方（game.ts）のテスト
 *
 * 対戦は種（seed）だけから決まり、場面と2人の姿勢は再生を始めてからの経過時間だけから決まる（フレーム間の状態を持たない）。
 * 決めた流れは次のとおり。
 * 1. 2人が四つんばいで向かい合って登場する（INTRO_MS）
 * 2. 絡ませる指示を5〜7回: スピナーを回し、指された手足を指された円へ運ぶ。はじめの2手はゆっくり（SLOW_PACE）、
 *    3手目からは速く（FAST_PACE）回して運ぶ（手数を増やしても対戦が長くなりすぎないように）
 * 3. 最後の指示: 速くスピナーを回し、届かない円へ手足を伸ばし（REACH_MS）、倒れ込む（先に計算した記録を再生する）
 * 4. 先にマットに着いた人の負けとして、勝者を出す（RESULT_MS）
 */
import { describe, expect, it } from 'vitest'
import { JOINT_RADII, LIMBS, LOSING_JOINTS } from './body'
import { DEMO_TWISTER_CALLS, DEMO_TWISTER_INTERVAL_MS } from './demo'
import { COLLAPSE_PLAYBACK_RATE, FAST_PACE, INTRO_MS, REACH_MS, RESULT_MS, SLOW_PACE, createGame, gameSceneAt, paceOf, spinStartOf } from './game'
import { COLLAPSE_FRAME_MS, STANDING_CLEARANCE, collapsePosesAt } from './physics'
import { INITIAL_SPOTS, opponentOf } from './players'
import { restingOn } from './pose'
import { distance } from './vec'

/** 試す種の数 */
const SEED_COUNT = 30
/** どの種でも収まってほしい対戦の長さ（ミリ秒）。手数を増やしても35秒前後に収める */
const MIN_TOTAL_MS = 28_000
const MAX_TOTAL_MS = 42_000
/** 倒れ込ませた人が負ける割合の下限。手数を増やして絡み合っても、最後の指示で倒れた人が負ける決着を主にする */
const MIN_FALLER_LOSS_RATIO = 0.6
/** プレビューで次の対戦を流すまでに、対戦を流しきってから空ける間の下限（ミリ秒） */
const DEMO_MIN_GAP_MS = 1000

describe('createGame', () => {
  /** 種1〜SEED_COUNT の対戦。1回の対戦を作るのに時間がかかるので、テストごとに作り直さず一度だけ作る */
  const games = Array.from({ length: SEED_COUNT }, (_, index) => createGame(index + 1))

  it('同じ種からは、同じ指示・同じ勝敗・同じ長さになる', () => {
    const first = createGame(20261006)
    const second = createGame(20261006)
    expect(second.plan).toEqual(first.plan)
    expect(second.touchdown).toEqual(first.touchdown)
    expect(second.totalMs).toBe(first.totalMs)
  })

  it('どの種でも決着がつき、35秒前後に収まる', () => {
    for (const game of games) {
      expect(game.totalMs, `種${game.seed}`).toBeGreaterThanOrEqual(MIN_TOTAL_MS)
      expect(game.totalMs, `種${game.seed}`).toBeLessThanOrEqual(MAX_TOTAL_MS)
    }
  })

  it('多くの種で、最後の指示で倒れ込ませた人が負ける', () => {
    const fallerLosses = games.filter((game) => game.touchdown.player === game.plan.finalMove.player).length
    expect(fallerLosses / games.length).toBeGreaterThanOrEqual(MIN_FALLER_LOSS_RATIO)
  })

  it('プレビューの対戦は、次の対戦を流すまでに流しきる', () => {
    for (const call of DEMO_TWISTER_CALLS) {
      expect(createGame(call.seed).totalMs + DEMO_MIN_GAP_MS, `種${call.seed}`).toBeLessThanOrEqual(DEMO_TWISTER_INTERVAL_MS)
    }
  })

  it('どの種でも、倒れはじめた瞬間には誰の部位もマットに着いていない（体を支えた高さから倒れ込む）', () => {
    for (const game of games) {
      const start = game.collapse.frames[0]
      if (start === undefined) throw new Error('倒れ込みの記録がありません')
      for (const pose of start) {
        for (const joint of LOSING_JOINTS) {
          expect(pose[joint].y - JOINT_RADII[joint], `種${game.seed}の${joint}`).toBeGreaterThanOrEqual(STANDING_CLEARANCE - 1e-6)
        }
      }
    }
  })
})

describe('gameSceneAt', () => {
  const game = createGame(12345)
  const moveCount = game.plan.moves.length
  /** 最後の指示のスピナーを回しはじめる時刻 */
  const finalSpinAt = spinStartOf(moveCount)
  /** 最後の指示のスピナーを見せる長さ */
  const finalSpinMs = paceOf(moveCount).spinMs
  /** 倒れはじめる時刻 */
  const collapseAt = finalSpinAt + finalSpinMs + REACH_MS

  it('はじめの2手はゆっくり、3手目からと最後の指示は速く回して運ぶ', () => {
    expect(paceOf(0)).toEqual(SLOW_PACE)
    expect(paceOf(1)).toEqual(SLOW_PACE)
    expect(paceOf(2)).toEqual(FAST_PACE)
    expect(paceOf(moveCount)).toEqual(FAST_PACE)
    // 速い手番は、針が止まってから指示を読む間を残したうえで、ゆっくりの手番より短い
    expect(FAST_PACE.spinMs).toBeGreaterThan(FAST_PACE.turnMs)
    expect(FAST_PACE.spinMs + FAST_PACE.moveMs).toBeLessThan(SLOW_PACE.spinMs + SLOW_PACE.moveMs)
  })

  it('i 手目のスピナーは、その前の手番の長さを足した時刻に回りはじめる', () => {
    expect(spinStartOf(0)).toBe(INTRO_MS)
    expect(spinStartOf(1)).toBe(INTRO_MS + SLOW_PACE.spinMs + SLOW_PACE.moveMs)
    expect(spinStartOf(3)).toBe(INTRO_MS + 2 * (SLOW_PACE.spinMs + SLOW_PACE.moveMs) + FAST_PACE.spinMs + FAST_PACE.moveMs)
  })

  it('はじめは登場の場面で、2人の手足は始めの円に乗っている', () => {
    const scene = gameSceneAt(game, 0)
    expect(scene.phase).toBe('intro')
    for (const limb of LIMBS) {
      expect(distance(scene.poses[0][limb], restingOn(INITIAL_SPOTS[0][limb], limb))).toBeLessThan(1e-6)
      expect(distance(scene.poses[1][limb], restingOn(INITIAL_SPOTS[1][limb], limb))).toBeLessThan(1e-6)
    }
  })

  it('登場のあと、スピナーを回して手足を運ぶ場面を指示の数だけくり返す', () => {
    game.plan.moves.forEach((move, index) => {
      const spinAt = spinStartOf(index)
      const spin = gameSceneAt(game, spinAt)
      expect(spin.phase).toBe('spin')
      expect(spin.spin).toMatchObject({ move, index, final: false, turnMs: paceOf(index).turnMs })
      expect(gameSceneAt(game, spinAt + paceOf(index).spinMs).phase).toBe('move')
    })
  })

  it('運び終えた手足は、指された円に乗っている', () => {
    game.plan.moves.forEach((move, index) => {
      const movedAt = spinStartOf(index + 1)
      const pose = gameSceneAt(game, movedAt).poses[move.player]
      expect(distance(pose[move.limb], restingOn(move.spot, move.limb))).toBeLessThan(0.02)
    })
  })

  it('最後の指示のあと、手を伸ばして倒れ込み、勝者を出して終わる', () => {
    const finalSpin = gameSceneAt(game, finalSpinAt)
    expect(finalSpin.phase).toBe('spin')
    expect(finalSpin.spin).toMatchObject({ move: game.plan.finalMove, final: true, turnMs: FAST_PACE.turnMs })
    expect(gameSceneAt(game, finalSpinAt + finalSpinMs).phase).toBe('reach')
    expect(gameSceneAt(game, collapseAt).phase).toBe('collapse')

    const result = gameSceneAt(game, game.totalMs - RESULT_MS)
    expect(result.phase).toBe('result')
    expect(result.result).toEqual({ loser: game.touchdown.player, winner: opponentOf(game.touchdown.player), joint: game.touchdown.joint })
    expect(result.done).toBe(false)
    expect(gameSceneAt(game, game.totalMs).done).toBe(true)
  })

  it('倒れ込みは、先に計算した記録をスローモーションで再生し、記録を流しきってから勝者を出す', () => {
    const watchedMs = 600
    expect(gameSceneAt(game, collapseAt + watchedMs).poses).toEqual(collapsePosesAt(game.collapse, watchedMs * COLLAPSE_PLAYBACK_RATE))
    const recordedMs = (game.collapse.frames.length - 1) * COLLAPSE_FRAME_MS
    expect(game.totalMs).toBeCloseTo(collapseAt + recordedMs / COLLAPSE_PLAYBACK_RATE + RESULT_MS, 6)
  })

  it('倒れはじめの前後で、姿勢は飛ばずにつながる', () => {
    const before = gameSceneAt(game, collapseAt - 1).poses
    const after = gameSceneAt(game, collapseAt + 1).poses
    for (const player of [0, 1] as const) {
      expect(distance(before[player].head, after[player].head)).toBeLessThan(0.05)
    }
  })

  it('同じ時刻なら、何度・どの順で求めても同じ場面になる', () => {
    const late = gameSceneAt(game, collapseAt + 500)
    gameSceneAt(game, 0)
    expect(gameSceneAt(game, collapseAt + 500)).toEqual(late)
  })
})
