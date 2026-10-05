/**
 * 市町村紹介の再生の進み方（timeline.ts）のテスト
 *
 * 場面は「再生を始めた時刻」「紹介が届いた時刻」と現在時刻だけから決まる（フレーム間の状態を持たない）。
 * 決めた流れは次のとおり。
 * 0. 市町村の形だけをシルエットで出し、都道府県当てクイズを出す（15秒。4秒ごとにヒントを1つ足す）。
 *    チャットで正解が出たら、その時点でクイズを終える。終えたら正解（と最初の正解者）を3秒出す（issue #251）
 * 1. クイズを終えたら日本全体を映す（1.5秒）
 * 2. 市町村へズームしながら形を塗る（3秒）
 * 3. 大見出し（7秒。前半1.5秒は「この町、実は…」だけで溜める）→ ゆさぶりの項目（6秒ずつ）→ オチの項目（最後の項目。5秒）
 *    → 配信者への振り（6秒）の順に流す。紹介が届くのが遅ければ、届くまで待ってから始める
 * 4. 最後に出典だけを残して（2秒）終わる
 */
import { describe, expect, it } from 'vitest'
import type { TownTourCall, TownTourIntro } from './tour'
import { QUIZ_HINT_INTERVAL_MS, QUIZ_MS } from './quiz'
import {
  CREDIT_HOLD_MS,
  CUE_MS,
  HOOK_MS,
  HOOK_TEASE_MS,
  JAPAN_HOLD_MS,
  POINT_MS,
  PUNCHLINE_MS,
  REVEAL_MS,
  ZOOM_END_MS,
  sceneAt,
  type Playback,
} from './timeline'

const STARTED_AT = 1_000_000

const tobetsuCall: TownTourCall = {
  code: '01303',
  prefecture: '北海道',
  county: '石狩郡',
  name: '当別町',
  headline: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
  quizId: 'quiz-tobetsu',
  quizHeadline: '山田花子さんのレイドを記念して、本日は当別町をご紹介します',
  // 場面の進み方は音に左右されないので、どの枠も鳴らさない設定にしておく
  sound: {
    slots: { bgm: null, opening: null, zoom: null, landing: null, item: null, closing: null },
    bgmVolume: 0.3,
    effectVolume: 0.6,
  },
  population: 14974,
  area: 422.86,
  audience: { kind: 'raid', count: 50 },
}

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

/** 地図の形から作ったヒント（海に面しているか → 地方 → 隣り合う都道府県） */
const tobetsuHints = ['海に面していません', '北海道地方にあります', '陸で接する都道府県はありません']

/** 誰も正解しなかったクイズ */
const unansweredQuiz: Playback['quiz'] = { hints: tobetsuHints, answer: null, unopenedAt: null }

/** 正解者が出なかった再生では、クイズの長さいっぱいで日本地図へ移る */
const MAP_START = QUIZ_MS

/** 再生を始めてから readyAfterMs ミリ秒後に紹介が届いた再生（誰も正解しなかった） */
const readyPlayback = (readyAfterMs: number): Playback => ({
  call: tobetsuCall,
  startedAt: STARTED_AT,
  intro: { status: 'ready', intro: tobetsuIntro, readyAt: STARTED_AT + readyAfterMs },
  quiz: unansweredQuiz,
})

const loadingPlayback: Playback = { call: tobetsuCall, startedAt: STARTED_AT, intro: { status: 'loading' }, quiz: unansweredQuiz }

/** 再生を始めてから answeredAfterMs ミリ秒後に「たなか」さんが正解した再生（紹介は始めた時点で届いている） */
const answeredPlayback = (answeredAfterMs: number): Playback => ({
  ...readyPlayback(0),
  quiz: { hints: tobetsuHints, answer: { userName: 'たなか', answeredAt: STARTED_AT + answeredAfterMs }, unopenedAt: null },
})

describe('sceneAt のクイズ', () => {
  it('始めた直後は、都道府県を伏せた一文と、市町村の名前を入れた問いを出し、ヒントはまだ出さない', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT)).toMatchObject({
      headlineText: '山田花子さんのレイドを記念して、本日は当別町をご紹介します',
      quiz: { label: '都道府県当てクイズ', question: '当別町はどこの都道府県でしょう？ チャットで答えてね', hints: [] },
      reveal: null,
      fill: 0,
    })
  })

  it('ヒントは、4秒ごとに1つずつ足していく', () => {
    const hintsAt = (ms: number) => sceneAt(loadingPlayback, STARTED_AT + ms).quiz?.hints

    expect(hintsAt(QUIZ_HINT_INTERVAL_MS - 1)).toEqual([])
    expect(hintsAt(QUIZ_HINT_INTERVAL_MS)).toEqual(['海に面していません'])
    expect(hintsAt(QUIZ_HINT_INTERVAL_MS * 3)).toEqual(tobetsuHints)
  })

  it('誰も正解しなければ、クイズの長さが過ぎたところで時間切れとして正解を出し、冒頭の一文を都道府県入りに戻す', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + QUIZ_MS)).toMatchObject({
      headlineText: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
      quiz: null,
      reveal: { label: '時間切れ！', text: '正解は北海道' },
      zoom: 0,
    })
  })

  it('チャットで正解が出たら、その時点でクイズを終え、最初の正解者の名前と正解を出す', () => {
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 - 1).quiz).not.toBeNull()
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 + 1)).toMatchObject({
      quiz: null,
      reveal: { label: '最初の正解: たなかさん', text: '正解は北海道' },
    })
  })

  it('出題を開けなかったら、その時点でクイズを打ち切り、受け付けられなかった旨と正解を出す（答えても届かない問いを出し続けない）', () => {
    const unopened: Playback = { ...loadingPlayback, quiz: { hints: tobetsuHints, answer: null, unopenedAt: STARTED_AT + 800 } }

    expect(sceneAt(unopened, STARTED_AT + 1000)).toMatchObject({
      quiz: null,
      reveal: { label: 'クイズを受け付けられませんでした', text: '正解は北海道' },
    })
  })

  it('正解を出す場面は3秒で終わる', () => {
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 + REVEAL_MS).reveal).toBeNull()
  })

  it('正解が早く出たら、そのぶん早く日本地図からズームし、紹介を流しはじめる', () => {
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 + JAPAN_HOLD_MS).zoom).toBe(0)
    expect(sceneAt(answeredPlayback(5000), STARTED_AT + 5000 + ZOOM_END_MS + 1).item?.line.kind).toBe('hook')
  })
})

