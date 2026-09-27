/**
 * レイヤーの編集の値の変換（src/overlay/form.ts）のテスト
 *
 * 画面（overlay-page.tsx）から分けてテストする（src/admin/form.ts・src/speech/form.ts と同じ分け方）。
 */
import { describe, expect, it } from 'vitest'
import { backgrounds } from '../wallpaper/registry'
import {
  DEFAULT_LAYER_RECT,
  describeLayerProblem,
  designsFor,
  groupChoices,
  layerLabel,
  newLayerDraft,
  schemaFor,
  toLayerDrafts,
  toLayers,
} from './form'
import type { OverlayLayer } from './layout'

const 時計のレイヤー: OverlayLayer = { kind: 'clock', id: 'analog', params: '', group: 'front', rect: { x: 78, y: 70, width: 20, height: 26 } }

describe('designsFor', () => {
  it('壁紙・時計・チャットはレジストリのデザインを並べる', () => {
    expect(designsFor('wallpaper')).toEqual(backgrounds)
    expect(designsFor('clock').map((design) => design.id)).toContain('analog')
    expect(designsFor('chat').map((design) => design.id)).toContain('bubble')
  })

  it('デザインIDを持たない種類には1件も並べない', () => {
    for (const kind of ['alerts', 'sideSuper', 'focus'] as const) expect(designsFor(kind)).toEqual([])
  })
})

describe('schemaFor', () => {
  it('壁紙はデザインのスキーマを返す', () => {
    expect(schemaFor('wallpaper', 'contour')).toHaveProperty('color')
  })

  it('サイドスーパーは寄せる向きのスキーマを返す', () => {
    expect(schemaFor('sideSuper', '')).toHaveProperty('position')
  })

  it('アラートと注目コメントは、配信者が決めるパラメータを持たない', () => {
    expect(schemaFor('alerts', '')).toEqual({})
    expect(schemaFor('focus', '')).toEqual({})
  })

  it('レジストリに無いデザインでは undefined を返す（既定のスキーマへ黙って倒さない）', () => {
    expect(schemaFor('clock', 'sundial')).toBeUndefined()
  })
})

describe('newLayerDraft', () => {
  it('位置と大きさは段いっぱい、パラメータは既定値で作る', () => {
    const draft = newLayerDraft('wallpaper', 'contour', 'back')

    expect(draft).toMatchObject({ kind: 'wallpaper', id: 'contour', group: 'back', rect: DEFAULT_LAYER_RECT })
    expect(draft.values).toMatchObject({ color: '#9bc1bc' })
    expect(draft.problem).toBeUndefined()
  })
})

describe('toLayerDrafts', () => {
  it('保存済みのレイヤーを、入力欄の値に読み替える', () => {
    const [draft] = toLayerDrafts([{ ...時計のレイヤー, params: 'size=0.5' }])

    expect(draft).toMatchObject({ kind: 'clock', id: 'analog', group: 'front' })
    expect(draft?.rect).toEqual({ x: '78', y: '70', width: '20', height: '26' })
    expect(draft?.values).toMatchObject({ size: 0.5 })
  })

  it('読めないパラメータは黙って捨てず、理由を添えて既定値で編集させる', () => {
    // 文字盤の大きさは 0.1〜1 の倍率なので、範囲の外は読めない
    const [draft] = toLayerDrafts([{ ...時計のレイヤー, params: 'size=200' }])

    expect(draft?.problem).toMatch(/size/)
    expect(draft?.values).toMatchObject({ size: schemaFor('clock', 'analog')?.size?.default })
  })

  it('レジストリに無いデザインでも、レイヤーを捨てずに理由を添える（保存で消えないようにする）', () => {
    const [draft] = toLayerDrafts([{ ...時計のレイヤー, id: 'sundial' }])

    expect(draft).toMatchObject({ kind: 'clock', id: 'sundial' })
    expect(draft?.problem).toMatch(/sundial/)
  })
})

describe('toLayers', () => {
  it('入力欄の値を、保存する形（パラメータはクエリ文字列）に直す', () => {
    const draft = { ...newLayerDraft('clock', 'analog', 'front'), rect: { x: '78', y: '70', width: '20', height: '26' } }

    expect(toLayers([{ ...draft, values: { ...draft.values, size: 0.5 } }])).toEqual([
      { kind: 'clock', id: 'analog', params: 'size=0.5', group: 'front', rect: { x: 78, y: 70, width: 20, height: 26 } },
    ])
  })

  it('既定値のままのパラメータは書かない（構成を短く保つ）', () => {
    expect(toLayers([newLayerDraft('clock', 'analog', 'front')])[0]?.params).toBe('')
  })

  it('位置と大きさの空欄は 0 に丸めず NaN にする（範囲の検証はWorkerだけが持つ）', () => {
    const draft = { ...newLayerDraft('clock', 'analog', 'front'), rect: { x: '', y: '0', width: '20', height: '26' } }

    expect(toLayers([draft])[0]?.rect.x).toBeNaN()
  })

  it('レジストリに無いデザインのレイヤーは、保存済みのパラメータをそのまま持ち越す', () => {
    const [draft] = toLayerDrafts([{ ...時計のレイヤー, id: 'sundial', params: 'size=0.5' }])
    if (!draft) throw new Error('読み替えたレイヤーがありません')

    expect(toLayers([draft])[0]).toMatchObject({ id: 'sundial', params: 'size=0.5' })
  })
})

describe('layerLabel', () => {
  it('デザインを持つ種類は、種類の名前にデザイン名を添える', () => {
    expect(layerLabel(newLayerDraft('wallpaper', 'contour', 'back'))).toBe('背景（Contour）')
  })

  it('レジストリに無いデザインは、保存されているIDをそのまま出す', () => {
    expect(layerLabel(newLayerDraft('clock', 'sundial', 'front'))).toBe('時計（sundial）')
  })

  it('デザインを持たない種類は、種類の名前だけを出す', () => {
    expect(layerLabel(newLayerDraft('alerts', '', 'front'))).toBe('アラート')
  })
})

describe('groupChoices', () => {
  it('既定の段（back・front）と、使われている段を重複なく並べる', () => {
    const drafts = [newLayerDraft('wallpaper', 'contour', 'back'), newLayerDraft('alerts', '', 'game')]

    expect(groupChoices(drafts, [])).toEqual(['back', 'front', 'game'])
  })

  it('配信者が足した段も並べる（まだレイヤーを置いていなくても選べる）', () => {
    expect(groupChoices([], ['talk'])).toEqual(['back', 'front', 'talk'])
  })
})

describe('describeLayerProblem', () => {
  const 名前 = ['背景（Contour）', 'アラート']

  it('レイヤーの位置を、送った順の名前に読み替える', () => {
    expect(describeLayerProblem('layers[0].rect.width: 1〜100 の数（％）で指定してください', 名前)).toBe(
      '「背景（Contour）」の 幅: 1〜100 の数（％）で指定してください',
    )
  })

  it('項目の名前も画面の言い方に読み替える', () => {
    expect(describeLayerProblem('layers[1].group: 段の名前は…', 名前)).toBe('「アラート」の 段: 段の名前は…')
  })

  it('名前が足りなければ番号のままにする', () => {
    expect(describeLayerProblem('layers[5].kind: …', 名前)).toBe('6番目のレイヤーの 種類: …')
  })

  it('構成そのものへの問題点（layers: …）はそのまま出す', () => {
    expect(describeLayerProblem('layers: レイヤーは20件以内にしてください', 名前)).toBe('layers: レイヤーは20件以内にしてください')
  })
})
