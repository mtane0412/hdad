/**
 * オーバーレイと素材の編集の値の変換（src/overlay/form.ts）のテスト
 *
 * 画面（overlay-page.tsx）から分けてテストする（src/admin/form.ts・src/speech/form.ts と同じ分け方）。
 */
import { describe, expect, it } from 'vitest'
import { backgrounds } from '../wallpaper/registry'
import {
  defaultRectFor,
  describeOverlayProblem,
  designsFor,
  frontFirstItems,
  itemLabel,
  moveDraft,
  newItemDraft,
  newOverlayDraft,
  overlayNameChoices,
  savableOverlayDrafts,
  schemaFor,
  textOptionsFor,
  toOverlayDrafts,
  toOverlays,
} from './form'
import type { Overlay } from './layout'

/** 右下に置いた時計1つだけを積んだ前面のオーバーレイ */
const front: Overlay = {
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
    for (const kind of ['alerts', 'sideSuper', 'focus', 'bgm', 'tab'] as const) expect(designsFor(kind)).toEqual([])
  })
})

describe('schemaFor', () => {
  it('壁紙はデザインのスキーマを返す', () => {
    expect(schemaFor('wallpaper', 'contour')).toHaveProperty('color')
  })

  it('サイドスーパーは寄せる向きのスキーマを返す', () => {
    expect(schemaFor('sideSuper', '')).toHaveProperty('position')
  })

  it('アラート・注目コメント・再生中の曲・タブの映像は、配信者が決めるパラメータを持たない', () => {
    expect(schemaFor('alerts', '')).toEqual({})
    expect(schemaFor('focus', '')).toEqual({})
    expect(schemaFor('bgm', '')).toEqual({})
    expect(schemaFor('tab', '')).toEqual({})
  })

  it('レジストリに無いデザインでは undefined を返す（既定のスキーマへ黙って倒さない）', () => {
    expect(schemaFor('clock', 'sundial')).toBeUndefined()
  })
})

describe('テキストの素材', () => {
  it('映すテキストのIDをパラメータに持ち、追加したばかりのときは選んでいない（枠は板、あふれは隠す）', () => {
    const draft = newItemDraft('text', '')

    expect(draft.values).toEqual({ text: '', frame: 'board', overflow: 'clip' })
    expect(toOverlays([{ ...newOverlayDraft('front'), items: [{ ...draft, values: { ...draft.values, text: '3' } }] }])[0]?.items[0]?.params).toBe('text=3')
  })
})

describe('textOptionsFor', () => {
  const texts = [
    { id: 1, name: '目標' },
    { id: 3, name: '今やってること' },
  ]

  it('「選んでください」のあとに、テキストを名前で並べる（値はID）', () => {
    expect(textOptionsFor(texts, '')).toEqual([
      { value: '', label: '選んでください' },
      { value: '1', label: '目標' },
      { value: '3', label: '今やってること' },
    ])
  })

  it('選んでいるテキストが消されていたら、消されたことが分かる選択肢を残す（開いただけで別のテキストへ移らないように）', () => {
    expect(textOptionsFor(texts, '7')).toEqual([
      { value: '', label: '選んでください' },
      { value: '1', label: '目標' },
      { value: '3', label: '今やってること' },
      { value: '7', label: '消されたテキスト（ID 7）' },
    ])
  })
})

describe('defaultRectFor', () => {
  it('配信画面と同じ大きさで使う素材（背景・アラート・サイドスーパー・注目コメント・再生中の曲・タブの映像）はオーバーレイいっぱいにする', () => {
    const full = { x: '0', y: '0', width: '100', height: '100' }

    expect(defaultRectFor('wallpaper')).toEqual(full)
    expect(defaultRectFor('alerts')).toEqual(full)
    expect(defaultRectFor('sideSuper')).toEqual(full)
    expect(defaultRectFor('focus')).toEqual(full)
    expect(defaultRectFor('bgm')).toEqual(full)
    expect(defaultRectFor('tab')).toEqual(full)
  })

  it('小さく置く素材は、推奨の大きさ（時計は600×240px・チャットは480×800px）を割合にする', () => {
    // 1920×1080 に対する割合。0.1％まで丸める（入力欄に長い小数を残さないため）
    expect(defaultRectFor('clock')).toEqual({ x: '0', y: '0', width: '31.3', height: '22.2' })
    expect(defaultRectFor('chat')).toEqual({ x: '0', y: '0', width: '25', height: '74.1' })
  })

  it('ワイプは推奨の大きさ（480×460px）で、配信画面の右上から始める（番組のワイプが出る場所のため）', () => {
    expect(defaultRectFor('wipe')).toEqual({ x: '75', y: '0', width: '25', height: '42.6' })
  })
})

