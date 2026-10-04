/**
 * 市町村紹介の再生の進み方（timeline.ts）のテスト
 *
 * 場面は「再生を始めた時刻」「紹介が届いた時刻」と現在時刻だけから決まる（フレーム間の状態を持たない）。
 * 決めた流れは次のとおり。
 * 1. 日本全体を映す（1.5秒）
 * 2. 市町村へズームしながら形を塗る（3秒）
 * 3. 紹介の項目を1つずつ流す（1項目6秒。紹介が届くのが遅ければ、届くまで待ってから始める）
 * 4. 最後に出典だけを残して（4秒）終わる
 */
import { describe, expect, it } from 'vitest'
import type { TownTourCall, TownTourIntro } from './tour'
import { ITEM_MS, ZOOM_END_MS, sceneAt, type Playback } from './timeline'

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

/** 項目が2つだけの紹介（ほかは材料に無かった） */
const tobetsuIntro: TownTourIntro = {
  article: { title: '当別町', url: 'https://ja.wikipedia.org/wiki/%E5%BD%93%E5%88%A5%E7%94%BA' },
  tour: { location: '石狩平野の北東部にある町です。', nameOrigin: '', history: '', specialty: '当別米が名物です。', surprise: '' },
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

  it('紹介がズームより先に届いていれば、ズームが終わったところから1つ目の項目を流す', () => {
    const scene = sceneAt(readyPlayback(2000), STARTED_AT + ZOOM_END_MS + ITEM_MS / 2)

    expect(scene.item).toMatchObject({ line: { label: 'どこにある？', text: '石狩平野の北東部にある町です。' }, opacity: 1 })
    expect(scene.credit).toBe('出典: Wikipedia「当別町」（CC BY-SA 4.0）')
  })

  it('紹介が遅れて届いたら、届いた時刻から項目を流しはじめる', () => {
    const readyAfterMs = ZOOM_END_MS + 3000

    expect(sceneAt(readyPlayback(readyAfterMs), STARTED_AT + readyAfterMs - 1).item).toBeNull()
    expect(sceneAt(readyPlayback(readyAfterMs), STARTED_AT + readyAfterMs + ITEM_MS / 2).item?.line.label).toBe('どこにある？')
  })

  it('1項目ぶんの時間が過ぎたら、空でない次の項目へ進む（材料に無い項目は飛ばす）', () => {
    expect(sceneAt(readyPlayback(0), STARTED_AT + ZOOM_END_MS + ITEM_MS * 1.5).item?.line.label).toBe('名物')
  })

  it('項目を流し終えたら、出典だけを残す', () => {
    expect(sceneAt(readyPlayback(0), STARTED_AT + ZOOM_END_MS + ITEM_MS * 2 + 1000)).toMatchObject({
      item: null,
      credit: '出典: Wikipedia「当別町」（CC BY-SA 4.0）',
      done: false,
    })
  })

  it('出典を残す時間も過ぎたら、終わる', () => {
    expect(sceneAt(readyPlayback(0), STARTED_AT + ZOOM_END_MS + ITEM_MS * 2 + 4000).done).toBe(true)
  })

  it('紹介を作れなかったら、その場で終わる（失敗は素材の箱に出す）', () => {
    const failed: Playback = { call: tobetsuCall, startedAt: STARTED_AT, intro: { status: 'failed' } }

    expect(sceneAt(failed, STARTED_AT + 1000).done).toBe(true)
  })
})
