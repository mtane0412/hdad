/**
 * 市町村紹介で音を鳴らす時刻の表（sound-cues.ts）のテスト
 *
 * 表は「再生を始めた時刻」「紹介が届いた時刻」と音の設定だけから決まる。場面の進み方（timeline.ts）と同じ秒数から作るので、
 * ここでは場面の切り替わりと同じ時刻に音が並ぶことを確かめる。
 * - BGM: 始めた瞬間からループで流し、終わりの薄くなる間に下げて止める
 * - 始まり: クイズを終えて日本全体を映した瞬間 / ズーム: 寄り始めたとき / 着地: ズームを終えたとき（どれもクイズを終えた時刻から数える。issue #251）
 * - 項目ごと: 大見出しと各項目が出るたび（大見出しが空なら大見出しでは鳴らさない）
 * - 締め: 配信者への振りが出たとき
 * - ナレーション（issue #255）: 冒頭の一文は着地で、大見出し・項目・振りはそれぞれの出だしで読み上げ、読んでいるあいだ BGM を下げる
 */
import { describe, expect, it } from 'vitest'
import { NARRATION_BGM_RATIO, NARRATION_TAIL_MS, type Narration } from './narration'
import type { TownTourPlaybackSound } from './sound'
import { dueSoundCues, soundCuesOf } from './sound-cues'
import { QUIZ_MS } from './quiz'
import { CERTIFICATE_MS, CONQUEST_MS, CUE_MS, HOOK_MS, JAPAN_HOLD_MS, POINT_MS, PUNCHLINE_MS, ZOOM_END_MS, type Playback } from './timeline'
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
  quizId: 'quiz-tobetsu',
  quizHeadline: '山田花子さんのレイドを記念して、本日は当別町をご紹介します',
  sound,
  population: 14974,
  area: 422.86,
  audience: { kind: 'raid', count: 50 },
  visited: [],
  visit: { occasion: 'raid', userName: '山田花子' },
  // レイドなので、締めに認定証を出す（issue #253）
  honoraryCitizen: '山田花子',
  raider: { login: 'yamada_hanako', viewers: 30 },
  narration: false,
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
  image: null,
  bond: null,
  bondFailure: null,
}

/** 誰も正解しなかったクイズ */
const unansweredQuiz: Playback['quiz'] = { hints: [], answer: null, unopenedAt: null }

/** 当別町で1つめを数えた制覇マップ（音の時刻と下げる長さは、制覇数に左右されない） */
const firstConquest: Playback['conquest'] = { before: 0, after: 1, total: 1747, visited: new Set(), milestones: [] }

/** 正解者が出なかった再生では、クイズの長さいっぱいで日本地図へ移る */
const MAP_START = QUIZ_MS

/** 再生を始めてから readyAfterMs ミリ秒後に紹介が届いた再生（誰も正解しなかった） */
const readyPlayback = (readyAfterMs: number, sound: TownTourPlaybackSound = fullSound): Playback => ({
  call: callWith(sound),
  startedAt: STARTED_AT,
  intro: { status: 'ready', intro: tobetsuIntro, readyAt: STARTED_AT + readyAfterMs, narration: null },
  quiz: unansweredQuiz,
  conquest: firstConquest,
})

const loadingPlayback: Playback = { call: callWith(fullSound), startedAt: STARTED_AT, intro: { status: 'loading' }, quiz: unansweredQuiz, conquest: firstConquest }

