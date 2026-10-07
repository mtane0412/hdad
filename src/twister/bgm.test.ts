/**
 * ツイスターの BGM の流し方（bgm.ts）のテスト
 *
 * 対戦のあいだ流す BGM は、対戦を流しはじめたときに鳴らしはじめ、対戦の終わりに向けて音量を0まで下げて止める。
 * そのあいだ配信の BGM を下げておき（裏方のページが自分で戻す）、戻すのは対戦の BGM を止め終えたときにする。
 * BGM を選んでいなければ、鳴らさず配信の BGM も下げない。
 */
import { describe, expect, it } from 'vitest'
import { BGM_FADE_OUT_MS, twisterBgmPlanOf } from './bgm'

/** 対戦の曲を選んだ設定（Worker が音声のURLに置き換えたもの） */
const sound = { bgm: '/api/media/media-taisen?key=issued-overlay-key', bgmVolume: 0.3 }
/** 対戦の長さの例（ミリ秒） */
const totalMs = 28_000

describe('twisterBgmPlanOf', () => {
  it('BGM を選んでいなければ、何も鳴らさない', () => {
    expect(twisterBgmPlanOf({ bgm: null, bgmVolume: 0.3 }, totalMs)).toBeNull()
  })

  it('選んだ BGM を設定の音量で鳴らし、対戦の終わりに音量を下げ終えるよう、終わりの少し前から下げはじめる', () => {
    expect(twisterBgmPlanOf(sound, totalMs)).toEqual({
      url: sound.bgm,
      volume: 0.3,
      fadeOutAtMs: totalMs - BGM_FADE_OUT_MS,
      fadeOutMs: BGM_FADE_OUT_MS,
      duckHoldMs: totalMs,
    })
  })

  it('配信の BGM を下げておく長さは整数のミリ秒に切り上げる（Worker は整数しか受け付けず、切り捨てると一瞬早く戻ってしまう）', () => {
    expect(twisterBgmPlanOf(sound, 28_000.4)?.duckHoldMs).toBe(28_001)
  })

  it('対戦が下げる時間より短くても、下げはじめる時刻を負にしない', () => {
    const plan = twisterBgmPlanOf(sound, BGM_FADE_OUT_MS / 2)
    expect(plan?.fadeOutAtMs).toBe(0)
    expect(plan?.fadeOutMs).toBe(BGM_FADE_OUT_MS / 2)
  })
})
