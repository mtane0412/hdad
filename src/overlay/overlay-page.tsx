/**
 * 合成オーバーレイの構成のページ（オーバーレイと素材の編集、OBS用URL）
 *
 * OBSのブラウザソースはその数だけ Chromium のレンダラを立ち上げるため、素材を1枚のページ
 * （overlay/stage/index.html）へ重ね、ブラウザソースは「オーバーレイ」ごとに1つで済ませる（issue #101）。
 * その構成（どのオーバーレイにどの素材をどこへ置くか）を配信者が編集する口がこのページである（issue #103）。
 * 構成を持つのは Worker（KVの overlay-layout）なので、OBSのURLは貼り替えなくてよい。保存すると Worker が
 * 合成ページへ構成を押し出し、中身が変わったオーバーレイだけが読み込み直す（OBSで手で読み込み直さなくてよい）。
 *
 * 用語: **オーバーレイ**はOBSのブラウザソース1つ（＝重なりの1枚）で、その中に**素材**（壁紙・時計・
 * チャットなど）を積む。オーバーレイを複数に分けるのは、アバターやゲーム画面というWebでないソースが
 * 間に挟まり、Web側の素材をその前と後ろの両方に置きたいためである。
 *
 * オーバーレイはタブで1つずつ開き、左にレイヤー（素材）の一覧、右に表示領域を並べる（Canva のような編集の感覚を目指す）。
 * 素材の並びがそのまま重ねる順（あとのものが前）だが、レイヤーの一覧では並びを逆にして「前面 → 背面」で並べる
 * （OBSのソース一覧と同じく、上にあるものが前に出る）。オーバーレイ同士はタブの並びの中で並べ替えられる。
 * 素材の並べ替えは「前面へ」「背面へ」のボタンのほか、行の左端のつまみをドラッグして別の行へ落としても行える
 * （落とせるのは同じオーバーレイの中だけ。オーバーレイをまたぐ移動は「置くオーバーレイ」の選択欄で行う）。
 * 素材は行の目のアイコンで隠せる。保存済みの素材は保存ボタンを待たずにすぐ保存し、合成ページへ押し出す
 * （admin-api.ts の setVisibility。ほかの未保存の編集は巻き込まない）。
 * Workerの呼び出しは admin-api.ts、入力欄の値の変換とデザインのスキーマの引き当ては form.ts、
 * URLの組み立ては url.ts に分けてテストする。素材のパラメータの入力欄は、ギャラリーと同じ
 * 自動生成（src/core/fields.tsx の ParamField）を使う。
 *
 * 表示領域（StageEditor）は、合成ページのプレビューの上に透明な層を重ねたもので、その上で素材を選び、
 * ドラッグで動かし、選んだ素材の端をつまんで大きさを変え、矢印キーで少しずつ動かせる（issue #105 の配置用の枠と
 * issue #106 のプレビューを1つにまとめたもの）。レイヤーで選んだ素材は表示領域でも選ばれ、表示領域で選んだ素材は
 * レイヤーで設定が開く。数値入力も残してあり、ドラッグで置いた値はそのまま数値欄にも出る。
 * 画素から割合（％）への変換と四角の計算は drag.ts に分けてテストする。
 *
 * 注意: 値の検証は Worker（worker/overlay-layout.ts）だけが持つ。画面は空欄を 0 に丸めず、返ってきた
 * 問題点をオーバーレイと素材の名前へ読み替えて並べる（issue #86 で決めた「画面とWorkerで二重に持たない」）。
 * 注意: 素材を1つも持たないオーバーレイは送らない（Workerが拒む。OBSに貼っても何も映らないURLを
 * 作らせないため）。追加した名前は画面が覚えておき、素材を置いた時点で保存されるようにする。
 * 注意: 保存済みの値が読めない素材（レジストリに無いデザイン・範囲外のパラメータ）でも黙って捨てない。
 * 捨てると、開いて保存しただけでその素材が消える。理由を出して直させる（Fail-Fast）。
 * プレビューの中身は合成ページそのままの描画だが、素材のデータはすべてサンプルにして外へつながない。映す構成は
 * Worker からではなく、この画面から postMessage で渡す（preview.ts）ので、保存しなくても編集中のものが映る。
 * 位置と大きさだけの編集では、プレビューは作り直さずに箱だけを動かす（ドラッグしながら中身を見られる）。
 *
 * 注意: 吸着（グリッド・他の素材の端に合わせる）は入れていない。
 * 注意: テキストの素材（issue #294）が映すテキストはパラメータにIDで持つが、IDの入力欄は出さず、テキストの名前の選択欄で選ばせる
 *   （docs/principles.md の2）。そのため開いたときにテキストの一覧も読み、読めなければ選択欄の代わりに理由を出す。
 */
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, Copy, Eye, EyeOff, GripVertical, Plus, Trash2 } from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Link, useUnsavedChanges } from '@/app/router'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError } from '../core/api'
import { iconButtonName } from '../core/icon-button'
import { ParamField } from '../core/fields'
import { Preview } from '../core/preview'
import type { AnyParamValue, ParamSpec } from '../core/params'
import type { TextApi } from '../text/api'
import { textParamSchema } from '../text/params'
import type { OverlayLayoutAdminApi } from './admin-api'
import { deltaPercent, dragRect, HANDLE_LABELS, rectNumbersOf, RESIZE_HANDLES, toRectDraft, type DragHandle, type RectNumbers } from './drag'
import {
  describeOverlayProblem,
  designsFor,
  frontFirstItems,
  savedVisibilityTarget,
  withDraftHidden,
  itemLabel,
  ITEM_KIND_LABELS,
  moveDraft,
  newItemDraft,
  newOverlayDraft,
  overlayLabelsOf,
  overlayNameChoices,
  savableOverlayDrafts,
  schemaFor,
  textOptionsFor,
  toOverlayDrafts,
  toOverlays,
  type ItemDraft,
  type OverlayDraft,
  type OverlayLabels,
  type RectDraft,
} from './form'
import { ITEM_KINDS, STAGE_SIZE, rectStyle, type ItemKind } from './layout'
import { previewLayoutMessage, replyPreviewLayout, type PreviewTarget } from './preview'
import { overlayPreviewUrl, overlayStageUrl, overlayStageUrlOutline } from './url'

