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
 *
 * 裏返る指示（plan.ts の flip）では、手を運びながら体を仰向けに回し、その後は仰向け（ブリッジ）のまま続ける。
 */
import { describe, expect, it } from 'vitest'
import { JOINT_RADII, JOINTS, LIMBS, LOSING_JOINTS, type Pose } from './body'
import { DEMO_TWISTER_CALLS, DEMO_TWISTER_INTERVAL_MS } from './demo'
import { COLLAPSE_PLAYBACK_RATE, FAST_PACE, INTRO_MS, REACH_MS, RESULT_MS, SLOW_PACE, createGame, gameSceneAt, paceOf, spinStartOf, stackingAt, type Game } from './game'
import { COLLAPSE_FRAME_MS, STANDING_CLEARANCE, collapsePosesAt } from './physics'
import { INITIAL_SPOTS, PLAYER_INDEXES, opponentOf } from './players'
import { supineAfter } from './plan'
import { restingOn } from './pose'
import { distance, lerp, midpoint, segmentDistanceFlat, sub } from './vec'

/** 試す種の数 */
const SEED_COUNT = 30
/** どの種でも収まってほしい対戦の長さ（ミリ秒）。手数を増やしても35秒前後に収める */
const MIN_TOTAL_MS = 28_000
const MAX_TOTAL_MS = 42_000
/** 倒れ込ませた人が負ける割合の下限。手数を増やして絡み合っても、最後の指示で倒れた人が負ける決着を主にする */
const MIN_FALLER_LOSS_RATIO = 0.6
/** プレビューで次の対戦を流すまでに、対戦を流しきってから空ける間の下限（ミリ秒） */
const DEMO_MIN_GAP_MS = 1000
/** 胴（首から腰のカプセル）の太さの2人ぶん（m）。胴どうしがこれより近ければめり込んでいる */
const TORSO_CONTACT = 0.22
/** 深いとみなす胴どうしのめり込み（m） */
const DEEP_TORSO_PENETRATION = 0.05
/** 胴が上から見て重なった場面のうち、深くめり込んでいてよい割合の上限。上下に重ねる前は2割ほどあった */
const MAX_DEEP_PENETRATION_RATIO = 0.03
/** 倒れはじめるまでの姿勢を調べる間隔（ミリ秒） */
const SAMPLE_MS = 100
/**
 * 1コマ（60fps）で関節が速く動いたとみなす距離（m。秒速 3m）。いちばん速く手足を運ぶ場面でも1コマ 4cm に収まる
 */
const FAST_FRAME_STEP = 0.05
/**
 * 速く動いた関節の数（コマと関節の組）の上限。手足が相手の体に押されて、ときどき速く動くのは許す。
 * 毎コマ押し出し直していた（記録しなかった）ころは、SEED_COUNT 対戦で 4800 ほどあった。いまの弧だけで運んでいたころは 160 ほどで、
 * 相手の体を避ける経路を選ぶようにして（#325）40 ほどになった
 */
const MAX_FAST_STEPS = 80
/** 1コマで関節が動いてよい距離の上限（m）。これを超えたら姿勢が飛んで見える */
const MAX_FRAME_STEP = 0.2
const FRAME_MS = 1000 / 60
/** 全コマを調べるテストの時間の上限（ミリ秒）。SEED_COUNT 対戦の全コマ（4万コマほど）を引くので、既定の5秒では足りない */
const SLOW_TEST_TIMEOUT_MS = 30_000

/** 胴（首から腰）どうしの、高さも含めたいちばん近い距離（m）。線分の上を細かく区切って測る */
const torsoDistance = (a: Pose, b: Pose): number => {
  const steps = 20
  let nearest = Number.POSITIVE_INFINITY
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      nearest = Math.min(nearest, distance(lerp(a.neck, a.pelvis, i / steps), lerp(b.neck, b.pelvis, j / steps)))
    }
  }
  return nearest
}

/** 胴が上から見て重なっているか（上から見た胴どうしの距離が、2人ぶんの太さより近い） */
const torsosOverlapFromAbove = (a: Pose, b: Pose): boolean => segmentDistanceFlat(a.neck, a.pelvis, b.neck, b.pelvis) < TORSO_CONTACT

