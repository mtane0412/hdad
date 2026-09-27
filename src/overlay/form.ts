/**
 * レイヤーの編集の値の変換（管理画面とWorkerのあいだ）
 *
 * 画面（overlay-page.tsx）は入力欄の中身をそのまま持ち、保存するときにここで構成の形へ直す
 * （src/admin/form.ts・src/speech/form.ts と同じ分け方）。素材の種類ごとのパラメータ宣言（スキーマ）も、
 * レジストリを引くのはここだけにする。
 *
 * 注意: 値の検証は Worker（worker/overlay-layout.ts）だけが持ち、画面とWorkerで二重に持たない（issue #86）。
 * そのため位置と大きさの空欄は 0 に丸めず NaN のまま渡し、Worker に理由を返させる。
 * 注意: 読めないパラメータやレジストリに無いデザインでも、そのレイヤーを黙って捨てない（保存したときに
 * 消えてしまうため）。理由を添えて編集させ、画面がそれを出す（Fail-Fast）。
 */
import { chats } from '../chat/registry'
import { clocks } from '../clock/registry'
import type { GalleryItem } from '../core/gallery/gallery'
import { serializeParams } from '../core/gallery/url'
import { ParamError, parseParams, type AnyParamValue, type ParamSchema } from '../core/params'
import { sideSuperParamSchema } from '../side-super/params'
import { backgrounds } from '../wallpaper/registry'
import { DEFAULT_OVERLAY_GROUPS, type LayerKind, type OverlayLayer } from './layout'

/** 素材の種類の、画面に出す名前。worker/ の型は読み込めないのでここで持ち直す（src/admin/form.ts と同じ扱い） */
export const LAYER_KIND_LABELS: Readonly<Record<LayerKind, string>> = {
  wallpaper: '背景',
  clock: '時計',
  chat: 'チャットボックス',
  alerts: 'アラート',
  sideSuper: 'サイドスーパー',
  focus: '注目コメント',
}

/** Workerが返す問題点に出る項目の名前を、画面の言い方にする */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  kind: '種類',
  id: 'デザイン',
  params: 'パラメータ',
  group: '段',
  rect: '位置と大きさ',
  'rect.x': '左端の位置',
  'rect.y': '上端の位置',
  'rect.width': '幅',
  'rect.height': '高さ',
}

/** 種類ごとのデザインの一覧（レジストリ）。デザインIDを持たない種類は空 */
const DESIGNS: Readonly<Record<LayerKind, readonly GalleryItem[]>> = {
  wallpaper: backgrounds,
  clock: clocks,
  chat: chats,
  alerts: [],
  sideSuper: [],
  focus: [],
}

/** 新しいレイヤーの位置と大きさ。段いっぱいに置いてから、必要なら数値を直してもらう */
export const DEFAULT_LAYER_RECT = { x: '0', y: '0', width: '100', height: '100' } as const

/** 位置と大きさの入力欄の中身（文字のまま持ち、保存するときに数へ直す） */
export interface RectDraft {
  readonly x: string
  readonly y: string
  readonly width: string
  readonly height: string
}

/** レイヤー1つの入力欄の中身 */
export interface LayerDraft {
  readonly kind: LayerKind
  /** デザインID（デザインIDを持たない種類では空文字） */
  readonly id: string
  /** パラメータの値（デザインのスキーマの名前ごと） */
  readonly values: Readonly<Record<string, AnyParamValue>>
  /** 保存されていたパラメータ（クエリ文字列）。スキーマが分からないレイヤーではこれをそのまま持ち越す */
  readonly savedParams: string
  readonly group: string
  readonly rect: RectDraft
  /** 保存済みの値を読めなかった理由（読めたレイヤーでは undefined） */
  readonly problem?: string
}

/** 入力欄の文字を数にする。空欄や数として読めない文字は NaN（Workerが理由を返す。src/speech/form.ts と同じ） */
const numberOf = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw))

/** その種類で選べるデザイン（デザインIDを持たない種類では空） */
export const designsFor = (kind: LayerKind): readonly GalleryItem[] => DESIGNS[kind]

/**
 * そのレイヤーのパラメータ宣言。
 *
 * @returns スキーマ（パラメータを持たない種類では空のスキーマ）。レジストリに無いデザインでは undefined
 */
export const schemaFor = (kind: LayerKind, id: string): ParamSchema | undefined => {
  if (kind === 'sideSuper') return sideSuperParamSchema
  const designs = designsFor(kind)
  // アラートと注目コメントは配信者が決めるパラメータを持たない（取り上げる相手も設定はWorkerが持つ）
  if (designs.length === 0) return {}
  return designs.find((design) => design.id === id)?.schema
}

