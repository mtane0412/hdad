/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんのツイスターはレイドか、トリガー画面の試し再生で呼び出されたときだけ流れるので、それ以外のあいだは何も映らない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、決まった呼び出しを順にくり返し流す
 * （市町村紹介の src/town-tour/demo.ts と同じ考え方）。
 *
 * プレビューは Twitch につながないので、2人ともアイコンを持たない（名前の頭文字の顔になる）。
 * 配信者の音声も読めない（オーバーレイ用キーを持たない）ので、BGM も流さない。
 */
import type { TwisterCall } from './call'

/** プレビューで流す呼び出し。種を変えて、絡み方と勝敗の違いが分かるようにする */
export const DEMO_TWISTER_CALLS: readonly TwisterCall[] = [20261006, 272, 8128].map((seed) => ({
  id: `demo-${seed}`,
  seed,
  players: [
    { name: '視聴者', iconUrl: null },
    { name: '配信者', iconUrl: null },
  ],
  sound: { bgm: null, bgmVolume: 0 },
}))

/** プレビューで次の呼び出しを流す間隔（ミリ秒）。1回の対戦（30秒前後）を流しきるだけの間を置く */
export const DEMO_TWISTER_INTERVAL_MS = 34_000