describe('newItemDraft・newOverlayDraft', () => {
  it('素材は、その種類の推奨の大きさとパラメータの既定値で作る', () => {
    const draft = newItemDraft('wallpaper', 'contour')

    expect(draft).toMatchObject({ kind: 'wallpaper', id: 'contour', rect: defaultRectFor('wallpaper') })
    expect(draft.values).toMatchObject({ color: '#9bc1bc' })
    expect(draft.problem).toBeUndefined()
  })

  it('小さく置く種類の素材は、オーバーレイいっぱいにせず推奨の大きさで作る', () => {
    expect(newItemDraft('chat', 'plain').rect).toEqual(defaultRectFor('chat'))
    expect(newItemDraft('chat', 'plain').rect).not.toEqual(defaultRectFor('wallpaper'))
  })

  it('追加したばかりのオーバーレイは素材を持たない', () => {
    expect(newOverlayDraft('talk')).toMatchObject({ name: 'talk', items: [] })
  })

  it('素材とオーバーレイには、1つずつ別の識別子を振る（並べ替えても入力欄を作り直さないため）', () => {
    expect(newItemDraft('alerts', '').key).not.toBe(newItemDraft('alerts', '').key)
    expect(newOverlayDraft('talk').key).not.toBe(newOverlayDraft('talk').key)
  })
})

describe('toOverlayDrafts', () => {
  it('保存済みのオーバーレイと素材を、入力欄の値に読み替える', () => {
    const [overlay] = toOverlayDrafts([front])
    const item = overlay?.items[0]

    expect(overlay).toMatchObject({ name: 'front' })
    expect(item).toMatchObject({ kind: 'clock', id: 'analog' })
    expect(item?.rect).toEqual({ x: '78', y: '70', width: '20', height: '26' })
    expect(item?.values).toMatchObject({ size: 0.5 })
  })

  it('読み込んだ素材にも、1件ずつ別の識別子を振る', () => {
    const [overlay] = toOverlayDrafts([{ name: 'front', items: [...front.items, ...front.items] }])

    expect(new Set(overlay?.items.map((item) => item.key)).size).toBe(2)
  })

  it('読めないパラメータは黙って捨てず、理由を添えて既定値で編集させる', () => {
    // 文字盤の大きさは 0.1〜1 の倍率なので、範囲の外は読めない
    const [overlay] = toOverlayDrafts([{ name: 'front', items: [{ ...front.items[0]!, params: 'size=200' }] }])

    expect(overlay?.items[0]?.problem).toMatch(/size/)
    expect(overlay?.items[0]?.values).toMatchObject({ size: schemaFor('clock', 'analog')?.size?.default })
  })

  it('レジストリに無いデザインでも、素材を捨てずに理由を添える（保存で消えないようにする）', () => {
    const [overlay] = toOverlayDrafts([{ name: 'front', items: [{ ...front.items[0]!, id: 'sundial' }] }])

    expect(overlay?.items[0]).toMatchObject({ kind: 'clock', id: 'sundial' })
    expect(overlay?.items[0]?.problem).toMatch(/sundial/)
  })
})