/**
 * 位置と大きさの入力欄（％）。並べる順と見出しをここで決める。
 *
 * 画面に出すのは短い見出し（`short`）だけにし、単位はまとめの見出し（％）へ1度だけ出す。読み上げには
 * どこの値かまで含む `label` を渡す（見えている文字を含む名前にするため、`short` は `label` の一部にする）。
 */
const RECT_FIELDS: readonly { key: keyof RectDraft; short: string; label: string }[] = [
  { key: 'x', short: '左', label: '左端の位置（％）' },
  { key: 'y', short: '上', label: '上端の位置（％）' },
  { key: 'width', short: '幅', label: '幅（％）' },
  { key: 'height', short: '高さ', label: '高さ（％）' },
]

/**
 * テキストの素材の選択欄に並べるテキスト。読み込み中・読めなかった（理由を添える）・読めた（名前とID）のどれか。
 */
type TextChoices =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'ready'; readonly texts: readonly { id: number; name: string }[] }

/** 素材の枠の見た目（/triggers/ の項目の枠と同じ扱い。カードの中にカードを並べて見せない） */
const ITEM_BOX = 'overflow-hidden rounded-lg border'

/** 失敗を画面に出す行にする。設定の問題点は、送った順のオーバーレイと素材の名前へ読み替えて1行ずつ並べる */
const failureLines = (error: unknown, labels: readonly OverlayLabels[]): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? [
        'オーバーレイの構成に問題があります。直してから保存し直してください',
        ...error.problems.map((problem) => `・${describeOverlayProblem(problem, labels)}`),
      ]
    : [errorMessage(error)]

/** その素材がどこに置かれているかの要約（見出しに出す） */
const rectSummary = (draft: ItemDraft): string => `左${draft.rect.x}% 上${draft.rect.y}% 幅${draft.rect.width}% 高さ${draft.rect.height}%`

/**
 * 表示領域に描く、つまみの置き場所（四角の角と端）。
 *
 * 四角の辺の上に半分はみ出させて置く（端そのものをつまめるようにするため）。マウスの形も方向に合わせる。
 */
const HANDLE_STYLES: Readonly<Record<Exclude<DragHandle, 'move'>, string>> = {
  nw: 'left-0 top-0 cursor-nwse-resize',
  n: 'left-1/2 top-0 cursor-ns-resize',
  ne: 'left-full top-0 cursor-nesw-resize',
  w: 'left-0 top-1/2 cursor-ew-resize',
  e: 'left-full top-1/2 cursor-ew-resize',
  sw: 'left-0 top-full cursor-nesw-resize',
  s: 'left-1/2 top-full cursor-ns-resize',
  se: 'left-full top-full cursor-nwse-resize',
}

/** 矢印キーで動かす量（％）。0.1％は配信画面の幅1920pxで約2px。Shift を押しながらなら大きく動かす */
const NUDGE_PERCENT = 0.1
const NUDGE_PERCENT_LARGE = 1

/** 矢印キーごとの動く向き */
const NUDGE_DIRECTIONS: Readonly<Record<string, { x: number; y: number }>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

/** ドラッグ中の素材。つまんだ時点の四角と位置から計算するので、丸めの誤差が積み上がらない */
interface ActiveDrag {
  readonly pointerId: number
  readonly itemKey: number
  readonly handle: DragHandle
  readonly start: RectNumbers
  readonly originX: number
  readonly originY: number
  /** つまんだ時点の表示領域の大きさ（画素）。画素を割合（％）へ直すのに使う */
  readonly width: number
  readonly height: number
}

interface StageEditorProps {
  draft: OverlayDraft
  /** 選んでいる素材（レイヤーの一覧で設定を開いている素材と同じ） */
  selectedItemKey: number | undefined
  onSelectItem(key: number | undefined): void
  onChangeRect(key: number, rect: RectDraft): void
}

/**
 * 表示領域。合成ページのプレビューの上に透明な層を重ね、その上で素材を選び、動かし、大きさを変える。
 *
 * プレビューは合成ページ（overlay/stage/）そのままの描画で、素材の中身はすべてサンプルにする（?demo=true）。
 * 匿名IRC・アラートのWebSocket・ポーリングをどれもつながないので、配信中のものに加えてもう1組動くことがない。
 * 映すのは編集中の構成で、Worker からは読ませない（保存はその時点で配信画面へ反映されるため）。
 * 渡し方は preview.ts の postMessage で、プレビューから「構成を待っている」と知らせてきたら返し、
 * そのあとの編集は同じ相手へ送り直す。位置と大きさだけの変化ならプレビューは箱を動かすだけなので、
 * ドラッグしながら中身を見られる（それ以外の変化ではプレビューが自分で読み込み直す）。
 *
 * つまみは選んでいる素材にだけ出し、選んでいる素材は前に重なっている素材より上に描く（後ろにある素材も
 * レイヤーの一覧で選べばそのまま動かせるようにするため）。
 *
 * 注意: つまんだら既定の動き（文字の選択・ブラウザのドラッグ）を止め、層がポインタを捕まえる。止めないと
 * ブラウザがドラッグを引き取ってポインタを取り消し（pointercancel）、少し動かしただけで手から離れる。
 * 捕まえるのは、プレビューの iframe の上や画面の外へポインタが出ても追い続けるためでもある。
 * 注意: 開いているプレビューは常に1つだけである（開いているタブのオーバーレイだけを描く）。重なりの1枚を
 * 丸ごと動かすので同時に何枚も動かさないためで、これにより「構成を待っている」知らせに答える相手も
 * 1つに定まる。
 * 注意: 位置と大きさを数として読めない素材は描かず、プレビューにも渡さない（渡すと合成ページ側が構成
 * そのものを読めないものとして扱う）。読めない値からドラッグを始めると、つまんだ時点の四角も決まらない。
 * 注意: 吸着（グリッド・他の素材の端に合わせる）は入れていない。
 */
