/**
 * オーバーレイと素材の編集の値の変換（管理画面とWorkerのあいだ）
 *
 * 画面（overlay-page.tsx）は入力欄の中身をそのまま持ち、保存するときにここで構成の形へ直す
 * （src/admin/form.ts・src/speech/form.ts と同じ分け方）。素材の種類ごとのパラメータ宣言（スキーマ）も、
 * レジストリを引くのはここだけにする。
 *
 * 用語: **オーバーレイ**はOBSのブラウザソース1つ（＝重なりの1枚）で、その中に**素材**（壁紙・時計・
 * チャットなど）を積む。素材の並びがそのまま重ねる順（あとのものが前）になる。
 *
 * 注意: 値の検証は Worker（worker/overlay-layout.ts）だけが持ち、画面とWorkerで二重に持たない（issue #86）。
 * そのため位置と大きさの空欄は 0 に丸めず NaN のまま渡し、Worker に理由を返させる。
 * 注意: 読めないパラメータやレジストリに無いデザインでも、その素材を黙って捨てない（保存したときに
 * 消えてしまうため）。理由を添えて編集させ、画面がそれを出す（Fail-Fast）。
 */
import { chats } from '../chat/registry'
import { clocks } from '../clock/registry'
import type { GalleryItem } from '../core/gallery/gallery'
import { serializeParams } from '../core/gallery/url'
import { ParamError, parseParams, type AnyParamValue, type ParamSchema } from '../core/params'
import { sideSuperParamSchema } from '../side-super/params'
import { backgrounds } from '../wallpaper/registry'
import { roundPercent } from './drag'
import { DEFAULT_OVERLAY_NAMES, RECOMMENDED_ITEM_SIZES, STAGE_SIZE, type ItemKind, type Overlay } from './layout'

/** 素材の種類の、画面に出す名前。worker/ の型は読み込めないのでここで持ち直す（src/admin/form.ts と同じ扱い） */
export const ITEM_KIND_LABELS: Readonly<Record<ItemKind, string>> = {
  wallpaper: '背景',
  clock: '時計',
  chat: 'チャットボックス',
  alerts: 'アラート',
  sideSuper: 'サイドスーパー',
  focus: '注目コメント',
}

/** Workerが返す問題点に出る項目の名前を、画面の言い方にする */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: '名前',
  items: '素材',
  kind: '種類',
  id: 'デザイン',
  params: 'パラメータ',
  rect: '位置と大きさ',
  'rect.x': '左端の位置',
  'rect.y': '上端の位置',
  'rect.width': '幅',
  'rect.height': '高さ',
}

/** 種類ごとのデザインの一覧（レジストリ）。デザインIDを持たない種類は空 */
const DESIGNS: Readonly<Record<ItemKind, readonly GalleryItem[]>> = {
  wallpaper: backgrounds,
  clock: clocks,
  chat: chats,
  alerts: [],
  sideSuper: [],
  focus: [],
}

/**
 * 新しい素材の位置と大きさ。
 *
 * 大きさは、その種類の推奨の大きさ（layout.ts の RECOMMENDED_ITEM_SIZES）を配信画面に対する割合へ
 * 直したものにする。すべてをオーバーレイいっぱいで足すと、時計やチャットボックスが配信画面ぜんたいへ
 * 引き伸ばされた状態から毎回縮めることになる（ギャラリーで確かめた大きさとも食い違う）。
 * 置き場所だけは決められないので左上（0・0）から始め、配置用の枠でつまんで動かしてもらう。
 */
export const defaultRectFor = (kind: ItemKind): RectDraft => {
  const size = RECOMMENDED_ITEM_SIZES[kind]
  return {
    x: '0',
    y: '0',
    width: String(roundPercent((size.width / STAGE_SIZE.width) * 100)),
    height: String(roundPercent((size.height / STAGE_SIZE.height) * 100)),
  }
}

/**
 * 画面が素材とオーバーレイを見分けるための識別子を採番する。
 *
 * 構成には保存しない（並びで表す）が、画面では並べ替えても入力欄を作り直さないために要る。
 * 位置を React の key にすると、並べ替え・外したときに入力欄が別の素材のものとして使い回され、
 * 入力欄が覚えている内容（透過にする前の色）が混ざる。
 */
let nextKey = 0

/** 位置と大きさの入力欄の中身（文字のまま持ち、保存するときに数へ直す） */
export interface RectDraft {
  readonly x: string
  readonly y: string
  readonly width: string
  readonly height: string
}

/** 素材1つの入力欄の中身 */
export interface ItemDraft {
  /** 画面がこの素材を見分けるための識別子（構成には保存しない） */
  readonly key: number
  readonly kind: ItemKind
  /** デザインID（デザインIDを持たない種類では空文字） */
  readonly id: string
  /** パラメータの値（デザインのスキーマの名前ごと） */
  readonly values: Readonly<Record<string, AnyParamValue>>
  /** 保存されていたパラメータ（クエリ文字列）。スキーマが分からない素材ではこれをそのまま持ち越す */
  readonly savedParams: string
  readonly rect: RectDraft
  /** 保存済みの値を読めなかった理由（読めた素材では undefined） */
  readonly problem?: string
}

