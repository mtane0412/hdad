/**
 * オーバーレイと素材の編集の値の変換（src/overlay/form.ts）のテスト
 *
 * 画面（overlay-page.tsx）から分けてテストする（src/admin/form.ts・src/speech/form.ts と同じ分け方）。
 */
import { describe, expect, it } from 'vitest'
import { backgrounds } from '../wallpaper/registry'
import {
  DEFAULT_ITEM_RECT,
  describeOverlayProblem,
  designsFor,
  itemLabel,
  newItemDraft,
  newOverlayDraft,
  overlayNameChoices,
  savableOverlayDrafts,
  schemaFor,
  toOverlayDrafts,
  toOverlays,
} from './form'
import type { Overlay } from './layout'

/** 右下に置いた時計1つだけを積んだ前面のオーバーレイ */
const 前面: Overlay = {
  name: 'front',
  items: [{ kind: 'clock', id: 'analog', params: 'size=0.5', rect: { x: 78, y: 70, width: 20, height: 26 } }],
}

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

describe('newItemDraft・newOverlayDraft', () => {
  it('素材は、オーバーレイいっぱいの大きさとパラメータの既定値で作る', () => {
    const draft = newItemDraft('wallpaper', 'contour')

    expect(draft).toMatchObject({ kind: 'wallpaper', id: 'contour', rect: DEFAULT_ITEM_RECT })
    expect(draft.values).toMatchObject({ color: '#9bc1bc' })
    expect(draft.problem).toBeUndefined()
  })

  it('足したばかりのオーバーレイは素材を持たない', () => {
    expect(newOverlayDraft('talk')).toMatchObject({ name: 'talk', items: [] })
  })

  it('素材とオーバーレイには、1つずつ別の識別子を振る（並べ替えても入力欄を作り直さないため）', () => {
    expect(newItemDraft('alerts', '').key).not.toBe(newItemDraft('alerts', '').key)
    expect(newOverlayDraft('talk').key).not.toBe(newOverlayDraft('talk').key)
  })
})

describe('toOverlayDrafts', () => {
  it('保存済みのオーバーレイと素材を、入力欄の値に読み替える', () => {
    const [overlay] = toOverlayDrafts([前面])
    const item = overlay?.items[0]

    expect(overlay).toMatchObject({ name: 'front' })
    expect(item).toMatchObject({ kind: 'clock', id: 'analog' })
    expect(item?.rect).toEqual({ x: '78', y: '70', width: '20', height: '26' })
    expect(item?.values).toMatchObject({ size: 0.5 })
  })

  it('読み込んだ素材にも、1件ずつ別の識別子を振る', () => {
    const [overlay] = toOverlayDrafts([{ name: 'front', items: [...前面.items, ...前面.items] }])

    expect(new Set(overlay?.items.map((item) => item.key)).size).toBe(2)
  })

  it('読めないパラメータは黙って捨てず、理由を添えて既定値で編集させる', () => {
    // 文字盤の大きさは 0.1〜1 の倍率なので、範囲の外は読めない
    const [overlay] = toOverlayDrafts([{ name: 'front', items: [{ ...前面.items[0]!, params: 'size=200' }] }])

    expect(overlay?.items[0]?.problem).toMatch(/size/)
    expect(overlay?.items[0]?.values).toMatchObject({ size: schemaFor('clock', 'analog')?.size?.default })
  })

  it('レジストリに無いデザインでも、素材を捨てずに理由を添える（保存で消えないようにする）', () => {
    const [overlay] = toOverlayDrafts([{ name: 'front', items: [{ ...前面.items[0]!, id: 'sundial' }] }])

    expect(overlay?.items[0]).toMatchObject({ kind: 'clock', id: 'sundial' })
    expect(overlay?.items[0]?.problem).toMatch(/sundial/)
  })
})

