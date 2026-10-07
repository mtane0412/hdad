/**
 * 合成オーバーレイの構成（worker/overlay-layout.ts）のテスト
 *
 * 確かめたいのは次の5点である。
 * - オーバーレイ（OBSのブラウザソース1つ）ごとに素材を持つ形を検証し、問題点をすべて集めてから拒むこと
 * - 素材1件の形（種類・デザインID・パラメータ・位置）を検証すること
 * - デザインIDを持つ種類（壁紙・時計・チャット）とそれ以外で、IDの要否が逆になること
 * - パラメータはクエリ文字列のまま持ち、中身（素材のスキーマ）は検証しないこと
 * - 保存されている形が古ければ、読み替えずに直し方を添えてエラーにすること
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import { DEFAULT_OVERLAY_LAYOUT, loadOverlayLayout, parseOverlayLayout, saveOverlayLayout, type Overlay, type OverlayItem } from './overlay-layout'

/** 背面いっぱいに広げた壁紙 */
const wallpaper: OverlayItem = {
  kind: 'wallpaper',
  id: 'aurora',
  params: 'speed=2&colors=ff8ad8,8ad8ff',
  rect: { x: 0, y: 0, width: 100, height: 100 },
}

/** 右下に置く時計 */
const clock: OverlayItem = { kind: 'clock', id: 'analog', params: '', rect: { x: 78, y: 70, width: 20, height: 26 } }

/** いっぱいに置くアラート（デザインIDを持たない種類） */
const alert: OverlayItem = { kind: 'alerts', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }

/** ゲーム画面より後ろに置くオーバーレイ */
const backOverlay: Overlay = { name: 'back', items: [wallpaper] }

/** アバターより前に置くオーバーレイ */
const frontOverlay: Overlay = { name: 'front', items: [clock, alert] }