/** オーバーレイ1つ（＝OBSのブラウザソース1つ）の入力欄の中身 */
export interface OverlayDraft {
  /** 画面がこのオーバーレイを見分けるための識別子（構成には保存しない） */
  readonly key: number
  /** 名前。OBSに貼るURL（?overlay=）に載る */
  readonly name: string
  /** 積む素材（並びがそのまま重ねる順） */
  readonly items: readonly ItemDraft[]
}

/** 一覧に並べる素材1件と、その素材が構成で占めている位置（並べ替え・外すときに使う） */
export interface ItemSlot {
  readonly item: ItemDraft
  /** 構成での位置（0が最も背面） */
  readonly position: number
}

/**
 * 素材を、前に出るものから並べた形にする。
 *
 * 構成では「あとのものが前」だが、画面では上にあるものが前に見えるほうが分かりやすいので、一覧では
 * 並びを逆にして出す（OBSのソース一覧も上にあるものが前である）。保存の形は変えないので、構成での
 * 位置を添えて返し、並べ替えと外す操作はその位置で行う。
 */
export const frontFirstItems = (items: readonly ItemDraft[]): ItemSlot[] =>
  items.map((item, position) => ({ item, position })).reverse()

/**
 * 並びの中の1件を offset だけずらした、新しい並びを返す。
 *
 * オーバーレイの並べ替えと、素材の重ねる順の入れ替えで使う。並びの外へ出る動かし方（端の素材を
 * さらに外へ）では、切り取った1件が別の場所へ回り込まないように並びを変えずに返す。動かす1件の位置
 * そのものが並びの外のときも同じく何も動かさない（負の位置は末尾から数えられるため、確かめずに
 * 切り取ると別の素材が動く）。
 */
export const moveDraft = <T>(list: readonly T[], position: number, offset: number): T[] => {
  const to = position + offset
  if (position < 0 || position >= list.length) return [...list]
  if (to < 0 || to >= list.length) return [...list]
  const moved = [...list]
  const [target] = moved.splice(position, 1)
  if (target === undefined) return [...list]
  moved.splice(to, 0, target)
  return moved
}

/** 問題点の位置を読み替えるための、送った順の名前 */
export interface OverlayLabels {
  readonly name: string
  readonly items: readonly string[]
}

/** 入力欄の文字を数にする。空欄や数として読めない文字は NaN（Workerが理由を返す。src/speech/form.ts と同じ） */
const numberOf = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw))

/** その種類で選べるデザイン（デザインIDを持たない種類では空） */
export const designsFor = (kind: ItemKind): readonly GalleryItem[] => DESIGNS[kind]

/**
 * その素材のパラメータ宣言。
 *
 * @returns スキーマ（パラメータを持たない種類では空のスキーマ）。レジストリに無いデザインでは undefined
 */
export const schemaFor = (kind: ItemKind, id: string): ParamSchema | undefined => {
  if (kind === 'sideSuper') return sideSuperParamSchema
  const designs = designsFor(kind)
  // アラートと注目コメントは配信者が決めるパラメータを持たない（取り上げる相手も設定はWorkerが持つ）
  if (designs.length === 0) return {}
  return designs.find((design) => design.id === id)?.schema
}

/** スキーマの既定値をすべて並べた、パラメータの初期値 */
const defaultValuesOf = (schema: ParamSchema): Record<string, AnyParamValue> =>
  Object.fromEntries(Object.entries(schema).map(([name, spec]) => [name, spec.default]))

/** 足したばかりの素材の入力欄の中身。パラメータは既定値、大きさはその種類の推奨の大きさにする */
export const newItemDraft = (kind: ItemKind, id: string): ItemDraft => {
  const schema = schemaFor(kind, id)
  return {
    key: nextKey++,
    kind,
    id,
    values: schema ? defaultValuesOf(schema) : {},
    savedParams: '',
    rect: defaultRectFor(kind),
  }
}

/** 足したばかりのオーバーレイの入力欄の中身。素材はまだ持たない */
export const newOverlayDraft = (name: string): OverlayDraft => ({ key: nextKey++, name, items: [] })

/** 保存済みの素材1件を、入力欄の中身に読み替える */
const toItemDraft = (item: Overlay['items'][number]): ItemDraft => {
  const base = {
    key: nextKey++,
    kind: item.kind,
    id: item.id,
    savedParams: item.params,
    rect: { x: String(item.rect.x), y: String(item.rect.y), width: String(item.rect.width), height: String(item.rect.height) },
  }
  const schema = schemaFor(item.kind, item.id)
  if (!schema) {
    return {
      ...base,
      values: {},
      problem: `デザイン「${item.id}」は登録されていません（デザインを選び直すか、この素材を外してください）`,
    }
  }
  try {
    return { ...base, values: parseParams(schema, new URLSearchParams(item.params)) }
  } catch (error) {
    // 読めないパラメータは既定値で編集させる（黙って捨てると、保存したときに設定が消える）
    return {
      ...base,
      values: defaultValuesOf(schema),
      problem: `保存されているパラメータを読めないので、既定値にしています（${error instanceof ParamError ? error.problems.join('・') : String(error)}）`,
    }
  }
}

