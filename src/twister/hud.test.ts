/**
 * ツイスターの画面に重ねる文言（hud.ts）のテスト
 *
 * 文言は場面（game.ts の GameScene）と呼び出しの2人の名前だけから決まる。
 * - 登場: 「レイドした人 vs 配信者」
 * - スピナー: だれの番か。針が止まったら「右手を赤へ」の形で指示を出す。最後の指示は「最後の指示」と分かるようにする
 * - 倒れ込み: 叫び
 * - 結果: 勝者と、負けた人のどこがマットに着いたか
 */
import { describe, expect, it } from 'vitest'
import type { TwisterCall } from './call'
import type { GameScene } from './game'
import { hudTextOf } from './hud'
import { SPIN_TURN_MS } from './spinner'
import { INITIAL_SPOTS, PLAYER_FACINGS } from './players'
import { contactsOf, solvePose } from './pose'

const call: TwisterCall = {
  id: 'hud-test',
  seed: 1,
  players: [
    { name: 'こわい話の人', iconUrl: null },
    { name: '配信者さん', iconUrl: null },
  ],
}

/** 文言の決め方では姿勢を見ないので、どの場面でも始めの姿勢を置いておく */
const poses = [solvePose(contactsOf(INITIAL_SPOTS[0]), PLAYER_FACINGS[0]), solvePose(contactsOf(INITIAL_SPOTS[1]), PLAYER_FACINGS[1])] as const

const sceneOf = (overrides: Partial<GameScene>): GameScene => ({ phase: 'intro', poses, spin: null, result: null, done: false, ...overrides })

describe('hudTextOf', () => {
  it('登場の場面では、2人の名前を対戦の形で出す', () => {
    expect(hudTextOf(sceneOf({ phase: 'intro' }), call).title).toBe('こわい話の人 vs 配信者さん')
  })

  it('スピナーが回っているあいだは、だれの番かだけを出す', () => {
    const text = hudTextOf(
      sceneOf({ phase: 'spin', spin: { move: { player: 1, limb: 'handR', spot: { color: 'red', row: 2 } }, index: 1, final: false, elapsedMs: 100 } }),
      call,
    )
    expect(text.turn).toBe('配信者さんの番')
    expect(text.instruction).toBeNull()
  })

  it('針が止まったら、手足と色の指示を出す', () => {
    const text = hudTextOf(
      sceneOf({ phase: 'spin', spin: { move: { player: 0, limb: 'footL', spot: { color: 'blue', row: 4 } }, index: 0, final: false, elapsedMs: SPIN_TURN_MS } }),
      call,
    )
    expect(text.instruction).toBe('左足を青へ')
  })

  it('最後の指示は、最後と分かるように番を出す', () => {
    const text = hudTextOf(
      sceneOf({ phase: 'reach', spin: { move: { player: 0, limb: 'handL', spot: { color: 'green', row: 5 } }, index: 2, final: true, elapsedMs: 3000 } }),
      call,
    )
    expect(text.turn).toBe('こわい話の人の番（最後の指示）')
    expect(text.instruction).toBe('左手を緑へ')
  })

  it('結果の場面では、勝者と、負けた人のマットに着いた部位を出す', () => {
    const text = hudTextOf(sceneOf({ phase: 'result', result: { loser: 0, winner: 1, joint: 'kneeR' } }), call)
    expect(text.headline).toBe('配信者さんの勝ち！')
    expect(text.detail).toBe('こわい話の人のひざがマットに着きました')
  })
})