/** スキーマの既定値をすべて並べた、パラメータの初期値 */
const defaultValuesOf = (schema: ParamSchema): Record<string, AnyParamValue> =>
  Object.fromEntries(Object.entries(schema).map(([name, spec]) => [name, spec.default]))

/** 足したばかりのレイヤーの入力欄の中身。パラメータは既定値、位置と大きさは段いっぱいにする */
export const newLayerDraft = (kind: LayerKind, id: string, group: string): LayerDraft => {
  const schema = schemaFor(kind, id)
  return {
    kind,
    id,
    values: schema ? defaultValuesOf(schema) : {},
    savedParams: '',
    group,
    rect: DEFAULT_LAYER_RECT,
  }
}

/** 保存済みのレイヤー1件を、入力欄の中身に読み替える */
const toLayerDraft = (layer: OverlayLayer): LayerDraft => {
  const base = {
    kind: layer.kind,
    id: layer.id,
    savedParams: layer.params,
    group: layer.group,
    rect: { x: String(layer.rect.x), y: String(layer.rect.y), width: String(layer.rect.width), height: String(layer.rect.height) },
  }
  const schema = schemaFor(layer.kind, layer.id)
  if (!schema) {
    return {
      ...base,
      values: {},
      problem: `デザイン「${layer.id}」は登録されていません（デザインを選び直すか、このレイヤーを外してください）`,
    }
  }
  try {
    return { ...base, values: parseParams(schema, new URLSearchParams(layer.params)) }
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
export const toLayerDrafts = (layers: readonly OverlayLayer[]): LayerDraft[] => layers.map(toLayerDraft)

/** 入力欄の中身を、保存する形（パラメータはクエリ文字列、位置と大きさは数）に直す */
export const toLayers = (drafts: readonly LayerDraft[]): OverlayLayer[] =>
  drafts.map((draft) => {
    const schema = schemaFor(draft.kind, draft.id)
    return {
      kind: draft.kind,
      id: draft.id,
      // スキーマが分からないレイヤー（レジストリに無いデザイン）は、保存されていたパラメータをそのまま持ち越す
      params: schema ? serializeParams(schema, draft.values) : draft.savedParams,
      group: draft.group,
      rect: {
        x: numberOf(draft.rect.x),
        y: numberOf(draft.rect.y),
        width: numberOf(draft.rect.width),
        height: numberOf(draft.rect.height),
      },
    }
  })

/** レイヤーを一覧の見出しや問題点で指す名前。デザインを持つ種類にはデザイン名を添える */
export const layerLabel = (draft: LayerDraft): string => {
  const kindLabel = LAYER_KIND_LABELS[draft.kind]
  const designs = designsFor(draft.kind)
  if (designs.length === 0) return kindLabel
  // レジストリに無いデザインは、保存されているIDをそのまま出す（どのレイヤーの話か分かるようにする）
  const title = designs.find((design) => design.id === draft.id)?.title ?? draft.id
  return `${kindLabel}（${title}）`
}

/**
 * 段の選択肢。既定の2つと、使われている段・配信者が足した段を重複なく並べる。
 *
 * 選択欄から選ばせるのは、段の名前がOBSに貼るURLに載るためである（手で打つと、打ち間違いに気づくのが
 * 「配信中に何も映らなかったとき」になる）。
 *
 * @param drafts いま編集しているレイヤー
 * @param added 配信者がこの画面で足した段の名前
 */
export const groupChoices = (drafts: readonly LayerDraft[], added: readonly string[]): string[] => [
  ...new Set([...DEFAULT_OVERLAY_GROUPS, ...drafts.map((draft) => draft.group), ...added]),
]

/** Workerが問題点の先頭に付ける位置（layers[0].rect.width の形。番号は0始まり） */
const PROBLEM_POSITION = /^layers\[(\d+)\]\.([A-Za-z.]+)(?=:)/

/**
 * Workerが返した問題点の位置を、画面で分かる呼び名に読み替える。
 *
 * 「何番目のレイヤー」では場所が伝わらないので、送った順のレイヤーの名前を受け取って添える
 * （src/admin/form.ts の describeProblem と同じ考え方）。
 *
 * @param labels 送ったレイヤーの名前（送った順）。足りなければ番号のままにする
 */
export const describeLayerProblem = (problem: string, labels: readonly string[]): string =>
  problem.replace(PROBLEM_POSITION, (_, index: string, field: string) => {
    const label = labels[Number(index)]
    const position = label === undefined ? `${Number(index) + 1}番目のレイヤーの ` : `「${label}」の `
    return `${position}${FIELD_LABELS[field] ?? field}`
  })
