/**
 * 合成オーバーレイの構成（worker/overlay-layout.ts）のテスト
 *
 * 確かめたいのは次の4点である。
 * - レイヤー1件の形（種類・デザインID・パラメータ・段・位置）を検証し、問題点をすべて集めてから拒むこと
 * - デザインIDを持つ種類（壁紙・時計・チャット）とそれ以外で、IDの要否が逆になること
 * - パラメータはクエリ文字列のまま持ち、中身（素材のスキーマ）は検証しないこと
 * - 保存されている形が古ければ、読み替えずに直し方を添えてエラーにすること
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import {
  DEFAULT_OVERLAY_LAYOUT,
  loadOverlayLayout,
  parseOverlayLayout,
  saveOverlayLayout,
  type OverlayLayer,
} from './overlay-layout'

/** 背面に置く壁紙のレイヤー（段いっぱいに広げたもの） */
const 壁紙のレイヤー: OverlayLayer = {
  kind: 'wallpaper',
  id: 'aurora',
  params: 'speed=2&colors=ff8ad8,8ad8ff',
  group: 'back',
  rect: { x: 0, y: 0, width: 100, height: 100 },
}

/** 前面の右下に置く時計のレイヤー */
const 時計のレイヤー: OverlayLayer = {
  kind: 'clock',
  id: 'analog',
  params: '',
  group: 'front',
  rect: { x: 78, y: 70, width: 20, height: 26 },
}

/** 前面いっぱいに置くアラートのレイヤー（デザインIDを持たない種類） */
const アラートのレイヤー: OverlayLayer = {
  kind: 'alerts',
  id: '',
  params: '',
  group: 'front',
  rect: { x: 0, y: 0, width: 100, height: 100 },
}

const 問題点 = (input: unknown): readonly string[] => {
  try {
    parseOverlayLayout(input)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('検証を通ってしまいました（拒まれることを期待しています）')
}

describe('parseOverlayLayout', () => {
  it('レイヤーの並びをそのままの順で受け取る（重ねる順になる）', () => {
    const layout = parseOverlayLayout({ layers: [壁紙のレイヤー, 時計のレイヤー, アラートのレイヤー] })

    expect(layout.layers).toEqual([壁紙のレイヤー, 時計のレイヤー, アラートのレイヤー])
  })

  it('レイヤーが1件もない構成も受け取る（まだ何も置いていない状態）', () => {
    expect(parseOverlayLayout({ layers: [] })).toEqual({ layers: [] })
  })

  it('オブジェクトでなければ拒む', () => {
    expect(問題点('back')).toEqual(['構成はオブジェクトで指定してください'])
  })

  it('layers が配列でなければ拒む', () => {
    expect(問題点({ layers: '壁紙' })).toEqual(['layers: 配列で指定してください'])
  })

  it('知らない種類は、選べる種類を並べて拒む', () => {
    const [problem] = 問題点({ layers: [{ ...壁紙のレイヤー, kind: 'timer' }] })

    expect(problem).toContain('layers[0].kind')
    expect(problem).toContain('wallpaper')
  })

  it('壁紙・時計・チャットはデザインIDが空だと拒む', () => {
    expect(問題点({ layers: [{ ...壁紙のレイヤー, id: '' }] })).toEqual([
      'layers[0].id: デザインIDを指定してください（英数字と下線・ハイフン、40文字まで）',
    ])
  })

  it('デザインIDを持たない種類にIDが入っていたら拒む（意味を持たない値を残さない）', () => {
    expect(問題点({ layers: [{ ...アラートのレイヤー, id: 'analog' }] })).toEqual([
      'layers[0].id: alerts はデザインIDを持たないので、空文字にしてください',
    ])
  })

  it('パラメータはクエリ文字列のまま受け取り、中身は検証しない（素材のスキーマはWorkerが知らない）', () => {
    const layout = parseOverlayLayout({ layers: [{ ...壁紙のレイヤー, params: 'speed=999&unknown=1' }] })

    expect(layout.layers[0]?.params).toBe('speed=999&unknown=1')
  })

  it('パラメータが文字列でなければ拒む', () => {
    expect(問題点({ layers: [{ ...壁紙のレイヤー, params: { speed: 2 } }] })).toEqual([
      'layers[0].params: クエリ文字列（speed=2&colors=ff8ad8 の形）で指定してください',
    ])
  })

  it('パラメータの先頭に ? が付いていたら拒む（URLSearchParams がそのまま読める形に揃える）', () => {
    expect(問題点({ layers: [{ ...壁紙のレイヤー, params: '?speed=2' }] })).toEqual([
      'layers[0].params: 先頭の ? は付けないでください',
    ])
  })

  it('段の名前が書式に合わなければ拒む（OBSに貼るURLに載る値なので形を揃える）', () => {
    expect(問題点({ layers: [{ ...壁紙のレイヤー, group: '背面' }] })).toEqual([
      'layers[0].group: 段の名前は英小文字・数字・ハイフン（20文字まで）で指定してください',
    ])
  })

  it('位置と大きさが割合の範囲を外れていたら拒む', () => {
    expect(問題点({ layers: [{ ...時計のレイヤー, rect: { x: -1, y: 0, width: 0, height: 26 } }] })).toEqual([
      'layers[0].rect.x: 0〜100 の数（％）で指定してください',
      'layers[0].rect.width: 1〜100 の数（％）で指定してください',
    ])
  })

  it('位置がオブジェクトでなければ拒む', () => {
    expect(問題点({ layers: [{ ...時計のレイヤー, rect: null }] })).toEqual([
      'layers[0].rect: 位置と大きさを { x, y, width, height } の割合（％）で指定してください',
    ])
  })

  it('問題点は最初の1件で止めず、レイヤーをまたいですべて集める（画面で一度に直せるようにする）', () => {
    const problems = 問題点({
      layers: [
        { ...壁紙のレイヤー, id: '' },
        { ...時計のレイヤー, group: '前面' },
      ],
    })

    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('layers[0].id')
    expect(problems[1]).toContain('layers[1].group')
  })

  it('レイヤーが多すぎたら拒む（1枚のページで動かし切れる数に留める）', () => {
    const [problem] = 問題点({ layers: Array.from({ length: 21 }, () => アラートのレイヤー) })

    expect(problem).toContain('layers: ')
  })
})

describe('saveOverlayLayout・loadOverlayLayout', () => {
  it('保存した構成をそのまま読める', async () => {
    const store = createFakeStore()

    await saveOverlayLayout(store, { layers: [壁紙のレイヤー, アラートのレイヤー] })

    expect(await loadOverlayLayout(store)).toEqual({ layers: [壁紙のレイヤー, アラートのレイヤー] })
  })

  it('一度も保存していなければ、レイヤーが1件もない構成を返す', async () => {
    expect(await loadOverlayLayout(createFakeStore())).toEqual(DEFAULT_OVERLAY_LAYOUT)
  })

  it('保存されている形が古ければ、読み替えずに直し方を添えてエラーにする（Fail-Fast）', async () => {
    const store = createFakeStore({ 'overlay-layout': JSON.stringify({ back: ['aurora'], front: ['analog'] }) })

    await expect(loadOverlayLayout(store)).rejects.toThrow(/overlay-layout/)
  })
})