describe('toOverlays', () => {
  it('入力欄の値を、保存する形（パラメータはクエリ文字列）に直す', () => {
    const [overlay] = toOverlayDrafts([前面])
    if (!overlay) throw new Error('読み替えたオーバーレイがありません')

    expect(toOverlays([overlay])).toEqual([前面])
  })

  it('既定値のままのパラメータは書かない（構成を短く保つ）', () => {
    const 素材 = { ...newItemDraft('clock', 'analog') }
    const オーバーレイ = { ...newOverlayDraft('front'), items: [素材] }

    expect(toOverlays([オーバーレイ])[0]?.items[0]?.params).toBe('')
  })

  it('位置と大きさの空欄は 0 に丸めず NaN にする（範囲の検証はWorkerだけが持つ）', () => {
    const 素材 = { ...newItemDraft('clock', 'analog'), rect: { x: '', y: '0', width: '20', height: '26' } }
    const オーバーレイ = { ...newOverlayDraft('front'), items: [素材] }

    expect(toOverlays([オーバーレイ])[0]?.items[0]?.rect.x).toBeNaN()
  })

  it('レジストリに無いデザインの素材は、保存済みのパラメータをそのまま持ち越す', () => {
    const [overlay] = toOverlayDrafts([{ name: 'front', items: [{ ...前面.items[0]!, id: 'sundial' }] }])
    if (!overlay) throw new Error('読み替えたオーバーレイがありません')

    expect(toOverlays([overlay])[0]?.items[0]).toMatchObject({ id: 'sundial', params: 'size=0.5' })
  })
})

describe('savableOverlayDrafts', () => {
  it('素材を1つも持たないオーバーレイは送らない（貼っても何も映らないURLを作らせないため、Workerが拒む）', () => {
    const 空のオーバーレイ = newOverlayDraft('talk')
    const [overlay] = toOverlayDrafts([前面])
    if (!overlay) throw new Error('読み替えたオーバーレイがありません')

    expect(savableOverlayDrafts([overlay, 空のオーバーレイ]).map((draft) => draft.name)).toEqual(['front'])
  })
})

describe('itemLabel', () => {
  it('デザインを持つ種類は、種類の名前にデザイン名を添える', () => {
    expect(itemLabel(newItemDraft('wallpaper', 'contour'))).toBe('背景（Contour）')
  })

  it('レジストリに無いデザインは、保存されているIDをそのまま出す', () => {
    expect(itemLabel(newItemDraft('clock', 'sundial'))).toBe('時計（sundial）')
  })

  it('デザインを持たない種類は、種類の名前だけを出す', () => {
    expect(itemLabel(newItemDraft('alerts', ''))).toBe('アラート')
  })
})

describe('overlayNameChoices', () => {
  it('既定の名前（back・front）と、使われている名前を重複なく並べる', () => {
    const drafts = [newOverlayDraft('back'), newOverlayDraft('game')]

    expect(overlayNameChoices(drafts)).toEqual(['back', 'front', 'game'])
  })
})

describe('describeOverlayProblem', () => {
  const 名前 = [{ name: 'back', items: ['背景（Contour）'] }, { name: 'front', items: ['時計（Analog）', 'アラート'] }]

  it('素材の位置を、オーバーレイの名前と素材の名前に読み替える', () => {
    expect(describeOverlayProblem('overlays[1].items[0].rect.width: 1〜100 の数（％）で指定してください', 名前)).toBe(
      '「front」の「時計（Analog）」の 幅: 1〜100 の数（％）で指定してください',
    )
  })

  it('オーバーレイそのものへの問題点は、名前だけを添える', () => {
    expect(describeOverlayProblem('overlays[0].name: オーバーレイの名前は…', 名前)).toBe('「back」の 名前: オーバーレイの名前は…')
  })

  it('名前が足りなければ番号のままにする', () => {
    expect(describeOverlayProblem('overlays[5].items[2].kind: …', 名前)).toBe('6番目のオーバーレイの 3番目の素材の 種類: …')
  })

  it('構成そのものへの問題点（overlays: …）はそのまま出す', () => {
    expect(describeOverlayProblem('overlays: オーバーレイは10個以内にしてください', 名前)).toBe('overlays: オーバーレイは10個以内にしてください')
  })
})