const issues = (input: unknown): readonly string[] => {
  try {
    parseOverlayLayout(input)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('検証を通ってしまいました（拒まれることを期待しています）')
}

describe('parseOverlayLayout', () => {
  it('オーバーレイと、その中の素材の並びをそのままの順で受け取る（素材の並びが重ねる順になる）', () => {
    const layout = parseOverlayLayout({ overlays: [backOverlay, frontOverlay] })

    expect(layout.overlays).toEqual([backOverlay, frontOverlay])
  })

  it('オーバーレイが1つもない構成も受け取る（まだ何も置いていない状態）', () => {
    expect(parseOverlayLayout({ overlays: [] })).toEqual({ overlays: [] })
  })

  it('オブジェクトでなければ拒む', () => {
    expect(issues('back')).toEqual(['構成はオブジェクトで指定してください'])
  })

  it('overlays が配列でなければ拒む', () => {
    expect(issues({ overlays: '壁紙' })).toEqual(['overlays: 配列で指定してください'])
  })

  it('オーバーレイの名前が書式に合わなければ拒む（OBSに貼るURLに載る値なので形を揃える）', () => {
    expect(issues({ overlays: [{ ...backOverlay, name: '背面' }] })).toEqual([
      'overlays[0].name: オーバーレイの名前は英小文字・数字・ハイフン（20文字まで）で指定してください',
    ])
  })

  it('同じ名前のオーバーレイが2つあれば拒む（同じURLで2通りの中身になってしまう）', () => {
    const [problem] = issues({ overlays: [backOverlay, { ...frontOverlay, name: 'back' }] })

    expect(problem).toBe('overlays[1].name: 「back」という名前のオーバーレイが2つあります')
  })

  it('素材を1つも持たないオーバーレイは拒む（貼っても何も映らないURLを作らせない）', () => {
    expect(issues({ overlays: [{ name: 'back', items: [] }] })).toEqual([
      'overlays[0].items: 素材を1つ以上置いてください（素材のないオーバーレイは貼っても何も映りません）',
    ])
  })

  it('items が配列でなければ拒む', () => {
    expect(issues({ overlays: [{ name: 'back', items: '壁紙' }] })).toEqual(['overlays[0].items: 配列で指定してください'])
  })

  it('知らない種類は、選べる種類を並べて拒む', () => {
    const [problem] = issues({ overlays: [{ name: 'back', items: [{ ...wallpaper, kind: 'timer' }] }] })

    expect(problem).toContain('overlays[0].items[0].kind')
    expect(problem).toContain('wallpaper')
  })

  it('再生中の曲（bgm）はデザインIDを持たない種類として受け取る', () => {
    const nowPlayingTrack: OverlayItem = { kind: 'bgm', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }

    expect(parseOverlayLayout({ overlays: [{ name: 'front', items: [nowPlayingTrack] }] })).toEqual({ overlays: [{ name: 'front', items: [nowPlayingTrack] }] })
  })

  it('タブの映像（tab）はデザインIDを持たない種類として受け取る', () => {
    const capturedTab: OverlayItem = { kind: 'tab', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }

    expect(parseOverlayLayout({ overlays: [{ name: 'front', items: [capturedTab] }] })).toEqual({ overlays: [{ name: 'front', items: [capturedTab] }] })
  })

  it('作業ログ（workLog）はデザインIDを持たない種類として受け取る', () => {
    const workLog: OverlayItem = { kind: 'workLog', id: '', params: '', rect: { x: 70, y: 10, width: 28, height: 60 } }

    expect(parseOverlayLayout({ overlays: [{ name: 'front', items: [workLog] }] })).toEqual({ overlays: [{ name: 'front', items: [workLog] }] })
  })

  it('作業机（taskDesk）はデザインIDを持たない種類として受け取る', () => {
    const taskDesk: OverlayItem = { kind: 'taskDesk', id: '', params: '', rect: { x: 70, y: 10, width: 28, height: 60 } }

    expect(parseOverlayLayout({ overlays: [{ name: 'front', items: [taskDesk] }] })).toEqual({ overlays: [{ name: 'front', items: [taskDesk] }] })
  })

  it('市町村紹介（townTour）はデザインIDを持たない種類として受け取る', () => {
    const townTour: OverlayItem = { kind: 'townTour', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }

    expect(parseOverlayLayout({ overlays: [{ name: 'front', items: [townTour] }] })).toEqual({ overlays: [{ name: 'front', items: [townTour] }] })
  })

  it('ツイスター（twister）はデザインIDを持たない種類として受け取る', () => {
    const twister: OverlayItem = { kind: 'twister', id: '', params: '', rect: { x: 0, y: 0, width: 100, height: 100 } }

    expect(parseOverlayLayout({ overlays: [{ name: 'front', items: [twister] }] })).toEqual({ overlays: [{ name: 'front', items: [twister] }] })
  })

  it('ワイプ（wipe）はデザインIDを持たない種類として受け取る', () => {
    const wipe: OverlayItem = { kind: 'wipe', id: '', params: '', rect: { x: 70, y: 3, width: 28, height: 30 } }

    expect(parseOverlayLayout({ overlays: [{ name: 'front', items: [wipe] }] })).toEqual({ overlays: [{ name: 'front', items: [wipe] }] })
  })

  it('ワイプが構成全体で2つあれば受け付けない（どちらもチャットを読み上げ、同じ発言が二重に読まれるため）', () => {
    const wipe: OverlayItem = { kind: 'wipe', id: '', params: '', rect: { x: 70, y: 3, width: 28, height: 30 } }

    expect(issues({ overlays: [{ name: 'front', items: [wipe] }, { name: 'game', items: [wipe] }] })).toEqual([
      'overlays[1].items[0]: ワイプは構成全体で1つまでにしてください（それぞれがチャットを読み上げ、同じ発言が二重に読まれるため）',
    ])
  })

  it('ポモドーロ（pomodoro）はデザインIDを持たない種類として受け取る', () => {
    const pomodoro: OverlayItem = { kind: 'pomodoro', id: '', params: '', rect: { x: 75, y: 5, width: 20, height: 15 } }

    expect(parseOverlayLayout({ overlays: [{ name: 'front', items: [pomodoro] }] })).toEqual({ overlays: [{ name: 'front', items: [pomodoro] }] })
  })

  it('壁紙・時計・チャットはデザインIDが空だと拒む', () => {
    expect(issues({ overlays: [{ name: 'back', items: [{ ...wallpaper, id: '' }] }] })).toEqual([
      'overlays[0].items[0].id: デザインIDを指定してください（英数字と下線・ハイフン、40文字まで）',
    ])
  })

  it('デザインIDを持たない種類にIDが入っていたら拒む（意味を持たない値を残さない）', () => {
    expect(issues({ overlays: [{ name: 'front', items: [{ ...alert, id: 'analog' }] }] })).toEqual([
      'overlays[0].items[0].id: alerts はデザインIDを持たないので、空文字にしてください',
    ])
  })

  it('パラメータはクエリ文字列のまま受け取り、中身は検証しない（素材のスキーマはWorkerが知らない）', () => {
    const layout = parseOverlayLayout({ overlays: [{ name: 'back', items: [{ ...wallpaper, params: 'speed=999&unknown=1' }] }] })

    expect(layout.overlays[0]?.items[0]?.params).toBe('speed=999&unknown=1')
  })

  it('パラメータが文字列でなければ拒む', () => {
    expect(issues({ overlays: [{ name: 'back', items: [{ ...wallpaper, params: { speed: 2 } }] }] })).toEqual([
      'overlays[0].items[0].params: クエリ文字列（speed=2&colors=ff8ad8 の形）で指定してください',
    ])
  })

  it('パラメータの先頭に ? が付いていたら拒む（URLSearchParams がそのまま読める形に揃える）', () => {
    expect(issues({ overlays: [{ name: 'back', items: [{ ...wallpaper, params: '?speed=2' }] }] })).toEqual([
      'overlays[0].items[0].params: 先頭の ? は付けないでください',
    ])
  })

  it('位置と大きさが割合の範囲を外れていたら拒む', () => {
    expect(issues({ overlays: [{ name: 'front', items: [{ ...clock, rect: { x: -1, y: 0, width: 0, height: 26 } }] }] })).toEqual([
      'overlays[0].items[0].rect.x: 0〜100 の数（％）で指定してください',
      'overlays[0].items[0].rect.width: 1〜100 の数（％）で指定してください',
    ])
  })

  it('位置がオブジェクトでなければ拒む', () => {
    expect(issues({ overlays: [{ name: 'front', items: [{ ...clock, rect: null }] }] })).toEqual([
      'overlays[0].items[0].rect: 位置と大きさを { x, y, width, height } の割合（％）で指定してください',
    ])
  })

  it('問題点は最初の1件で止めず、オーバーレイと素材をまたいですべて集める（画面で一度に直せるようにする）', () => {
    const problems = issues({
      overlays: [
        { name: 'back', items: [{ ...wallpaper, id: '' }] },
        { name: '前面', items: [clock] },
      ],
    })

    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('overlays[0].items[0].id')
    expect(problems[1]).toContain('overlays[1].name')
  })

  it('1つのオーバーレイに素材が多すぎたら拒む（1枚のページで動かし切れる数に留める）', () => {
    const [problem] = issues({ overlays: [{ name: 'front', items: Array.from({ length: 21 }, () => alert) }] })

    expect(problem).toContain('overlays[0].items: ')
  })

  it('オーバーレイが多すぎたら拒む（OBSに置くブラウザソースの数なので、増え続ける形にしない）', () => {
    const [problem] = issues({ overlays: Array.from({ length: 11 }, (_, index) => ({ name: `stage-${index}`, items: [alert] })) })

    expect(problem).toContain('overlays: ')
  })
})

describe('saveOverlayLayout・loadOverlayLayout', () => {
  it('保存した構成をそのまま読める', async () => {
    const store = createFakeStore()

    await saveOverlayLayout(store, { overlays: [backOverlay, frontOverlay] })

    expect(await loadOverlayLayout(store)).toEqual({ overlays: [backOverlay, frontOverlay] })
  })

  it('一度も保存していなければ、オーバーレイが1つもない構成を返す', async () => {
    expect(await loadOverlayLayout(createFakeStore())).toEqual(DEFAULT_OVERLAY_LAYOUT)
  })

  it('保存されている形が古ければ（オーバーレイごとに分ける前の平らな形）、読み替えずに直し方を添えてエラーにする（Fail-Fast）', async () => {
    const legacyShape = { layers: [{ kind: 'wallpaper', id: 'aurora', params: '', group: 'back', rect: { x: 0, y: 0, width: 100, height: 100 } }] }
    const store = createFakeStore({ 'overlay-layout': JSON.stringify(legacyShape) })

    await expect(loadOverlayLayout(store)).rejects.toThrow(/overlay-layout/)
  })
})