describe('soundCuesOf', () => {
  it('紹介が届く前は、BGM と始まり・ズーム・着地だけを並べる（項目と締めの時刻はまだ決まらない）', () => {
    expect(soundCuesOf(loadingPlayback)).toEqual([
      { id: 'bgm', at: 0, type: 'bgmStart', url: 'https://example.com/ピアノ25.mp3', volume: 0.3 },
      { id: 'opening', at: MAP_START, type: 'effect', url: 'https://example.com/ジャジャーン.mp3', volume: 0.6 },
      { id: 'zoom', at: MAP_START + JAPAN_HOLD_MS, type: 'effect', url: 'https://example.com/ヒューン.mp3', volume: 0.6 },
      { id: 'landing', at: MAP_START + ZOOM_END_MS, type: 'effect', url: 'https://example.com/ペタッ.mp3', volume: 0.6 },
    ])
  })

  it('紹介が届いたら、大見出しと項目の数だけ項目ごとの音を並べ、振りで締めの音を鳴らし、BGM の下げ止めを加える', () => {
    const itemsStart = MAP_START + ZOOM_END_MS
    const cueStart = itemsStart + HOOK_MS + POINT_MS + PUNCHLINE_MS
    const end = cueStart + CUE_MS + CONQUEST_MS + CERTIFICATE_MS

    expect(soundCuesOf(readyPlayback(2000))).toEqual([
      { id: 'bgm', at: 0, type: 'bgmStart', url: 'https://example.com/ピアノ25.mp3', volume: 0.3 },
      { id: 'opening', at: MAP_START, type: 'effect', url: 'https://example.com/ジャジャーン.mp3', volume: 0.6 },
      { id: 'zoom', at: MAP_START + JAPAN_HOLD_MS, type: 'effect', url: 'https://example.com/ヒューン.mp3', volume: 0.6 },
      { id: 'landing', at: MAP_START + ZOOM_END_MS, type: 'effect', url: 'https://example.com/ペタッ.mp3', volume: 0.6 },
      { id: 'item-0', at: itemsStart, type: 'effect', url: 'https://example.com/パッ.mp3', volume: 0.6 },
      { id: 'item-1', at: itemsStart + HOOK_MS, type: 'effect', url: 'https://example.com/パッ.mp3', volume: 0.6 },
      { id: 'item-2', at: itemsStart + HOOK_MS + POINT_MS, type: 'effect', url: 'https://example.com/パッ.mp3', volume: 0.6 },
      { id: 'closing', at: cueStart, type: 'effect', url: 'https://example.com/チャンチャン.mp3', volume: 0.6 },
      { id: 'bgm-end', at: end - 600, type: 'bgmFadeOut', duration: 600 },
    ])
  })

  it('振りの代わりに共通点を出す紹介では、共通点の出だしで締めの音を鳴らし、項目ごとの音は鳴らさない（issue #275）', () => {
    const bond = {
      raiderName: '山田花子',
      raiderIcon: 'https://static-cdn.jtvnw.net/yamada.png',
      raiderQuote: '花子',
      townQuote: '当別米',
      text: '花子さんと当別米。どちらも実りを待つ存在なのです。',
      certificateReason: '本町の当別米と同じく実りを待たれた功績につき',
    }
    const playback = readyPlayback(0)
    const withBond: Playback = { ...playback, intro: { status: 'ready', intro: { ...tobetsuIntro, bond }, readyAt: STARTED_AT, narration: null } }
    const cues = soundCuesOf(withBond)

    expect(cues.find((cue) => cue.id === 'closing')?.at).toBe(MAP_START + ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS)
    expect(cues.filter((cue) => cue.id.startsWith('item-'))).toHaveLength(3)
  })

  it('紹介が遅れて届いたら、項目ごとの音と締めは届いた時刻から数える（場面と同じ時刻にする）', () => {
    const readyAfterMs = MAP_START + ZOOM_END_MS + 3000

    expect(soundCuesOf(readyPlayback(readyAfterMs)).find((cue) => cue.id === 'item-0')?.at).toBe(readyAfterMs)
    expect(soundCuesOf(readyPlayback(readyAfterMs)).find((cue) => cue.id === 'closing')?.at).toBe(readyAfterMs + HOOK_MS + POINT_MS + PUNCHLINE_MS)
  })

  it('大見出しが空なら、項目の数だけ項目ごとの音を並べる', () => {
    const noHook: Playback = {
      call: callWith(fullSound),
      startedAt: STARTED_AT,
      intro: { status: 'ready', intro: { ...tobetsuIntro, tour: { ...tobetsuIntro.tour, hook: '' } }, readyAt: STARTED_AT, narration: null },
      quiz: unansweredQuiz,
      conquest: firstConquest,
    }

    expect(soundCuesOf(noHook).filter((cue) => cue.id.startsWith('item-')).map((cue) => cue.at)).toEqual([
      MAP_START + ZOOM_END_MS,
      MAP_START + ZOOM_END_MS + POINT_MS,
    ])
  })

  it('「鳴らさない」にした枠は並べない（BGM を鳴らさなければ下げ止めも並べない）', () => {
    const quiet: TownTourPlaybackSound = {
      ...fullSound,
      slots: { ...fullSound.slots, bgm: null, zoom: null, item: null },
    }

    expect(soundCuesOf(readyPlayback(0, quiet)).map((cue) => cue.id)).toEqual(['opening', 'landing', 'closing'])
  })

  it('チャットで正解が早く出たら、始まり・ズーム・着地の音を、正解が届いた時刻から数える', () => {
    const answered: Playback = { ...loadingPlayback, quiz: { hints: [], answer: { userName: 'たなか', answeredAt: STARTED_AT + 5000 }, unopenedAt: null } }

    expect(soundCuesOf(answered).map((cue) => [cue.id, cue.at])).toEqual([
      ['bgm', 0],
      ['opening', 5000],
      ['zoom', 5000 + JAPAN_HOLD_MS],
      ['landing', 5000 + ZOOM_END_MS],
    ])
  })

  it('紹介を作れなかった再生では、何も並べない（鳴っている BGM は再生の終わりに止める）', () => {
    const failed: Playback = { call: callWith(fullSound), startedAt: STARTED_AT, intro: { status: 'failed' }, quiz: unansweredQuiz, conquest: firstConquest }

    expect(soundCuesOf(failed)).toEqual([])
  })
})