describe('toOverlays', () => {
  it('入力欄の値を、保存する形（パラメータはクエリ文字列）に直す', () => {
    const [overlay] = toOverlayDrafts([front])
    if (!overlay) throw new Error('読み替えたオーバーレイがありません')

    expect(toOverlays([overlay])).toEqual([front])
  })

  it('既定値のままのパラメータは書かない（構成を短く保つ）', () => {
    const material = { ...newItemDraft('clock', 'analog') }
    const draftOverlay = { ...newOverlayDraft('front'), items: [material] }

    expect(toOverlays([draftOverlay])[0]?.items[0]?.params).toBe('')
  })

  it('位置と大きさの空欄は 0 に丸めず NaN にする（範囲の検証はWorkerだけが持つ）', () => {
    const material = { ...newItemDraft('clock', 'analog'), rect: { x: '', y: '0', width: '20', height: '26' } }
    const draftOverlay = { ...newOverlayDraft('front'), items: [material] }

    expect(toOverlays([draftOverlay])[0]?.items[0]?.rect.x).toBeNaN()
  })

  it('レジストリに無いデザインの素材は、保存済みのパラメータをそのまま持ち越す', () => {
    const [overlay] = toOverlayDrafts([{ name: 'front', items: [{ ...front.items[0]!, id: 'sundial' }] }])
    if (!overlay) throw new Error('読み替えたオーバーレイがありません')

    expect(toOverlays([overlay])[0]?.items[0]).toMatchObject({ id: 'sundial', params: 'size=0.5' })
  })
})

describe('savableOverlayDrafts', () => {
  it('素材を1つも持たないオーバーレイは送らない（貼っても何も映らないURLを作らせないため、Workerが拒む）', () => {
    const emptyOverlay = newOverlayDraft('talk')
    const [overlay] = toOverlayDrafts([front])
    if (!overlay) throw new Error('読み替えたオーバーレイがありません')

    expect(savableOverlayDrafts([overlay, emptyOverlay]).map((draft) => draft.name)).toEqual(['front'])
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
  const name = [{ name: 'back', items: ['背景（Contour）'] }, { name: 'front', items: ['時計（Analog）', 'アラート'] }]

  it('素材の位置を、オーバーレイの名前と素材の名前に読み替える', () => {
    expect(describeOverlayProblem('overlays[1].items[0].rect.width: 1〜100 の数（％）で指定してください', name)).toBe(
      '「front」の「時計（Analog）」の 幅: 1〜100 の数（％）で指定してください',
    )
  })

  it('オーバーレイそのものへの問題点は、名前だけを添える', () => {
    expect(describeOverlayProblem('overlays[0].name: オーバーレイの名前は…', name)).toBe('「back」の 名前: オーバーレイの名前は…')
  })

  it('名前が足りなければ番号のままにする', () => {
    expect(describeOverlayProblem('overlays[5].items[2].kind: …', name)).toBe('6番目のオーバーレイの 3番目の素材の 種類: …')
  })

  it('構成そのものへの問題点（overlays: …）はそのまま出す', () => {
    expect(describeOverlayProblem('overlays: オーバーレイは10個以内にしてください', name)).toBe('overlays: オーバーレイは10個以内にしてください')
  })
})

describe('moveDraft', () => {
  const order = ['背面', '中間', '前面'] as const

  it('指定した位置の1件を、offset だけずらした並びを返す', () => {
    expect(moveDraft(order, 0, 1)).toEqual(['中間', '背面', '前面'])
    expect(moveDraft(order, 2, -1)).toEqual(['背面', '前面', '中間'])
  })

  it('元の並びは変えない（画面が作り直した並びを持つ）', () => {
    moveDraft(order, 0, 1)
    expect(order).toEqual(['背面', '中間', '前面'])
  })

  it('並びの外へ動かそうとしたら、並びを変えずに返す', () => {
    expect(moveDraft(order, 0, -1)).toEqual(['背面', '中間', '前面'])
    expect(moveDraft(order, 2, 1)).toEqual(['背面', '中間', '前面'])
  })

  it('動かす1件の位置そのものが並びの外なら、並びを変えずに返す', () => {
    // 負の位置は末尾から数えられてしまうので、動かす前に確かめる（別の素材が動いてはならない）
    expect(moveDraft(order, -1, 1)).toEqual(['背面', '中間', '前面'])
    expect(moveDraft(order, 3, -1)).toEqual(['背面', '中間', '前面'])
  })
})

describe('frontFirstItems', () => {
  const background = newItemDraft('wallpaper', 'contour')
  const clock = newItemDraft('clock', 'analog')

  it('重ねる順（あとのものが前）を、前面から並べた形にして返す', () => {
    expect(frontFirstItems([background, clock])).toEqual([
      { item: clock, position: 1 },
      { item: background, position: 0 },
    ])
  })
})