const StageEditor = ({ draft, selectedItemKey, onSelectItem, onChangeRect }: StageEditorProps) => {
  const layerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<ActiveDrag>(undefined)
  /** 構成を渡したプレビューの窓。編集が進んだら同じ相手へ送り直す（まだ知らせが無ければ undefined） */
  const previewRef = useRef<PreviewTarget>(undefined)

  const drawable = draft.items.flatMap((item) => {
    const rect = rectNumbersOf(item.rect)
    return rect === undefined ? [] : [{ item, rect }]
  })
  const overlays = toOverlays([{ ...draft, items: drawable.map(({ item }) => item) }])
  /** いま渡す構成。知らせが届いた時点の最新を渡すため、描くたびに更新する */
  const overlaysRef = useRef(overlays)
  useEffect(() => {
    overlaysRef.current = overlays
  })

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const target = replyPreviewLayout(event, window.location.origin, overlaysRef.current)
      if (target !== undefined) previewRef.current = target
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // 編集が進んだら、知らせてきたプレビューへ送り直す（渡す構成に JSON にできない値は無いので、そのまま印にできる）
  const serialized = JSON.stringify(overlays)
  useEffect(() => {
    previewRef.current?.postMessage(previewLayoutMessage(overlaysRef.current), window.location.origin)
  }, [serialized])

  const startDrag = (item: ItemDraft, handle: DragHandle, event: ReactPointerEvent): void => {
    // 既定の動き（文字の選択・ブラウザのドラッグ）を始めさせない。何もないところを押した扱い（選択を外す）にもしない
    event.preventDefault()
    event.stopPropagation()
    onSelectItem(item.key)
    const layer = layerRef.current
    const start = rectNumbersOf(item.rect)
    if (layer === null || start === undefined) return
    // 既定の動きを止めるとフォーカスも移らないので、矢印キーで動かせるよう層へ移す
    layer.focus({ preventScroll: true })
    layer.setPointerCapture(event.pointerId)
    const size = layer.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      itemKey: item.key,
      handle,
      start,
      originX: event.clientX,
      originY: event.clientY,
      width: size.width,
      height: size.height,
    }
  }

  const moveDrag = (event: ReactPointerEvent): void => {
    const drag = dragRef.current
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    const { dx, dy } = deltaPercent(event.clientX - drag.originX, event.clientY - drag.originY, drag.width, drag.height)
    onChangeRect(drag.itemKey, toRectDraft(dragRect(drag.start, drag.handle, dx, dy)))
  }

  /** 指が離れた・取り消された・捕まえが外れたら追うのをやめる */
  const endDrag = (event: ReactPointerEvent): void => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = undefined
  }

  /** 選んでいる素材を矢印キーで動かす（数値欄で打つより速く、マウスより細かく合わせられる） */
  const nudge = (event: ReactKeyboardEvent): void => {
    const direction = NUDGE_DIRECTIONS[event.key]
    const selected = draft.items.find((item) => item.key === selectedItemKey)
    const start = selected === undefined ? undefined : rectNumbersOf(selected.rect)
    if (direction === undefined || selected === undefined || start === undefined) return
    event.preventDefault()
    const step = event.shiftKey ? NUDGE_PERCENT_LARGE : NUDGE_PERCENT
    onChangeRect(selected.key, toRectDraft(dragRect(start, 'move', direction.x * step, direction.y * step)))
  }

  return (
    <div className="flex flex-col gap-2">
      {/* 層はプレビューと同じ大きさに重ねる（プレビューは実寸の幅までしか広げないので、外枠も同じ幅までにする） */}
      <div className="relative w-full" style={{ maxWidth: STAGE_SIZE.width }}>
        <Preview url={overlayPreviewUrl(window.location.origin, draft.name)} title={`オーバーレイ「${draft.name}」のプレビュー`} size={STAGE_SIZE} />
        <div
          ref={layerRef}
          data-stage-layer
          tabIndex={-1}
          // touch-none: 触って動かすときに、ブラウザの画面送りへ持っていかれないようにする。select-none: 文字を選ばせない
          className="absolute inset-0 touch-none select-none outline-none"
          onPointerDown={(event) => {
            // 何もないところを押したら選択を外す（素材の上を押したときは素材の側で止めてある）
            if (event.target === event.currentTarget) onSelectItem(undefined)
          }}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onKeyDown={nudge}
        >
          {drawable.map(({ item, rect }) => {
            const label = itemLabel(item)
            const selected = selectedItemKey === item.key
            return (
              // 選んでいる素材は前の素材より上に描き、後ろにあっても動かせるようにする
              <div key={item.key} className={`group absolute ${selected ? 'z-10' : ''}`} style={rectStyle(rect)}>
                <button
                  type="button"
                  aria-label={`${label}を動かす`}
                  aria-pressed={selected}
                  className={`flex size-full cursor-move items-start overflow-hidden text-left text-xs outline-none ${
                    selected
                      ? 'ring-2 ring-primary'
                      : item.hidden
                        ? 'border border-dashed border-foreground/50'
                        : 'hover:ring-2 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60'
                  }`}
                  onPointerDown={(event) => startDrag(item, 'move', event)}
                  // キーボードで選んだときにも選ぶ（ドラッグは押した時点で選ぶので、二重に選んでも同じ結果になる）
                  onClick={() => onSelectItem(item.key)}
                >
                  {/* 名前は選んでいるとき・指したときだけ出す（中身のプレビューを隠さない）。隠した素材はプレビューに映らないので常に出す */}
                  <span
                    className={`max-w-full truncate rounded-br-sm bg-primary px-1.5 py-0.5 text-primary-foreground ${
                      selected || item.hidden ? '' : 'opacity-0 group-hover:opacity-100'
                    } ${item.hidden ? 'bg-muted text-muted-foreground line-through' : ''}`}
                  >
                    {label}
                  </span>
                </button>
                {selected &&
                  RESIZE_HANDLES.map((handle) => (
                    <span
                      key={handle}
                      role="button"
                      tabIndex={-1}
                      aria-label={`${label}の${HANDLE_LABELS[handle]}をつまむ`}
                      // 見た目は小さく、つまめる範囲（before）は広く取る
                      className={`absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow-sm before:absolute before:-inset-2 ${HANDLE_STYLES[handle]}`}
                      onPointerDown={(event) => startDrag(item, handle, event)}
                    />
                  ))}
              </div>
            )
          })}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">中身はサンプルです（配信中のものにはつながりません）。矢印キーで少しずつ、Shift を押しながらなら大きく動かせます。</p>
      {drawable.length < draft.items.length && (
        <p className="text-xs text-destructive">表示領域に出せない素材があります（位置と大きさを数として読めません）。数値欄で直してください</p>
      )}
    </div>
  )
}