/** 保存済みの構成を、入力欄の中身に読み替える（並びは保存された順＝重ねる順のまま） */
export const toOverlayDrafts = (overlays: readonly Overlay[]): OverlayDraft[] =>
  overlays.map((overlay) => ({ key: nextKey++, name: overlay.name, items: overlay.items.map(toItemDraft) }))

/**
 * Workerへ送るオーバーレイだけを取り出す。
 *
 * 素材を1つも持たないオーバーレイは送らない（Workerが拒む。OBSに貼っても何も映らないURLを作らせないため）。
 * 画面では名前を覚えておき、素材を置いたら保存されるようにする（「効果をひとつも持たない行は保存しない」と
 * 同じ考え方）。問題点の位置を読み替える名前も、ここで絞った並びから作る。
 */
export const savableOverlayDrafts = (drafts: readonly OverlayDraft[]): OverlayDraft[] => drafts.filter((draft) => draft.items.length > 0)

/** 入力欄の中身を、保存する形（パラメータはクエリ文字列、位置と大きさは数）に直す */
export const toOverlays = (drafts: readonly OverlayDraft[]): Overlay[] =>
  drafts.map((draft) => ({
    name: draft.name,
    items: draft.items.map((item) => {
      const schema = schemaFor(item.kind, item.id)
      return {
        kind: item.kind,
        id: item.id,
        // スキーマが分からない素材（レジストリに無いデザイン）は、保存されていたパラメータをそのまま持ち越す
        params: schema ? serializeParams(schema, item.values) : item.savedParams,
        rect: {
          x: numberOf(item.rect.x),
          y: numberOf(item.rect.y),
          width: numberOf(item.rect.width),
          height: numberOf(item.rect.height),
        },
      }
    }),
  }))

/** 素材を一覧の見出しや問題点で指す名前。デザインを持つ種類にはデザイン名を添える */
export const itemLabel = (draft: ItemDraft): string => {
  const kindLabel = ITEM_KIND_LABELS[draft.kind]
  const designs = designsFor(draft.kind)
  if (designs.length === 0) return kindLabel
  // レジストリに無いデザインは、保存されているIDをそのまま出す（どの素材の話か分かるようにする）
  const title = designs.find((design) => design.id === draft.id)?.title ?? draft.id
  return `${kindLabel}（${title}）`
}

/** 問題点の位置を読み替えるための、送った順の名前を作る */
export const overlayLabelsOf = (drafts: readonly OverlayDraft[]): OverlayLabels[] =>
  drafts.map((draft) => ({ name: draft.name, items: draft.items.map(itemLabel) }))

/**
 * 素材を置くオーバーレイの選択肢。既定の2つと、いま構成にある名前を重複なく並べる。
 *
 * 選択欄から選ばせるのは、名前がOBSに貼るURLに載るためである（手で打つと、打ち間違いに気づくのが
 * 「配信中に何も映らなかったとき」になる）。新しい名前は「オーバーレイを足す」だけで作る。
 */
export const overlayNameChoices = (drafts: readonly OverlayDraft[]): string[] => [
  ...new Set([...DEFAULT_OVERLAY_NAMES, ...drafts.map((draft) => draft.name)]),
]

/** Workerが問題点の先頭に付ける位置（overlays[0].items[1].rect.width の形。番号は0始まり） */
const PROBLEM_POSITION = /^overlays\[(\d+)\]\.(?:items\[(\d+)\]\.)?([A-Za-z.]+)(?=:)/

/**
 * Workerが返した問題点の位置を、画面で分かる呼び名に読み替える。
 *
 * 「何番目のオーバーレイの何番目の素材」では場所が伝わらないので、送った順の名前を受け取って添える
 * （src/admin/form.ts の describeProblem と同じ考え方）。
 *
 * @param labels 送ったオーバーレイと素材の名前（送った順）。足りなければ番号のままにする
 */
export const describeOverlayProblem = (problem: string, labels: readonly OverlayLabels[]): string =>
  problem.replace(PROBLEM_POSITION, (_, overlayIndex: string, itemIndex: string | undefined, field: string) => {
    const overlay = labels[Number(overlayIndex)]
    const 位置 = overlay === undefined ? `${Number(overlayIndex) + 1}番目のオーバーレイの ` : `「${overlay.name}」の`
    const 項目 = FIELD_LABELS[field] ?? field
    if (itemIndex === undefined) return `${位置}${overlay === undefined ? '' : ' '}${項目}`
    const item = overlay?.items[Number(itemIndex)]
    const 素材 = item === undefined ? `${Number(itemIndex) + 1}番目の素材の ` : `「${item}」の `
    return `${位置}${素材}${項目}`
  })