describe('dueSoundCues', () => {
  it('時刻を迎えた音のうち、まだ鳴らしていないものだけを返す', () => {
    const played = new Set(['bgm', 'opening'])

    expect(dueSoundCues(loadingPlayback, STARTED_AT + MAP_START + JAPAN_HOLD_MS, played).map((cue) => cue.id)).toEqual(['zoom'])
  })

  it('時刻をまだ迎えていない音は返さない', () => {
    expect(dueSoundCues(loadingPlayback, STARTED_AT + MAP_START + JAPAN_HOLD_MS - 1, new Set(['bgm', 'opening']))).toEqual([])
  })

  it('始めた瞬間（クイズの出だし）には BGM を返し、クイズを終えた瞬間に始まりの音を返す', () => {
    expect(dueSoundCues(loadingPlayback, STARTED_AT, new Set()).map((cue) => cue.id)).toEqual(['bgm'])
    expect(dueSoundCues(loadingPlayback, STARTED_AT + MAP_START, new Set(['bgm'])).map((cue) => cue.id)).toEqual(['opening'])
  })

  it('タイマーが遅れて、効果音の時刻を大きく過ぎていたら、その効果音は鳴らさない（場面とずれた音をまとめて鳴らさない）', () => {
    // 前提: クイズを終えてから3秒間、確かめられなかった。始まり（クイズを終えた瞬間）とズーム（その1.5秒後）の時刻は過ぎている
    const due = dueSoundCues(loadingPlayback, STARTED_AT + MAP_START + 3000, new Set())

    // BGM は流れ続けるものなので、遅れても鳴らしはじめる
    expect(due.map((cue) => cue.id)).toEqual(['bgm'])
  })

  it('効果音の時刻を少しだけ過ぎていたら、鳴らす', () => {
    expect(dueSoundCues(loadingPlayback, STARTED_AT + MAP_START + JAPAN_HOLD_MS + 200, new Set(['bgm', 'opening'])).map((cue) => cue.id)).toEqual(['zoom'])
  })

  it('BGM を下げる時刻を過ぎていたら、BGM を鳴らしはじめず、下げる指示だけを返す', () => {
    // 前提: 大見出しと項目2つの紹介で、終わる直前までまったく確かめられなかった
    const end = MAP_START + ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS + CONQUEST_MS + CERTIFICATE_MS
    const due = dueSoundCues(readyPlayback(0), STARTED_AT + end - 100, new Set())

    expect(due.map((cue) => cue.id)).toEqual(['bgm-end'])
  })
})