/** 種1〜SEED_COUNT の対戦。1回の対戦を作るのに時間がかかる（倒れはじめるまでの姿勢を1コマずつ記録する）ので、ファイルの中で一度だけ作る */
const games = Array.from({ length: SEED_COUNT }, (_, index) => createGame(index + 1))

/** 種ごとの対戦の控え。同じ種の対戦を複数のテストで作り直さない（1回あたり 0.3 秒ほどかかる） */
const gameCache = new Map<number, Game>()
const cachedGame = (seed: number): Game => {
  const cached = gameCache.get(seed)
  if (cached) return cached
  const created = createGame(seed)
  gameCache.set(seed, created)
  return created
}

describe('createGame', () => {
  it('同じ種からは、同じ指示・同じ勝敗・同じ長さになる', () => {
    // 片方は控えを使い、もう片方だけを作り直して見比べる（毎回2回作らない）
    const first = cachedGame(20261006)
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
      expect(cachedGame(call.seed).totalMs + DEMO_MIN_GAP_MS, `種${call.seed}`).toBeLessThanOrEqual(DEMO_TWISTER_INTERVAL_MS)
    }
  })

  it('手足を動かさない登場の場面では、押し出しが落ち着いたら前のコマの記録をそのまま使い回す（計算を省く）', () => {
    for (const game of games) {
      const { frames, frameMs } = game.standing
      // 登場の場面の終わりのコマ。登場のあいだは手足を動かさないので、ここまでに押し出しは落ち着いている
      const lastIntroFrame = Math.floor(INTRO_MS / frameMs) - 1
      expect(frames[lastIntroFrame], `種${game.seed}`).toBe(frames[lastIntroFrame - 1])
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

describe('胴が重なったときの上下', () => {
  it('胴が上から見て重なった場面の多くで、胴どうしは深くめり込まない（どちらかが下に伏せる）', () => {
    let overlapping = 0
    let deep = 0
    for (const game of games) {
      for (let elapsed = 0; elapsed < game.collapseStartMs; elapsed += SAMPLE_MS) {
        const [raider, streamer] = gameSceneAt(game, elapsed).poses
        if (!torsosOverlapFromAbove(raider, streamer)) continue
        overlapping += 1
        if (TORSO_CONTACT - torsoDistance(raider, streamer) > DEEP_TORSO_PENETRATION) deep += 1
      }
    }
    expect(overlapping).toBeGreaterThan(0)
    expect(deep / overlapping).toBeLessThanOrEqual(MAX_DEEP_PENETRATION_RATIO)
  })

  it('下になる人が伏せきった場面では、その人の胴の中ほどが相手の胴の中ほどより低い', () => {
    for (const game of games) {
      for (let elapsed = 0; elapsed < game.collapseStartMs; elapsed += SAMPLE_MS) {
        const stacking = stackingAt(game, elapsed)
        // 伏せはじめたばかりの場面は、まだ高さが入れ替わりきっていないので見ない
        if (stacking === null || stacking.crouch < 1) continue
        const poses = gameSceneAt(game, elapsed).poses
        const heightOf = (pose: Pose): number => midpoint(pose.neck, pose.pelvis).y
        expect(heightOf(poses[stacking.bottom]), `種${game.seed}の${elapsed}ミリ秒`).toBeLessThan(heightOf(poses[opponentOf(stacking.bottom)]))
      }
    }
  })

  it('胴が重なっているあいだは、下になる人が入れ替わらない', () => {
    for (const game of games) {
      let previous: ReturnType<typeof stackingAt> = null
      for (let elapsed = 0; elapsed < game.collapseStartMs; elapsed += SAMPLE_MS) {
        const stacking = stackingAt(game, elapsed)
        if (previous !== null && stacking !== null) expect(stacking.bottom, `種${game.seed}の${elapsed}ミリ秒`).toBe(previous.bottom)
        previous = stacking
      }
    }
  })

  it('倒れはじめるまで、関節は飛ばずに動き、速く動くこともまれ（伏せるときも少しずつ下がる）', () => {
    let fastSteps = 0
    for (const game of games) {
      let previous = gameSceneAt(game, 0).poses
      for (let elapsed = FRAME_MS; elapsed <= game.collapseStartMs; elapsed += FRAME_MS) {
        const current = gameSceneAt(game, elapsed).poses
        for (const player of PLAYER_INDEXES) {
          for (const joint of JOINTS) {
            const step = distance(current[player][joint], previous[player][joint])
            expect(step, `種${game.seed}の${Math.round(elapsed)}ミリ秒の${player}番の${joint}`).toBeLessThan(MAX_FRAME_STEP)
            if (step > FAST_FRAME_STEP) fastSteps += 1
          }
        }
        previous = current
      }
    }
    expect(fastSteps).toBeLessThanOrEqual(MAX_FAST_STEPS)
  }, SLOW_TEST_TIMEOUT_MS)
})

describe('仰向けに裏返る', () => {
  /** 左肩から右肩への線と、腰から首への背骨の外積の高さの成分。うつ伏せでは負（背中が上）、仰向けでは正（腹が上） */
  const bellyUpOf = (pose: Pose): number => {
    const across = sub(pose.shoulderR, pose.shoulderL)
    const spine = sub(pose.neck, pose.pelvis)
    return spine.z * across.x - spine.x * across.z
  }
  /** 対戦の裏返る指示と、その番号 */
  const flipsOf = (game: Game) => game.plan.moves.flatMap((move, index) => (move.flip ? [{ move, index }] : []))

  it('試す対戦のなかに、裏返る対戦がある', () => {
    expect(games.filter((game) => flipsOf(game).length > 0).length).toBeGreaterThan(0)
  })

  it('裏返る指示の前はうつ伏せで、手を運び終えてから倒れはじめるまでは仰向けのまま', () => {
    for (const game of games) {
      for (const { move, index } of flipsOf(game)) {
        const before = gameSceneAt(game, spinStartOf(index)).poses[move.player]
        expect(bellyUpOf(before), `種${game.seed}の${index + 1}回目の前`).toBeLessThan(0)
        for (let elapsed = spinStartOf(index + 1); elapsed < game.collapseStartMs; elapsed += SAMPLE_MS) {
          const pose = gameSceneAt(game, elapsed).poses[move.player]
          expect(bellyUpOf(pose), `種${game.seed}の${elapsed}ミリ秒`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('仰向けの人が最後の指示で倒れ込んでも、先にマットに着いた人が決まる', () => {
    // 最後の指示を受ける人が仰向けになっている対戦を、作ってある対戦（種1〜SEED_COUNT）から選ぶ。
    // 対戦を作り直さないので、物理の計算は走らない
    const supineFinalGames = games.filter((game) => supineAfter(game.plan.moves, game.plan.finalMove.player)).slice(0, 3)
    expect(supineFinalGames.length).toBeGreaterThan(0)
    for (const game of supineFinalGames) {
      expect(LOSING_JOINTS, `種${game.seed}`).toContain(game.touchdown.joint)
      expect(game.touchdown.atMs, `種${game.seed}`).toBeGreaterThan(0)
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
      expect(spin.spin).toMatchObject({ move, index, final: false, turnMs: paceOf(index).turnMs, spinMs: paceOf(index).spinMs })
      expect(gameSceneAt(game, spinAt + paceOf(index).spinMs).phase).toBe('move')
    })
  })

  it('運んだ手足は、次の指示のスピナーの針が止まるまでに、指された円に乗っている', () => {
    // 運ぶ途中で相手の体に押し返されると少し遅れるので、運び終えた時刻ではなく、次の指示を読む時刻までに乗ればよい
    game.plan.moves.forEach((move, index) => {
      const landedAt = spinStartOf(index + 1) + paceOf(index + 1).turnMs
      const pose = gameSceneAt(game, landedAt).poses[move.player]
      expect(distance(pose[move.limb], restingOn(move.spot, move.limb))).toBeLessThan(0.02)
    })
  })

  it('最後の指示のあと、手を伸ばして倒れ込み、勝者を出して終わる', () => {
    const finalSpin = gameSceneAt(game, finalSpinAt)
    expect(finalSpin.phase).toBe('spin')
    expect(finalSpin.spin).toMatchObject({ move: game.plan.finalMove, final: true, turnMs: FAST_PACE.turnMs, spinMs: FAST_PACE.spinMs })
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