interface ItemRowProps {
  draft: ItemDraft
  /** 素材を移せる先（構成にあるオーバーレイの名前） */
  overlayNames: readonly string[]
  overlayName: string
  open: boolean
  /** 前面へ・背面へ動かせるか（端の素材では押せなくする） */
  canMoveFront: boolean
  canMoveBack: boolean
  onToggle(): void
  onChange(draft: ItemDraft): void
  onMove(offset: number): void
  onMoveToOverlay(name: string): void
  onRemove(): void
  /** 隠す・表示するを切り替える（保存済みの素材はすぐ配信画面へ反映する） */
  onToggleHidden(): void
  /** 保存・表示の切り替えが進んでいるか。そのあいだは目のアイコンを押せなくする（送る構成が行き違わないようにする） */
  busy: boolean
  /** テキストの素材で選べるテキスト */
  textChoices: TextChoices
  /** 一覧の中でのドラッグ&ドロップによる並べ替え（つまみ・落とし先としての受け持ち） */
  reorder: ItemReorder
}

/**
 * 素材の行1つぶんの、ドラッグ&ドロップによる並べ替えの受け持ち。
 *
 * つまむのは行の左端のつまみだけにする（行全体をつまめるようにすると、入力欄の文字を選ぶ操作と取り合う）。
 * 落とし先は行全体にする。
 */
interface ItemReorder {
  /** この行が、いまつまんでいる素材の落とし先として指されているか（目印を出す） */
  dropTarget: boolean
  onDragStart(event: ReactDragEvent<HTMLElement>): void
  onDragEnd(): void
  onDragOver(event: ReactDragEvent<HTMLElement>): void
  onDragLeave(): void
  onDrop(event: ReactDragEvent<HTMLElement>): void
}

/**
 * テキストの素材の、映すテキストの選択欄。IDを手で打たせず、テキストの名前で選ばせる。
 *
 * @param value いま選んでいるテキストのID（パラメータ text の値）
 */
const TextSelectField = ({ id, value, choices, onChange }: { id: string; value: string; choices: TextChoices; onChange(value: string): void }) => {
  const label = textParamSchema.text.description
  if (choices.status === 'loading') return <p className="text-sm text-muted-foreground">テキストの一覧を読み込んでいます…</p>
  if (choices.status === 'failed') return <p className="text-sm text-destructive">テキストの一覧を読み込めないので、映すテキストを選べません（{choices.message}）</p>
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-text`}>{label}</Label>
      <NativeSelect id={`${id}-text`} className="w-full" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {textOptionsFor(choices.texts, value).map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">
        テキストの追加と本文の書き換えは<Link href="/texts/" className="underline underline-offset-4">テキスト</Link>のページで行います。
      </p>
    </div>
  )
}

/**
 * 素材1件ぶんの操作盤。
 *
 * 項目が多いので、ふだんは要約だけを見出しに出して折りたたむ（/triggers/ と同じ扱い）。
 * デザインを変えたらパラメータは新しいデザインの既定値にする（前のデザインの名前が残ると、保存しても
 * 合成ページ側で「未対応のパラメータ」として拒まれる）。
 */
const ItemRow = ({
  draft,
  overlayNames,
  overlayName,
  open,
  canMoveFront,
  canMoveBack,
  onToggle,
  onChange,
  onMove,
  onMoveToOverlay,
  onRemove,
  onToggleHidden,
  busy,
  textChoices,
  reorder,
}: ItemRowProps) => {
  const id = useId()
  const label = itemLabel(draft)
  const designs = designsFor(draft.kind)
  const schema = schemaFor(draft.kind, draft.id)
  /** パラメータの入力欄を宣言から並べる。テキストの素材の映すテキスト（text）だけは名前の選択欄で別に出すので、呼び出し側で外す */
  const paramFields = (entries: [string, ParamSpec][]) =>
    entries.map(([name, spec]) => (
      <ParamField
        // デザインを変えたら、同じ名前のパラメータでも入力欄を作り直す（前のデザインの色を覚えたままにしない）
        key={`${draft.id}-${name}`}
        name={name}
        spec={spec}
        value={draft.values[name] ?? spec.default}
        onChange={(value: AnyParamValue) => onChange({ ...draft, values: { ...draft.values, [name]: value } })}
      />
    ))
  // レジストリに無いデザインも選択欄に残す（開いただけで別のデザインへ移らないようにする。/llm/ のモデルと同じ扱い）
  const designOptions = designs.some((design) => design.id === draft.id)
    ? designs
    : [...designs, { id: draft.id, title: `${draft.id}（登録されていません）` }]

  return (
    <li
      role="group"
      aria-label={label}
      className={`${ITEM_BOX} ${reorder.dropTarget ? 'border-primary ring-2 ring-primary/40' : ''}`}
      onDragOver={reorder.onDragOver}
      onDragLeave={reorder.onDragLeave}
      onDrop={reorder.onDrop}
    >
      <div className="flex items-center gap-1 p-2">
        {/* キーボードでは「前面へ」「背面へ」のボタンで並べ替えるので、つまみはタブで止まらないようにする */}
        <span
          role="button"
          aria-label={`${label}をつまんで並べ替える`}
          title="ドラッグして重なりの順を変える"
          draggable
          className="flex size-8 shrink-0 cursor-grab items-center justify-center text-muted-foreground active:cursor-grabbing"
          onDragStart={reorder.onDragStart}
          onDragEnd={reorder.onDragEnd}
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label={`${label}の設定`}
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          className="h-auto min-w-0 flex-1 justify-start gap-2 py-1.5 font-normal"
          onClick={onToggle}
        >
          <ChevronDown aria-hidden="true" className={open ? 'rotate-180' : ''} />
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span className={`truncate font-medium ${draft.hidden ? 'text-muted-foreground line-through' : ''}`}>{label}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{rectSummary(draft)}</span>
          </span>
        </Button>
        {/* OBSのソース一覧の目のアイコンと同じく、押した瞬間に配信画面から消す・戻す（保存ボタンを待たない） */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          {...iconButtonName(draft.hidden ? `${label}を表示する` : `${label}を隠す`)}
          className={draft.hidden ? 'text-muted-foreground' : ''}
          disabled={busy}
          onClick={onToggleHidden}
        >
          {draft.hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </Button>
        {/* 一覧では上にあるものが前なので、「前面へ」がひとつ上、「背面へ」がひとつ下に当たる */}
        <Button type="button" variant="ghost" size="icon" {...iconButtonName(`${label}をひとつ前面へ`)} disabled={!canMoveFront} onClick={() => onMove(1)}>
          <ArrowUp aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon" {...iconButtonName(`${label}をひとつ背面へ`)} disabled={!canMoveBack} onClick={() => onMove(-1)}>
          <ArrowDown aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon" {...iconButtonName(`${label}を外す`)} className="text-destructive" onClick={onRemove}>
          <Trash2 aria-hidden="true" />
        </Button>
      </div>

      {/* 保存済みの値を読めなかった理由は、畳んでいても見えるようにする（気づかないまま保存させない） */}
      {draft.problem !== undefined && <p className="px-3 pb-2 text-xs text-destructive">{draft.problem}</p>}

      {open && (
        <div id={`${id}-detail`} className="grid gap-5 border-t p-4">
          <div className="flex flex-col gap-4">
            {designs.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-design`}>デザイン</Label>
                <NativeSelect
                  id={`${id}-design`}
                  className="w-full"
                  value={draft.id}
                  onChange={(event) => {
                    // パラメータはデザインごとに違うので、既定値から作り直す
                    onChange({ ...newItemDraft(draft.kind, event.currentTarget.value), key: draft.key, rect: draft.rect })
                  }}
                >
                  {designOptions.map((design) => (
                    <NativeSelectOption key={design.id} value={design.id}>
                      {design.title}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-overlay`}>置くオーバーレイ</Label>
              {/* 選んだオーバーレイのいちばん前へ移す（OBSでは、そのブラウザソースへ移ることになる） */}
              <NativeSelect id={`${id}-overlay`} className="w-full" value={overlayName} onChange={(event) => onMoveToOverlay(event.currentTarget.value)}>
                {overlayNames.map((name) => (
                  <NativeSelectOption key={name} value={name}>
                    {name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <fieldset className="grid grid-cols-2 gap-3">
              {/* 単位（％）は見出しに1度だけ出し、入力欄ごとには繰り返さない */}
              <legend className="mb-2 text-sm font-medium">オーバーレイの中での位置と大きさ（％）</legend>
              {RECT_FIELDS.map((field) => (
                <div key={field.key} className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-${field.key}`} className="text-xs font-normal text-muted-foreground">
                    {field.short}
                  </Label>
                  {/* 空欄は 0 に丸めず、そのままWorkerへ送って理由を返させる（検証はWorkerだけが持つ） */}
                  <Input
                    id={`${id}-${field.key}`}
                    aria-label={field.label}
                    type="number"
                    inputMode="decimal"
                    value={draft.rect[field.key]}
                    onChange={(event) => onChange({ ...draft, rect: { ...draft.rect, [field.key]: event.currentTarget.value } })}
                  />
                </div>
              ))}
            </fieldset>
          </div>

          <div className="flex flex-col gap-5">
            {draft.kind === 'text' ? (
              <>
                <TextSelectField
                  id={id}
                  value={String(draft.values.text ?? textParamSchema.text.default)}
                  choices={textChoices}
                  onChange={(value) => onChange({ ...draft, values: { ...draft.values, text: value } })}
                />
                {paramFields(Object.entries(textParamSchema).filter(([name]) => name !== 'text'))}
              </>
            ) : schema === undefined ? (
              <p className="text-sm text-muted-foreground">デザインを選び直すと、その素材のパラメータを調整できます。</p>
            ) : Object.keys(schema).length === 0 ? (
              <p className="text-sm text-muted-foreground">この素材に、配信者が決めるパラメータはありません。</p>
            ) : (
              paramFields(Object.entries(schema))
            )}
          </div>
        </div>
      )}
    </li>
  )
}