describe('ナレーションの音（issue #255）', () => {
  /** BGM だけを鳴らす設定（読み上げと BGM の下げ戻しだけを見るため） */
  const bgmOnly: TownTourPlaybackSound = { ...fullSound, slots: { ...fullSound.slots, opening: null, zoom: null, landing: null, item: null, closing: null } }
  /** 読み上げた音声（url は合成ページが読み込んだ音声を指す。長さはミリ秒） */
  const clip = (name: string, duration: number) => ({ url: `blob:${name}`, duration })
  /** 紹介が始めた時点で届き、ナレーションを読み込み終えた再生 */
  const narrated = (narration: Narration, sound: TownTourPlaybackSound = bgmOnly): Playback => ({
    ...readyPlayback(0, sound),
    call: { ...callWith(sound), narration: true },
    intro: { status: 'ready', intro: tobetsuIntro, readyAt: STARTED_AT, narration },
  })
  const LANDING = MAP_START + ZOOM_END_MS
  /** 下げているあいだの BGM の音量 */
  const ducked = 0.3 * NARRATION_BGM_RATIO

  it('冒頭の一文を着地で、大見出し・項目・振りをそれぞれの出だしで読み上げ、読んでいるあいだだけ BGM を下げる', () => {
    const playback = narrated({
      opening: clip('冒頭', 4000),
      lines: [clip('大見出し', 3000), clip('項目1', 2000), clip('オチ', 2500), clip('振り', 2000)],
    })
    const itemsStart = LANDING + 4000 + NARRATION_TAIL_MS
    const pointStart = itemsStart + HOOK_MS
    const punchlineStart = pointStart + POINT_MS
    const cueStart = punchlineStart + PUNCHLINE_MS

    expect(soundCuesOf(playback).filter((cue) => cue.id !== 'bgm' && cue.id !== 'bgm-end')).toEqual([
      { id: 'narration-opening', at: LANDING, type: 'narration', url: 'blob:冒頭' },
      { id: 'narration-opening-duck', at: LANDING, type: 'bgmVolume', volume: ducked },
      { id: 'narration-opening-restore', at: LANDING + 4000, type: 'bgmVolume', volume: 0.3 },
      { id: 'narration-0', at: itemsStart, type: 'narration', url: 'blob:大見出し' },
      { id: 'narration-0-duck', at: itemsStart, type: 'bgmVolume', volume: ducked },
      { id: 'narration-0-restore', at: itemsStart + 3000, type: 'bgmVolume', volume: 0.3 },
      { id: 'narration-1', at: pointStart, type: 'narration', url: 'blob:項目1' },
      { id: 'narration-1-duck', at: pointStart, type: 'bgmVolume', volume: ducked },
      { id: 'narration-1-restore', at: pointStart + 2000, type: 'bgmVolume', volume: 0.3 },
      { id: 'narration-2', at: punchlineStart, type: 'narration', url: 'blob:オチ' },
      { id: 'narration-2-duck', at: punchlineStart, type: 'bgmVolume', volume: ducked },
      { id: 'narration-2-restore', at: punchlineStart + 2500, type: 'bgmVolume', volume: 0.3 },
      { id: 'narration-3', at: cueStart, type: 'narration', url: 'blob:振り' },
      { id: 'narration-3-duck', at: cueStart, type: 'bgmVolume', volume: ducked },
      { id: 'narration-3-restore', at: cueStart + 2000, type: 'bgmVolume', volume: 0.3 },
    ])
  })

  it('BGM を鳴らさない設定なら、読み上げだけを並べる', () => {
    const silent: TownTourPlaybackSound = { ...bgmOnly, slots: { ...bgmOnly.slots, bgm: null } }
    const playback = narrated({ opening: clip('冒頭', 4000), lines: [null, null, null, null] }, silent)

    expect(soundCuesOf(playback).map((cue) => cue.id)).toEqual(['narration-opening'])
  })

  it('合成できなかった場面は、読み上げを並べない（文字だけを流す）', () => {
    const playback = narrated({ opening: null, lines: [null, clip('項目1', 2000), null, null] })

    expect(soundCuesOf(playback).filter((cue) => cue.type === 'narration').map((cue) => cue.id)).toEqual(['narration-1'])
  })

  it('同じ時刻の効果音（着地）は、読み上げより先に鳴らす', () => {
    const playback = narrated({ opening: clip('冒頭', 4000), lines: [null, null, null, null] }, fullSound)

    expect(soundCuesOf(playback).filter((cue) => cue.at === LANDING).map((cue) => cue.id)).toEqual(['landing', 'narration-opening', 'narration-opening-duck'])
  })

  it('タイマーが遅れて、読み上げの時刻を大きく過ぎていたら、その読み上げも BGM の下げも行わない（場面とずれた声を流さない）', () => {
    const playback = narrated({ opening: clip('冒頭', 4000), lines: [null, null, null, null] })
    const played = new Set(['bgm'])

    expect(dueSoundCues(playback, STARTED_AT + LANDING + 200, played).map((cue) => cue.id)).toEqual(['narration-opening', 'narration-opening-duck'])
    expect(dueSoundCues(playback, STARTED_AT + LANDING + 1000, played)).toEqual([])
    // 戻す指示は遅れても返す（下げたままにしない）
    expect(dueSoundCues(playback, STARTED_AT + LANDING + 5000, played).map((cue) => cue.id)).toEqual(['narration-opening-restore'])
  })
})
