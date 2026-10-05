/**
 * 配信のBGMを下げておく長さ（bgm-duck.ts）のテスト
 *
 * 合成ページは市町村紹介のBGMを鳴らしはじめたとき・紹介が届いたとき・紹介を作れなかったときに、
 * 「いまから何ミリ秒、配信のBGMを下げておくか」を裏方のページへ送る（issue #245）。ここではその長さが
 * 再生の状態と現在時刻だけから決まることを確かめる。
 * - 紹介を待っているあいだは、終わりがまだ決まらないので、決まった長さだけ下げる（届いたら送り直す）
 * - 紹介が届いたら、再生の終わりまで下げる
 * - 紹介を作れなかったら、すぐ戻す
 * - 紹介のBGMの枠が空なら、下げない
 */
import { describe, expect, it } from 'vitest'
import { LOADING_DUCK_HOLD_MS, bgmDuckHoldOf } from './bgm-duck'
import type { TownTourPlaybackSound } from './sound'
import { CREDIT_HOLD_MS, CUE_MS, HOOK_MS, POINT_MS, PUNCHLINE_MS, ZOOM_END_MS, type Playback } from './timeline'
import type { TownTourCall, TownTourIntro } from './tour'

const STARTED_AT = 1_000_000

/** BGMの枠にだけ音声を選んだ設定 */
const bgmOnly: TownTourPlaybackSound = {
  slots: { bgm: 'https://example.com/ピアノ25.mp3', opening: null, zoom: null, landing: null, item: null, closing: null },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

/** どの枠も「鳴らさない」にした設定 */
const silent: TownTourPlaybackSound = { ...bgmOnly, slots: { ...bgmOnly.slots, bgm: null } }

const callWith = (sound: TownTourPlaybackSound): TownTourCall => ({
  code: '01303',
  prefecture: '北海道',
  county: '石狩郡',
  name: '当別町',
  headline: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
  sound,
  population: 14974,
  area: 422.86,
  audience: { kind: 'raid', count: 50 },
})

/** 大見出しと項目2つの紹介 */
const tobetsuIntro: TownTourIntro = {
  article: { title: '当別町', url: 'https://ja.wikipedia.org/wiki/%E5%BD%93%E5%88%A5%E7%94%BA' },
  tour: {
    hook: '北欧の街並みがある米どころ',
    points: [
      { label: 'どこにある？', text: '石狩平野の北東部にある町です。' },
      { label: '名物', text: '当別米が名物です。' },
    ],
    cue: '当別米、食べたことありますか？',
  },
}

/** 紹介を待っている再生 */
const loadingPlayback = (sound: TownTourPlaybackSound = bgmOnly): Playback => ({ call: callWith(sound), startedAt: STARTED_AT, intro: { status: 'loading' } })

/** 始めてから2秒後に紹介が届いた再生。ズームを終えてから大見出し・項目2つ・振りを流し、出典を残して終わる */
const readyPlayback: Playback = {
  call: callWith(bgmOnly),
  startedAt: STARTED_AT,
  intro: { status: 'ready', intro: tobetsuIntro, readyAt: STARTED_AT + 2000 },
}
const READY_END = STARTED_AT + ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS + CREDIT_HOLD_MS

describe('bgmDuckHoldOf', () => {
  it('紹介を待っているあいだは、決まった長さだけ下げる（終わりがまだ決まらないため）', () => {
    expect(bgmDuckHoldOf(loadingPlayback(), STARTED_AT)).toBe(LOADING_DUCK_HOLD_MS)
  })

  it('紹介が届いたら、再生の終わりまで下げる', () => {
    expect(bgmDuckHoldOf(readyPlayback, STARTED_AT + 2000)).toBe(READY_END - (STARTED_AT + 2000))
  })

  it('再生の終わりを過ぎていたら、すぐ戻す（0）', () => {
    expect(bgmDuckHoldOf(readyPlayback, READY_END + 1000)).toBe(0)
  })

  it('紹介を作れなかったら、すぐ戻す（0）', () => {
    expect(bgmDuckHoldOf({ ...readyPlayback, intro: { status: 'failed' } }, STARTED_AT + 3000)).toBe(0)
  })

  it('紹介のBGMの枠が空なら、下げない（null）', () => {
    expect(bgmDuckHoldOf(loadingPlayback(silent), STARTED_AT)).toBeNull()
  })
})
