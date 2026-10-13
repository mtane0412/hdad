/**
 * デモ用のサンプル（?demo=true）
 *
 * マスコットの反応はトリガーか、トリガー画面の試し再生で呼び出されたときだけ流れるので、それ以外のあいだは待機の動きしか映らない。
 * それでは反応の見栄えを決められないため、管理画面のプレビューでは Worker の押し出しにつながず、
 * 決まった種で4種類の反応を順にくり返し流す（ペロペロの src/lick/demo.ts と同じ考え方）。
 */
import type { VrmReactionKind } from './call'

/** プレビューで流す反応（種と反応の種類）。お礼・大喜び・手を振る・うなずくを、振る手が左右に分かれる種で順に流す */
export const DEMO_VRM_CALLS: readonly { readonly seed: number; readonly reaction: VrmReactionKind }[] = [
  { seed: 20261013, reaction: 'thanks' },
  { seed: 358, reaction: 'cheer' },
  { seed: 358, reaction: 'wave' },
  { seed: 359, reaction: 'nod' },
]

/** プレビューで次の反応を流す間隔（ミリ秒）。いちばん長いお礼（4〜5秒）のあとに、待機の動きを見られるだけの間を置く */
export const DEMO_VRM_INTERVAL_MS = 7_000
