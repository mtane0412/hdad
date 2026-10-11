/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんのペロペロはトリガーか、トリガー画面の試し再生で呼び出されたときだけ流れるので、それ以外のあいだは何も映らない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、決まった呼び出しを順にくり返し流す
 * （ツイスターの src/twister/demo.ts と同じ考え方）。プレビューは Twitch につながないので、アイコンを持たない（名前の頭文字の顔になる）。
 * 配信者の音声も読めない（オーバーレイ用キーを持たない）ので、効果音も鳴らさない。
 */
import type { LickCall } from './call'

/** プレビューで流す呼び出し。種を変えて、舐め方の違いが分かるようにする */
export const DEMO_LICK_CALLS: readonly LickCall[] = [20261011, 338].map((seed) => ({
  id: `demo-${seed}`,
  seed,
  target: { name: '視聴者', iconUrl: null },
  sound: { sound: null, volume: 0 },
}))

/** プレビューで次の呼び出しを流す間隔（ミリ秒）。1回のペロペロ（15秒前後）を流しきるだけの間を置く */
export const DEMO_LICK_INTERVAL_MS = 17_000
