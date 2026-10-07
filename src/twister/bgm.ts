/**
 * ツイスターの BGM の流し方
 *
 * 押し出された BGM の設定（call.ts の sound）と対戦の長さ（game.ts の totalMs）から、
 * 何をどの音量で鳴らし、いつから下げて止めるか、配信の BGM をどれだけ下げておくかを決める。
 * 鳴らすのは合成ページ（src/overlay/stage.ts の mountTwister と bgm-player.ts）で、ここは通信も DOM も持たない。
 *
 * 配信の BGM は、合成ページが「受け取ってから下げておく長さ」を Worker 経由で裏方のページへ送り、裏方が自分で戻す
 * （市町村紹介と同じ仕組み。src/town-tour/bgm-duck.ts）。合成ページが閉じられても下がったまま残らない。
 */
import type { TwisterSound } from './sound'

/** 対戦の終わりに向けて BGM の音量を0まで下げる長さ（ミリ秒）。勝者を出しているうちに静かに消えるようにする */
export const BGM_FADE_OUT_MS = 2_000

/** 1回の対戦で BGM をどう流すか */
export interface TwisterBgmPlan {
  /** 鳴らす音声のURL */
  readonly url: string
  /** 鳴らす音量（0〜1） */
  readonly volume: number
  /** 再生を始めてから、音量を下げはじめるまでの長さ（ミリ秒） */
  readonly fadeOutAtMs: number
  /** 音量を0まで下げる長さ（ミリ秒） */
  readonly fadeOutMs: number
  /** 配信の BGM を下げておく長さ（整数のミリ秒）。対戦の BGM を止め終えるまで */
  readonly duckHoldMs: number
}

/**
 * 1回の対戦で BGM をどう流すかを決める。
 *
 * @param totalMs 対戦の長さ（ミリ秒）
 * @returns BGM を選んでいなければ null（鳴らさず、配信の BGM も下げない）
 */
export const twisterBgmPlanOf = (sound: TwisterSound, totalMs: number): TwisterBgmPlan | null => {
  if (sound.bgm === null) return null
  const fadeOutMs = Math.min(BGM_FADE_OUT_MS, totalMs)
  return {
    url: sound.bgm,
    volume: sound.bgmVolume,
    fadeOutAtMs: totalMs - fadeOutMs,
    fadeOutMs,
    // Worker は整数しか受け付けない。切り捨てると対戦の BGM が消える前に配信の BGM が戻るので切り上げる
    duckHoldMs: Math.ceil(totalMs),
  }
}
