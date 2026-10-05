/**
 * 市町村紹介で音を鳴らす時刻の表（sound-cues.ts）のテスト
 *
 * 表は「再生を始めた時刻」「紹介が届いた時刻」と音の設定だけから決まる。場面の進み方（timeline.ts）と同じ秒数から作るので、
 * ここでは場面の切り替わりと同じ時刻に音が並ぶことを確かめる。
 * - BGM: 始めた瞬間からループで流し、終わりの薄くなる間に下げて止める
 * - 始まり: 日本全体を映した瞬間 / ズーム: 寄り始めたとき / 着地: ズームを終えたとき
 * - 項目ごと: 大見出しと各項目が出るたび（大見出しが空なら大見出しでは鳴らさない）
 * - 締め: 配信者への振りが出たとき
 */
import { describe, expect, it } from 'vitest'
import type { TownTourPlaybackSound } from './sound'
import { dueSoundCues, soundCuesOf } from './sound-cues'
import { CREDIT_HOLD_MS, CUE_MS, HOOK_MS, POINT_MS, PUNCHLINE_MS, ZOOM_END_MS, type Playback } from './timeline'
import type { TownTourCall, TownTourIntro } from './tour'

const STARTED_AT = 1_000_000

/** 6つの枠すべてに音声を選んだ設定 */
const fullSound: TownTourPlaybackSound = {
  slots: {
    bgm: 'https://example.com/ピアノ25.mp3',
    opening: 'https://example.com/ジャジャーン.mp3',
    zoom: 'https://example.com/ヒューン.mp3',
    landing: 'https://example.com/ペタッ.mp3',
    item: 'https://example.com/パッ.mp3',
    closing: 'https://example.com/チャンチャン.mp3',
  },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

const callWith = (sound: TownTourPlaybackSound): TownTourCall => ({
  code: '01303',
  prefecture: '北海道',
  county: '石狩郡',
  name: '当別町',
  headline: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
  sound,
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

/** 再生を始めてから readyAfterMs ミリ秒後に紹介が届いた再生 */
const readyPlayback = (readyAfterMs: number, sound: TownTourPlaybackSound = fullSound): Playback => ({
  call: callWith(sound),
  startedAt: STARTED_AT,
  intro: { status: 'ready', intro: tobetsuIntro, readyAt: STARTED_AT + readyAfterMs },
})

const loadingPlayback: Playback = { call: callWith(fullSound), startedAt: STARTED_AT, intro: { status: 'loading' } }

describe('soundCuesOf', () => {
  it('紹介が届く前は、BGM と始まり・ズーム・着地だけを並べる（項目と締めの時刻はまだ決まらない）', () => {
    expect(soundCuesOf(loadingPlayback)).toEqual([
      { id: 'bgm', at: 0, type: 'bgmStart', url: 'https://example.com/ピアノ25.mp3', volume: 0.3 },
      { id: 'opening', at: 0, type: 'effect', url: 'https://example.com/ジャジャーン.mp3', volume: 0.6 },
      { id: 'zoom', at: 1500, type: 'effect', url: 'https://example.com/ヒューン.mp3', volume: 0.6 },
      { id: 'landing', at: ZOOM_END_MS, type: 'effect', url: 'https://example.com/ペタッ.mp3', volume: 0.6 },
    ])
  })

  it('紹介が届いたら、大見出しと項目の数だけ項目ごとの音を並べ、振りで締めの音を鳴らし、BGM の下げ止めを加える', () => {
    const itemsStart = ZOOM_END_MS
    const cueStart = itemsStart + HOOK_MS + POINT_MS + PUNCHLINE_MS
    const end = cueStart + CUE_MS + CREDIT_HOLD_MS

    expect(soundCuesOf(readyPlayback(2000))).toEqual([
      { id: 'bgm', at: 0, type: 'bgmStart', url: 'https://example.com/ピアノ25.mp3', volume: 0.3 },
      { id: 'opening', at: 0, type: 'effect', url: 'https://example.com/ジャジャーン.mp3', volume: 0.6 },
      { id: 'zoom', at: 1500, type: 'effect', url: 'https://example.com/ヒューン.mp3', volume: 0.6 },
      { id: 'landing', at: ZOOM_END_MS, type: 'effect', url: 'https://example.com/ペタッ.mp3', volume: 0.6 },
      { id: 'item-0', at: itemsStart, type: 'effect', url: 'https://example.com/パッ.mp3', volume: 0.6 },
      { id: 'item-1', at: itemsStart + HOOK_MS, type: 'effect', url: 'https://example.com/パッ.mp3', volume: 0.6 },
      { id: 'item-2', at: itemsStart + HOOK_MS + POINT_MS, type: 'effect', url: 'https://example.com/パッ.mp3', volume: 0.6 },
      { id: 'closing', at: cueStart, type: 'effect', url: 'https://example.com/チャンチャン.mp3', volume: 0.6 },
      { id: 'bgm-end', at: end - 600, type: 'bgmFadeOut', duration: 600 },
    ])
  })

  it('紹介が遅れて届いたら、項目ごとの音と締めは届いた時刻から数える（場面と同じ時刻にする）', () => {
    const readyAfterMs = ZOOM_END_MS + 3000

    expect(soundCuesOf(readyPlayback(readyAfterMs)).find((cue) => cue.id === 'item-0')?.at).toBe(readyAfterMs)
    expect(soundCuesOf(readyPlayback(readyAfterMs)).find((cue) => cue.id === 'closing')?.at).toBe(readyAfterMs + HOOK_MS + POINT_MS + PUNCHLINE_MS)
  })

  it('大見出しが空なら、項目の数だけ項目ごとの音を並べる', () => {
    const noHook: Playback = {
      call: callWith(fullSound),
      startedAt: STARTED_AT,
      intro: { status: 'ready', intro: { ...tobetsuIntro, tour: { ...tobetsuIntro.tour, hook: '' } }, readyAt: STARTED_AT },
    }

    expect(soundCuesOf(noHook).filter((cue) => cue.id.startsWith('item-')).map((cue) => cue.at)).toEqual([ZOOM_END_MS, ZOOM_END_MS + POINT_MS])
  })

  it('「鳴らさない」にした枠は並べない（BGM を鳴らさなければ下げ止めも並べない）', () => {
    const quiet: TownTourPlaybackSound = {
      ...fullSound,
      slots: { ...fullSound.slots, bgm: null, zoom: null, item: null },
    }

    expect(soundCuesOf(readyPlayback(0, quiet)).map((cue) => cue.id)).toEqual(['opening', 'landing', 'closing'])
  })

  it('紹介を作れなかった再生では、何も並べない（鳴っている BGM は再生の終わりに止める）', () => {
    const failed: Playback = { call: callWith(fullSound), startedAt: STARTED_AT, intro: { status: 'failed' } }

    expect(soundCuesOf(failed)).toEqual([])
  })
})

describe('dueSoundCues', () => {
  it('時刻を迎えた音のうち、まだ鳴らしていないものだけを返す', () => {
    const played = new Set(['bgm', 'opening'])

    expect(dueSoundCues(loadingPlayback, STARTED_AT + 1500, played).map((cue) => cue.id)).toEqual(['zoom'])
  })

  it('時刻をまだ迎えていない音は返さない', () => {
    expect(dueSoundCues(loadingPlayback, STARTED_AT + 1499, new Set(['bgm', 'opening']))).toEqual([])
  })

  it('始めた瞬間には、BGM と始まりの音を返す', () => {
    expect(dueSoundCues(loadingPlayback, STARTED_AT, new Set()).map((cue) => cue.id)).toEqual(['bgm', 'opening'])
  })

  it('タイマーが遅れて、効果音の時刻を大きく過ぎていたら、その効果音は鳴らさない（場面とずれた音をまとめて鳴らさない）', () => {
    // 前提: 始めてから3秒間、確かめられなかった。始まり（0秒）とズーム（1.5秒）の時刻は過ぎている
    const due = dueSoundCues(loadingPlayback, STARTED_AT + 3000, new Set())

    // BGM は流れ続けるものなので、遅れても鳴らしはじめる
    expect(due.map((cue) => cue.id)).toEqual(['bgm'])
  })

  it('効果音の時刻を少しだけ過ぎていたら、鳴らす', () => {
    expect(dueSoundCues(loadingPlayback, STARTED_AT + 1500 + 200, new Set(['bgm', 'opening'])).map((cue) => cue.id)).toEqual(['zoom'])
  })

  it('BGM を下げる時刻を過ぎていたら、BGM を鳴らしはじめず、下げる指示だけを返す', () => {
    // 前提: 大見出しと項目2つの紹介で、終わる直前までまったく確かめられなかった
    const end = ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS + CREDIT_HOLD_MS
    const due = dueSoundCues(readyPlayback(0), STARTED_AT + end - 100, new Set())

    expect(due.map((cue) => cue.id)).toEqual(['bgm-end'])
  })
})
