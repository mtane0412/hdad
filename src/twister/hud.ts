/**
 * ツイスターの画面に重ねる文言
 *
 * 文言は場面（game.ts の GameScene）と呼び出しの2人の名前だけから決まる。どこにどう描くかは view.ts が受け持つ。
 */
import { JOINT_LABELS, LIMB_LABELS } from './body'
import type { TwisterCall } from './call'
import type { GameScene } from './game'
import { COLOR_LABELS } from './mat'
import { SPIN_TURN_MS } from './spinner'

/** 場面ごとの文言。出さないものは null */
export interface HudText {
  /** 登場の場面の、対戦の見出し */
  readonly title: string | null
  /** スピナーの場面の、だれの番か */
  readonly turn: string | null
  /** 針が止まった後の、手足と色の指示 */
  readonly instruction: string | null
  /** 倒れ込み・結果の場面の大見出し */
  readonly headline: string | null
  /** 結果の場面の、負けた人のどこがマットに着いたか */
  readonly detail: string | null
}

/** 倒れ込みの場面の叫び */
const COLLAPSE_HEADLINE = 'うわああ！'

const EMPTY: HudText = { title: null, turn: null, instruction: null, headline: null, detail: null }

/** 場面と呼び出しから、画面に重ねる文言を決める */
export const hudTextOf = (scene: GameScene, call: TwisterCall): HudText => {
  const nameOf = (player: 0 | 1): string => call.players[player].name
  if (scene.phase === 'intro') return { ...EMPTY, title: `${nameOf(0)} vs ${nameOf(1)}` }
  if (scene.phase === 'collapse') return { ...EMPTY, headline: COLLAPSE_HEADLINE }
  if (scene.result !== null) {
    const { loser, winner, joint } = scene.result
    return { ...EMPTY, headline: `${nameOf(winner)}の勝ち！`, detail: `${nameOf(loser)}の${JOINT_LABELS[joint]}がマットに着きました` }
  }
  if (scene.spin === null) return EMPTY
  const { move, final, elapsedMs } = scene.spin
  return {
    ...EMPTY,
    turn: `${nameOf(move.player)}の番${final ? '（最後の指示）' : ''}`,
    instruction: elapsedMs >= SPIN_TURN_MS ? `${LIMB_LABELS[move.limb]}を${COLOR_LABELS[move.spot.color]}へ` : null,
  }
}