interface OverlayCardProps {
  draft: OverlayDraft
  /** テキストの素材で選べるテキスト */
  textChoices: TextChoices
  overlayNames: readonly string[]
  overlayKey: string | null
  /** 開いている素材の識別子（オーバーレイをまたいで1つだけ開く） */
  openItemKey: number | undefined
  onToggleItem(key: number): void
  /** 素材を選んで設定を開く（畳まない。表示領域で選んだときに使う）。undefined なら選択を外す */
  onSelectItem(key: number | undefined): void
  onChange(draft: OverlayDraft): void
  onMoveItemToOverlay(item: ItemDraft, to: string): void
  onAskRemoveItem(item: ItemDraft): void
  onToggleItemHidden(item: ItemDraft): void
  /** 保存・表示の切り替えが進んでいるか（目のアイコンを押せなくする） */
  busy: boolean
  onAskRemove(): void
  onCopyUrl(url: string): void
  /** タブの並びの中でこのオーバーレイを動かせるか（端のオーバーレイでは押せなくする） */
  canMoveLeft: boolean
  canMoveRight: boolean
  onMove(offset: number): void
}

/** オーバーレイ1つ（＝OBSのブラウザソース1つ）ぶんのカード。積んだ素材と、貼るURLを持つ */
const OverlayCard = ({
  draft,
  textChoices,
  overlayNames,
  overlayKey,
  openItemKey,
  onToggleItem,
  onSelectItem,
  onChange,
  onMoveItemToOverlay,
  onAskRemoveItem,
  onToggleItemHidden,
  busy,
  onAskRemove,
  onCopyUrl,
  canMoveLeft,
  canMoveRight,
  onMove,
}: OverlayCardProps) => {
  const id = useId()
  const [newKind, setNewKind] = useState<ItemKind>('wallpaper')
  const [newId, setNewId] = useState(designsFor('wallpaper')[0]?.id ?? '')
  const url = overlayKey === null ? null : overlayStageUrl(window.location.origin, overlayKey, draft.name)

  const updateItem = (position: number, item: ItemDraft): void =>
    onChange({ ...draft, items: draft.items.map((current, index) => (index === position ? item : current)) })

  /** 素材を1つ動かす（構成での並びがそのまま重ねる順。offset が正なら前へ） */
  const moveItem = (position: number, offset: number): void => onChange({ ...draft, items: moveDraft(draft.items, position, offset) })

  /**
   * いまつまんでいる素材の識別子（ItemDraft.key）。このカードの中でつまんだときだけ入る。
   *
   * カードごとに持つので、別のオーバーレイの行から運ばれてきたものは落としても受け付けない
   * （オーバーレイをまたぐ移動は「置くオーバーレイ」の選択欄で行う）。
   */
  const draggingKeyRef = useRef<number>(undefined)
  /** 落とし先として指されている行の識別子（目印を出すため） */
  const [dropTargetKey, setDropTargetKey] = useState<number>()

  /** ドラッグ&ドロップでの並べ替えの受け持ちを、行ごとに組み立てる */
  const reorderFor = (item: ItemDraft, position: number): ItemReorder => ({
    dropTarget: dropTargetKey === item.key,
    onDragStart: (event) => {
      draggingKeyRef.current = item.key
      event.dataTransfer.effectAllowed = 'move'
      // Firefox は何かを載せないとドラッグを始めない。中身は使わない（つまんだ素材は draggingKeyRef で覚える）
      event.dataTransfer.setData('text/plain', '')
      // つまみだけでなく行ごと運んでいるように見せる
      const row = event.currentTarget.closest('li')
      if (row) event.dataTransfer.setDragImage(row, 0, 0)
    },
    onDragEnd: () => {
      draggingKeyRef.current = undefined
      setDropTargetKey(undefined)
    },
    onDragOver: (event) => {
      if (draggingKeyRef.current === undefined) return
      // 既定の動き（落とせない）を止めて、ここへ落とせるようにする
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDropTargetKey(item.key)
    },
    onDragLeave: () => setDropTargetKey((current) => (current === item.key ? undefined : current)),
    onDrop: (event) => {
      const draggingKey = draggingKeyRef.current
      draggingKeyRef.current = undefined
      setDropTargetKey(undefined)
      if (draggingKey === undefined) return
      event.preventDefault()
      const from = draft.items.findIndex((current) => current.key === draggingKey)
      if (from < 0) return
      // 落とした行の位置へ移す（構成での位置どうしの差だけずらす）
      moveItem(from, position - from)
    },
  })

  /** 表示領域でドラッグした結果を、その素材の位置と大きさへ書き戻す */
  const changeRect = (key: number, rect: RectDraft): void =>
    onChange({ ...draft, items: draft.items.map((current) => (current.key === key ? { ...current, rect } : current)) })

  return (
    <Card role="group" aria-label={`オーバーレイ「${draft.name}」`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            {/* 「OBSのブラウザソース1つぶん」は、カードの下のURL欄（貼る先そのもの）が示すので文章にしない */}
            <CardTitle>
              オーバーレイ <code className="font-mono">{draft.name}</code>
            </CardTitle>
          </div>
          <div className="flex items-center gap-1">
            {/* オーバーレイ同士の並びは重なりと関わらない（別々のブラウザソースなので）。タブを編集しやすい順に並べ替えるためのもの */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              {...iconButtonName(`オーバーレイ「${draft.name}」をひとつ左へ`)}
              disabled={!canMoveLeft}
              onClick={() => onMove(-1)}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              {...iconButtonName(`オーバーレイ「${draft.name}」をひとつ右へ`)}
              disabled={!canMoveRight}
              onClick={() => onMove(1)}
            >
              <ArrowRight aria-hidden="true" />
            </Button>
            <Button type="button" variant="ghost" size="icon" {...iconButtonName(`オーバーレイ「${draft.name}」を外す`)} className="text-destructive" onClick={onAskRemove}>
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* 左にレイヤーの一覧（選んだ素材の設定もここで開く）、右に表示領域。表示領域は追従させ、設定を下へたどっても見えたままにする */}
        <div className="grid gap-6 lg:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)]">
          <section aria-label="レイヤー" className="flex min-w-0 flex-col gap-3">
            <h3 className="text-sm font-medium">レイヤー</h3>
            {draft.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">まだ素材がありません。素材を置くまでは保存されません（貼っても何も映らないためです）。</p>
            ) : (
              <div className="flex flex-col gap-2">
                {/* 重なりの向きは目印で示す（素材が1つだけなら重なりが無いので出さない） */}
                {draft.items.length > 1 && <p className="text-xs text-muted-foreground">前面</p>}
                <ul className="flex flex-col gap-2">
                  {frontFirstItems(draft.items).map(({ item, position }) => (
                    <ItemRow
                      // 位置をキーにすると、並べ替え・外したときに入力欄が別の素材のものとして使い回され、
                      // 入力欄が覚えている内容（透過にする前の色）が混ざる。そのため素材ごとの識別子を使う
                      key={item.key}
                      draft={item}
                      overlayNames={overlayNames}
                      overlayName={draft.name}
                      open={openItemKey === item.key}
                      canMoveBack={position > 0}
                      canMoveFront={position < draft.items.length - 1}
                      onToggle={() => onToggleItem(item.key)}
                      onChange={(next) => updateItem(position, next)}
                      onMove={(offset) => moveItem(position, offset)}
                      onMoveToOverlay={(to) => onMoveItemToOverlay(item, to)}
                      onRemove={() => onAskRemoveItem(item)}
                      onToggleHidden={() => onToggleItemHidden(item)}
                      busy={busy}
                      textChoices={textChoices}
                      reorder={reorderFor(item, position)}
                    />
                  ))}
                </ul>
                {draft.items.length > 1 && <p className="text-xs text-muted-foreground">背面</p>}
              </div>
            )}
            {/* 選んだ種類とデザインがそのまま見えているので、入力欄の見出しは読み上げにだけ残す */}
            <div className="flex flex-wrap items-center gap-3">
              <NativeSelect
                aria-label="追加する素材の種類"
                id={`${id}-kind`}
                className="w-44"
                value={newKind}
                onChange={(event) => {
                  const kind = ITEM_KINDS.find((candidate) => candidate === event.currentTarget.value) ?? 'wallpaper'
                  setNewKind(kind)
                  // デザインIDを持たない種類では空文字にする
                  setNewId(designsFor(kind)[0]?.id ?? '')
                }}
              >
                {ITEM_KINDS.map((kind) => (
                  <NativeSelectOption key={kind} value={kind}>
                    {ITEM_KIND_LABELS[kind]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {designsFor(newKind).length > 0 && (
                <NativeSelect
                  aria-label="追加する素材のデザイン"
                  id={`${id}-design`}
                  className="w-44"
                  value={newId}
                  onChange={(event) => setNewId(event.currentTarget.value)}
                >
                  {designsFor(newKind).map((design) => (
                    <NativeSelectOption key={design.id} value={design.id}>
                      {design.title}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
              {/* 追加した素材はいちばん前（構成では並びの末尾、一覧ではいちばん上）に、いっぱいの大きさで入る */}
              <Button
                type="button"
                size="icon"
                {...iconButtonName('素材を追加する')}
                onClick={() => onChange({ ...draft, items: [...draft.items, newItemDraft(newKind, newId)] })}
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
          </section>

          {/* 小さい画面では表示領域を先に出す（何を編集しているかを先に見せる） */}
          <section aria-label="表示領域" className="order-first flex min-w-0 flex-col gap-3 self-start lg:sticky lg:top-4 lg:order-none">
            <h3 className="text-sm font-medium">表示領域</h3>
            {draft.items.length === 0 ? (
              <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
                素材を追加すると、ここに映ります
              </div>
            ) : (
              <StageEditor draft={draft} selectedItemKey={openItemKey} onSelectItem={onSelectItem} onChangeRect={changeRect} />
            )}
          </section>
        </div>

        {/* キーが無いときの理由はページの先頭に1度だけ出す（カードごとに繰り返さない） */}
        {url !== null && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-url`}>OBSのブラウザソースに貼るURL</Label>
            {/* 中の位置と大きさが割合であることは、素材ごとの入力欄（％）が示すので書かない */}
            <p id={`${id}-size`} className="text-sm text-muted-foreground">
              推奨の大きさ: {STAGE_SIZE.width} × {STAGE_SIZE.height} px（配信画面と同じ）
            </p>
            <div className="flex gap-2">
              {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
              <Input id={`${id}-url`} type="password" readOnly autoComplete="off" value={url} aria-describedby={`${id}-size`} />
              <Button type="button" size="icon" {...iconButtonName('URLをコピー')} onClick={() => onCopyUrl(url)}>
                <Copy aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * @param textApi テキストの一覧の読み出し（テキストの素材の選択欄に並べる）
 */
export const OverlayPage = ({ api, overlayKey, textApi }: { api: OverlayLayoutAdminApi; overlayKey: string | null; textApi: TextApi }) => {
  const [drafts, setDrafts] = useState<readonly OverlayDraft[]>([])
  const [textChoices, setTextChoices] = useState<TextChoices>({ status: 'loading' })
  /**
   * 読み込んだ（保存した）時点の中身。いまの中身と食い違えば「未保存の変更があります」と添える。
   * 表示の切り替えでは、保存済みの構成でどこにある素材かをここから引く（savedVisibilityTarget）。
   */
  const [savedDrafts, setSavedDrafts] = useState<readonly OverlayDraft[]>()
  const [newName, setNewName] = useState('')
  /** 開いている素材の識別子。オーバーレイをまたいで1つだけ開く（一覧が長くなりすぎないようにする） */
  const [openItemKey, setOpenItemKey] = useState<number>()
  /**
   * タブで開いているオーバーレイの名前。開いているものが無くなった（外した）ときは先頭を開く。
   *
   * 識別子（OverlayDraft.key）ではなく名前で覚えるのは、保存すると読み直した中身に識別子が振り直されるためである
   * （名前は構成の中で重ならず、画面からは変えられない）。
   *
   * 描くのは開いているオーバーレイだけで、プレビューも1つだけ動かす。重なりの1枚を丸ごと動かすので
   * 同時に何枚も動かさないためであり、あわせて構成の取り違えも防ぐ（構成を待っている知らせに答える相手が1つに定まる）。
   */
  const [activeOverlayName, setActiveOverlayName] = useState<string>()
  /** 送ったオーバーレイと素材の名前（送った順）。Workerが返した問題点の位置を読み替えるのに使う */
  const submittedLabelsRef = useRef<readonly OverlayLabels[]>([])
  const actions = usePageActions((error) => failureLines(error, submittedLabelsRef.current))
  const nameFieldId = useId()

  // 開いたときに保存済みの構成を読む
  useEffect(() => {
    let cancelled = false
    void actions.run(async () => {
      const overlays = await api.load()
      if (cancelled) return ''
      const loaded = toOverlayDrafts(overlays)
      setDrafts(loaded)
      setSavedDrafts(loaded)
      return ''
    })
    return () => {
      cancelled = true
    }
    // 読み込みは開いたときの1回だけにする（actions は描くたびに作り直されるので、依存には入れない）
  }, [api])

  // テキストの素材の選択欄に並べるテキストを読む。読めなくても構成の編集は続けられるよう、失敗は選択欄の場所にだけ出す
  useEffect(() => {
    let cancelled = false
    textApi.list().then(
      (texts) => {
        if (!cancelled) setTextChoices({ status: 'ready', texts })
      },
      (error: unknown) => {
        if (!cancelled) setTextChoices({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [textApi])

  const overlayNames = overlayNameChoices(drafts)
  const activeDraft = drafts.find((draft) => draft.name === activeOverlayName) ?? drafts[0]
  const changed = savedDrafts !== undefined && JSON.stringify(savedDrafts) !== JSON.stringify(drafts)
  useUnsavedChanges(changed)
  /** 追加しようとしている名前（前後の空白を落としたもの）と、それがすでに使われているか */
  const trimmedNewName = newName.trim()
  const nameTaken = drafts.some((draft) => draft.name === trimmedNewName)

  const update = (position: number, draft: OverlayDraft): void => setDrafts(drafts.map((current, index) => (index === position ? draft : current)))

  /** 素材を別のオーバーレイのいちばん前へ移し、移した先のタブを開く（素材は選んだまま） */
  const moveItemToOverlay = (item: ItemDraft, to: string): void => {
    if (!drafts.some((draft) => draft.name === to)) return
    setActiveOverlayName(to)
    setDrafts(
      drafts.map((draft) => {
        if (draft.name === to) return { ...draft, items: [...draft.items, item] }
        return { ...draft, items: draft.items.filter((current) => current.key !== item.key) }
      }),
    )
  }

  const save = async (): Promise<string> => {
    // 素材を1つも持たないオーバーレイは送らない（Workerが拒む）。問題点を読み替える名前も同じ並びから作る
    const savable = savableOverlayDrafts(drafts)
    submittedLabelsRef.current = overlayLabelsOf(savable)
    const saved = toOverlayDrafts(await api.save(toOverlays(savable)))
    setDrafts(saved)
    setSavedDrafts(saved)
    return '構成を保存しました'
  }

  /**
   * 素材を隠す・表示する。
   *
   * 保存済みの素材は保存ボタンを待たずに保存済みの構成の1件だけを書き換え、合成ページへすぐ反映させる
   * （OBSの目のアイコンと同じく、押した瞬間に配信画面から消したいため）。ほかの未保存の編集は巻き込まず、
   * 保存済みの中身（savedDrafts）にも同じ切り替えを当てて、未保存の変更として数えないようにする。
   * 追加したばかりでまだ保存していない素材は、画面の中身だけを切り替える（保存したときに反映される）。
   */
  const toggleItemHidden = (item: ItemDraft): void => {
    const hidden = !item.hidden
    const target = savedDrafts === undefined ? undefined : savedVisibilityTarget(savedDrafts, item.key)
    if (target === undefined) {
      setDrafts(withDraftHidden(drafts, item.key, hidden))
      return
    }
    void actions.run(async () => {
      await api.setVisibility({ ...target, hidden })
      setDrafts((current) => withDraftHidden(current, item.key, hidden))
      setSavedDrafts((current) => current && withDraftHidden(current, item.key, hidden))
      return `${itemLabel(item)}を${hidden ? '隠しました' : '表示しました'}`
    })
  }

  const copyUrl = async (url: string): Promise<string> => {
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    await navigator.clipboard.writeText(url)
    return 'OBS用のURLをコピーしました'
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      {overlayKey === null && (
        <Alert variant="destructive">
          <AlertTitle>OBS用のURLを表示できません</AlertTitle>
          <AlertDescription>オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください</AlertDescription>
        </Alert>
      )}

      {drafts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>オーバーレイ</CardTitle>
            <CardDescription>
              OBSのブラウザソース1つぶんが「オーバーレイ」で、その中に素材を積む。アバターやゲーム画面を挟みたいところで分ける。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">まだオーバーレイがありません。</p>
          </CardContent>
        </Card>
      ) : (
        // オーバーレイはタブで1つずつ開く（描くのもプレビューを動かすのも、開いているものだけ）
        <Tabs value={activeDraft?.name} onValueChange={(value: string) => setActiveOverlayName(value)} className="gap-4">
          <TabsList aria-label="オーバーレイ">
            {drafts.map((draft) => (
              <TabsTrigger key={draft.key} value={draft.name} className="px-3 font-mono">
                {draft.name}
              </TabsTrigger>
            ))}
          </TabsList>
          {drafts.map((draft, position) => (
            <TabsContent key={draft.key} value={draft.name}>
              <OverlayCard
                key={draft.key}
                draft={draft}
                textChoices={textChoices}
                overlayNames={overlayNames}
                overlayKey={overlayKey}
                openItemKey={openItemKey}
                onToggleItem={(key) => setOpenItemKey(openItemKey === key ? undefined : key)}
                onSelectItem={setOpenItemKey}
                onChange={(next) => update(position, next)}
                onMoveItemToOverlay={moveItemToOverlay}
                onAskRemoveItem={(item) =>
                  actions.ask({
                    title: `${itemLabel(item)}を外しますか？`,
                    description: 'この素材の位置とパラメータは失われます。保存するまでは構成に反映されません。',
                    actionLabel: '素材を外す',
                    run: async () => {
                      update(position, { ...draft, items: draft.items.filter((current) => current.key !== item.key) })
                      return '素材を外しました（保存すると反映されます）'
                    },
                  })
                }
                onToggleItemHidden={toggleItemHidden}
                busy={actions.busy}
                onAskRemove={() =>
                  actions.ask({
                    title: `オーバーレイ「${draft.name}」を外しますか？`,
                    description: '積んでいる素材もすべて外れます。OBSに貼ったこのオーバーレイのブラウザソースは何も映さなくなります。',
                    actionLabel: 'オーバーレイを外す',
                    run: async () => {
                      setDrafts(drafts.filter((current) => current.key !== draft.key))
                      return 'オーバーレイを外しました（保存すると反映されます）'
                    },
                  })
                }
                onCopyUrl={(url) => void actions.run(() => copyUrl(url))}
                canMoveLeft={position > 0}
                canMoveRight={position < drafts.length - 1}
                onMove={(offset) => setDrafts(moveDraft(drafts, position, offset))}
              />
            </TabsContent>
          ))}
        </Tabs>
      )}

      <Card>
        <CardHeader>
          <CardTitle>オーバーレイを追加する</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {/* フォームにして、名前を打って Enter でも追加できるようにする（日本語の変換を確定する Enter ではブラウザは送信しない） */}
          <form
            className="flex flex-wrap items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (trimmedNewName === '' || nameTaken) return
              setDrafts([...drafts, newOverlayDraft(trimmedNewName)])
              // 追加したオーバーレイのタブを開き、そのまま素材を置けるようにする
              setActiveOverlayName(trimmedNewName)
              setNewName('')
            }}
          >
            {/* 見出しが「オーバーレイを追加する」なので、入力欄の見出しは画面には出さず、読み上げにだけ残す */}
            {/* 名前の書式（英小文字・数字・ハイフン）は Worker が確かめる */}
            <Input
              id={nameFieldId}
              aria-label="追加するオーバーレイの名前"
              aria-describedby={`${nameFieldId}-outline`}
              className="w-44"
              value={newName}
              placeholder="talk"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setNewName(event.currentTarget.value)}
            />
            <Button type="submit" size="icon" {...iconButtonName('オーバーレイを追加する')} disabled={trimmedNewName === '' || nameTaken}>
              <Plus aria-hidden="true" />
            </Button>
          </form>
          {/* どちらも1行に収め、打ち始めても行がずれないよう高さを確保しておく */}
          <div className="min-h-5 text-sm">
            {/* 名前がOBSに貼るURLに載ることは、文章で説明せずURLそのものを見せて分からせる。
                ただしURLは1文字打つたびに変わるので読み上げの通知には載せない（打鍵ごとにURL全体を読み上げさせない）。
                入力欄からは aria-describedby で指しているので、欄へ移ったときには読まれる */}
            <p id={`${nameFieldId}-outline`} className="text-muted-foreground">
              {!nameTaken && trimmedNewName !== '' && (
                <code className="font-mono break-all">{overlayStageUrlOutline(window.location.origin, trimmedNewName)}</code>
              )}
            </p>
            {/* 追加できない理由だけは、打っている手を止めずに伝わるよう通知に載せる（空でも置いたままにする） */}
            <p aria-live="polite" className="text-destructive">
              {nameTaken && 'この名前のオーバーレイはすでにあります。別の名前にしてください。'}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 一覧が長いので、保存は貼り付けて常に押せるようにする（/triggers/ と同じ扱い） */}
      <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background py-3">
        <Button type="button" disabled={actions.busy} onClick={() => void actions.run(save)}>
          構成を保存する
        </Button>
        {changed && <p className="text-sm text-muted-foreground">未保存の変更があります</p>}
      </div>
    </div>
  )
}