describe('sceneAt', () => {
  it('クイズを終えた直後は日本全体を映し、市町村はまだ塗らない', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + MAP_START)).toMatchObject({ zoom: 0, fill: 0, item: null, done: false })
  })

  it('ズームが終わると、市町村の形を塗り終えている', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + MAP_START + ZOOM_END_MS)).toMatchObject({ zoom: 1, fill: 1 })
  })

  it('ズームが終わっても紹介が届いていなければ、項目を出さずに待つ', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + MAP_START + ZOOM_END_MS + 5000)).toMatchObject({ item: null, waiting: true, credit: null, done: false })
  })

  it('紹介がズームより先に届いていれば、ズームが終わったところから大見出しを流す', () => {
    const scene = sceneAt(readyPlayback(2000), STARTED_AT + MAP_START + ZOOM_END_MS + HOOK_MS / 2)

    expect(scene.item).toMatchObject({ line: { kind: 'hook', label: 'この町、実は…', text: '北欧の街並みがある米どころ' }, opacity: 1, textOpacity: 1 })
    expect(scene.credit).toBe('出典: Wikipedia「当別町」（CC BY-SA 4.0）')
  })

  it('大見出しの前半は、見出し（「この町、実は…」）だけを出して文を伏せておく', () => {
    expect(sceneAt(readyPlayback(0), STARTED_AT + MAP_START + ZOOM_END_MS + HOOK_TEASE_MS / 2).item).toMatchObject({ line: { kind: 'hook' }, textOpacity: 0 })
  })

  it('紹介が遅れて届いたら、届いた時刻から流しはじめる', () => {
    const readyAfterMs = MAP_START + ZOOM_END_MS + 3000

    expect(sceneAt(readyPlayback(readyAfterMs), STARTED_AT + readyAfterMs - 1).item).toBeNull()
    expect(sceneAt(readyPlayback(readyAfterMs), STARTED_AT + readyAfterMs + HOOK_MS / 2).item?.line.kind).toBe('hook')
  })

  it('大見出しのあとは、ゆさぶりの項目を6秒、オチ（最後の項目）を5秒、配信者への振りを6秒流す', () => {
    const at = (ms: number) => sceneAt(readyPlayback(0), STARTED_AT + MAP_START + ZOOM_END_MS + ms).item?.line.label

    expect(at(HOOK_MS + 1)).toBe('どこにある？')
    expect(at(HOOK_MS + POINT_MS - 1)).toBe('どこにある？')
    expect(at(HOOK_MS + POINT_MS + 1)).toBe('名物')
    expect(at(HOOK_MS + POINT_MS + PUNCHLINE_MS - 1)).toBe('名物')
    expect(at(HOOK_MS + POINT_MS + PUNCHLINE_MS + 1)).toBe('ところで…')
  })

  it('大見出しが空なら、ズームが終わったところから項目を流す', () => {
    const noHook: Playback = {
      call: tobetsuCall,
      startedAt: STARTED_AT,
      intro: { status: 'ready', intro: { ...tobetsuIntro, tour: { ...tobetsuIntro.tour, hook: '' } }, readyAt: STARTED_AT },
      quiz: unansweredQuiz,
    }

    expect(sceneAt(noHook, STARTED_AT + MAP_START + ZOOM_END_MS + 1).item?.line.label).toBe('どこにある？')
  })

  it('振りを流し終えたら、出典だけを残す', () => {
    const scenesEnd = HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS

    expect(sceneAt(readyPlayback(0), STARTED_AT + MAP_START + ZOOM_END_MS + scenesEnd + 1)).toMatchObject({
      item: null,
      credit: '出典: Wikipedia「当別町」（CC BY-SA 4.0）',
      done: false,
    })
  })

  it('出典を残す時間も過ぎたら、終わる', () => {
    const end = MAP_START + ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS + CREDIT_HOLD_MS

    expect(sceneAt(readyPlayback(0), STARTED_AT + end - 1).done).toBe(false)
    expect(sceneAt(readyPlayback(0), STARTED_AT + end).done).toBe(true)
  })

  it('紹介を作れなかったら、その場で終わる（失敗は素材の箱に出す）', () => {
    const failed: Playback = { call: tobetsuCall, startedAt: STARTED_AT, intro: { status: 'failed' }, quiz: unansweredQuiz }

    expect(sceneAt(failed, STARTED_AT + 1000).done).toBe(true)
  })
})
