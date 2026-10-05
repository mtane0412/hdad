/**
 * 市町村紹介の再生の進み方（timeline.ts）のテスト
 *
 * 場面は「再生を始めた時刻」「紹介が届いた時刻」と現在時刻だけから決まる（フレーム間の状態を持たない）。
 * 決めた流れは次のとおり。
 * 1. 日本全体を映す（1.5秒）
 * 2. 市町村へズームしながら形を塗る（3秒）
 * 3. 大見出し（7秒。前半1.5秒は「この町、実は…」だけで溜める）→ ゆさぶりの項目（6秒ずつ）→ オチの項目（最後の項目。5秒）
 *    → 配信者への振り（6秒）の順に流す。紹介が届くのが遅ければ、届くまで待ってから始める
 * 4. 最後に出典だけを残して（2秒）終わる
 */
import { describe, expect, it } from 'vitest'
import type { TownTourCall, TownTourIntro } from './tour'
import { CREDIT_HOLD_MS, CUE_MS, HOOK_MS, HOOK_TEASE_MS, POINT_MS, PUNCHLINE_MS, ZOOM_END_MS, sceneAt, type Playback } from './timeline'

const STARTED_AT = 1_000_000

const tobetsuCall: TownTourCall = {
  code: '01303',
  prefecture: '北海道',
  county: '石狩郡',
  name: '当別町',
  headline: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
  // 場面の進み方は音に左右されないので、どの枠も鳴らさない設定にしておく
  sound: {
    slots: { bgm: null, opening: null, zoom: null, landing: null, item: null, closing: null },
    bgmVolume: 0.3,
    effectVolume: 0.6,
  },
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

/** 再生を始めてから readyAfterMs ミリ秒後に紹介が届いた再生 */
const readyPlayback = (readyAfterMs: number): Playback => ({
  call: tobetsuCall,
  startedAt: STARTED_AT,
  intro: { status: 'ready', intro: tobetsuIntro, readyAt: STARTED_AT + readyAfterMs },
})

const loadingPlayback: Playback = { call: tobetsuCall, startedAt: STARTED_AT, intro: { status: 'loading' } }

describe('sceneAt', () => {
  it('始めた直後は日本全体を映し、市町村はまだ塗らない', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT)).toMatchObject({ zoom: 0, fill: 0, item: null, done: false })
  })

  it('ズームが終わると、市町村の形を塗り終えている', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + ZOOM_END_MS)).toMatchObject({ zoom: 1, fill: 1 })
  })

  it('ズームが終わっても紹介が届いていなければ、項目を出さずに待つ', () => {
    expect(sceneAt(loadingPlayback, STARTED_AT + ZOOM_END_MS + 5000)).toMatchObject({ item: null, waiting: true, credit: null, done: false })
  })

  it('紹介がズームより先に届いていれば、ズームが終わったところから大見出しを流す', () => {
    const scene = sceneAt(readyPlayback(2000), STARTED_AT + ZOOM_END_MS + HOOK_MS / 2)

    expect(scene.item).toMatchObject({ line: { kind: 'hook', label: 'この町、実は…', text: '北欧の街並みがある米どころ' }, opacity: 1, textOpacity: 1 })
    expect(scene.credit).toBe('出典: Wikipedia「当別町」（CC BY-SA 4.0）')
  })

  it('大見出しの前半は、見出し（「この町、実は…」）だけを出して文を伏せておく', () => {
    expect(sceneAt(readyPlayback(0), STARTED_AT + ZOOM_END_MS + HOOK_TEASE_MS / 2).item).toMatchObject({ line: { kind: 'hook' }, textOpacity: 0 })
  })

  it('紹介が遅れて届いたら、届いた時刻から流しはじめる', () => {
    const readyAfterMs = ZOOM_END_MS + 3000

    expect(sceneAt(readyPlayback(readyAfterMs), STARTED_AT + readyAfterMs - 1).item).toBeNull()
    expect(sceneAt(readyPlayback(readyAfterMs), STARTED_AT + readyAfterMs + HOOK_MS / 2).item?.line.kind).toBe('hook')
  })

  it('大見出しのあとは、ゆさぶりの項目を6秒、オチ（最後の項目）を5秒、配信者への振りを6秒流す', () => {
    const at = (ms: number) => sceneAt(readyPlayback(0), STARTED_AT + ZOOM_END_MS + ms).item?.line.label

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
    }

    expect(sceneAt(noHook, STARTED_AT + ZOOM_END_MS + 1).item?.line.label).toBe('どこにある？')
  })

  it('振りを流し終えたら、出典だけを残す', () => {
    const scenesEnd = HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS

    expect(sceneAt(readyPlayback(0), STARTED_AT + ZOOM_END_MS + scenesEnd + 1)).toMatchObject({
      item: null,
      credit: '出典: Wikipedia「当別町」（CC BY-SA 4.0）',
      done: false,
    })
  })

  it('出典を残す時間も過ぎたら、終わる', () => {
    const end = ZOOM_END_MS + HOOK_MS + POINT_MS + PUNCHLINE_MS + CUE_MS + CREDIT_HOLD_MS

    expect(sceneAt(readyPlayback(0), STARTED_AT + end - 1).done).toBe(false)
    expect(sceneAt(readyPlayback(0), STARTED_AT + end).done).toBe(true)
  })

  it('紹介を作れなかったら、その場で終わる（失敗は素材の箱に出す）', () => {
    const failed: Playback = { call: tobetsuCall, startedAt: STARTED_AT, intro: { status: 'failed' } }

    expect(sceneAt(failed, STARTED_AT + 1000).done).toBe(true)
  })
})
