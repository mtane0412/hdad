/**
 * 合成オーバーレイの構成のページ（オーバーレイと素材の編集、OBS用URL）
 *
 * OBSのブラウザソースはその数だけ Chromium のレンダラを立ち上げるため、素材を1枚のページ
 * （overlay/stage/index.html）へ重ね、ブラウザソースは「オーバーレイ」ごとに1つで済ませる（issue #101）。
 * その構成（どのオーバーレイにどの素材をどこへ置くか）を配信者が編集する口がこのページである（issue #103）。
 * 構成を持つのは Worker（KVの overlay-layout）なので、ここで保存すれば次にオーバーレイが読みに来た時点で
 * 反映され、OBSのURLは貼り替えなくてよい。
 *
 * 用語: **オーバーレイ**はOBSのブラウザソース1つ（＝重なりの1枚）で、その中に**素材**（壁紙・時計・
 * チャットなど）を積む。オーバーレイを複数に分けるのは、アバターやゲーム画面というWebでないソースが
 * 間に挟まり、Web側の素材をその前と後ろの両方に置きたいためである。
 *
 * 素材の並びがそのまま重ねる順（あとのものが前）だが、一覧では並びを逆にして「前面 → 背面」で並べる
 * （OBSのソース一覧と同じく、上にあるものが前に出る）。オーバーレイ同士も一覧の中で並べ替えられる。
 * Workerの呼び出しは admin-api.ts、入力欄の値の変換とデザインのスキーマの引き当ては form.ts、
 * URLの組み立ては url.ts に分けてテストする。素材のパラメータの入力欄は、ギャラリーと同じ
 * 自動生成（src/core/fields.tsx の ParamField）を使う。
 *
 * 位置と大きさは、配信画面と同じ縦横比の「配置用の枠」（PlacementBox）に素材を四角として描き、
 * ドラッグで動かす・端をつまんで大きさを変えることでも決められる（issue #105）。数値入力も残してあり、
 * ドラッグで置いた値はそのまま数値欄にも出る（キーボードだけで細かく合わせられるようにするため）。
 * 画素から割合（％）への変換と四角の計算は drag.ts に分けてテストする。
 *
 * 注意: 値の検証は Worker（worker/overlay-layout.ts）だけが持つ。画面は空欄を 0 に丸めず、返ってきた
 * 問題点をオーバーレイと素材の名前へ読み替えて並べる（issue #86 で決めた「画面とWorkerで二重に持たない」）。
 * 注意: 素材を1つも持たないオーバーレイは送らない（Workerが拒む。OBSに貼っても何も映らないURLを
 * 作らせないため）。足した名前は画面が覚えておき、素材を置いた時点で保存されるようにする。
 * 注意: 保存済みの値が読めない素材（レジストリに無いデザイン・範囲外のパラメータ）でも黙って捨てない。
 * 捨てると、開いて保存しただけでその素材が消える。理由を出して直させる（Fail-Fast）。
 * 重なりと見た目は、オーバーレイのカードの中で開けるプレビュー（PreviewFrame）で確かめられる（issue #106）。
 * 中身は合成ページそのままの描画だが、素材のデータはすべてサンプルにして外へつながない。映す構成は
 * Worker からではなく、この画面から postMessage で渡す（preview.ts）ので、保存しなくても編集中のものが映る。
 *
 * 注意: 配置用の枠に描くのは四角と名前だけで、素材の中身は映さない（中身はプレビューが受け持つ）。
 * 注意: 吸着（グリッド・他の素材の端に合わせる）は入れていない。まず動かせることを先にする。
 */
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ApiError } from '../core/api'
import { ParamField } from '../core/fields'
import { Preview, useSettled } from '../core/preview'
import type { AnyParamValue } from '../core/params'
import type { OverlayLayoutAdminApi } from './admin-api'
import { deltaPercent, dragRect, HANDLE_LABELS, rectNumbersOf, RESIZE_HANDLES, toRectDraft, type DragHandle } from './drag'
import {
  describeOverlayProblem,
  designsFor,
  frontFirstItems,
  itemLabel,
  ITEM_KIND_LABELS,
  moveDraft,
  newItemDraft,
  newOverlayDraft,
  overlayLabelsOf,
  overlayNameChoices,
  savableOverlayDrafts,
  schemaFor,
  toOverlayDrafts,
  toOverlays,
  type ItemDraft,
  type OverlayDraft,
  type OverlayLabels,
  type RectDraft,
} from './form'
import { ITEM_KINDS, STAGE_SIZE, rectStyle, type ItemKind } from './layout'
import { replyPreviewLayout } from './preview'
import { overlayPreviewUrl, overlayStageUrl, overlayStageUrlOutline } from './url'

/** 入力中にプレビューを作り直しすぎないための待ち時間（ミリ秒）。ギャラリーと同じ扱い */
const PREVIEW_DELAY_MS = 150

/** 位置と大きさの入力欄（％）。並べる順と見出しをここで決める */
const RECT_FIELDS: readonly { key: keyof RectDraft; label: string }[] = [
  { key: 'x', label: '左端の位置（％）' },
  { key: 'y', label: '上端の位置（％）' },
  { key: 'width', label: '幅（％）' },
  { key: 'height', label: '高さ（％）' },
]

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
 * 配置用の枠に描く、つまみの置き場所（四角の角と端）。
 *
 * 四角の辺の上に半分はみ出させて置く（端そのものをつまめるようにするため）。マウスの形も方向に合わせる。
 */
const HANDLE_STYLES: Readonly<Record<Exclude<DragHandle, 'move'>, string>> = {
  nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  n: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  ne: 'left-full top-0 -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  e: 'left-full top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  sw: 'left-0 top-full -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  s: 'left-1/2 top-full -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  se: 'left-full top-full -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
}

interface PlacementBoxProps {
  /** そのオーバーレイの素材（構成の並びのまま。あとのものが前に重なる） */
  items: readonly ItemDraft[]
  /** いま開いている素材（枠の中でも目立たせる） */
  openItemKey: number | undefined
  onOpenItem(key: number): void
  onChangeRect(key: number, rect: RectDraft): void
}

/**
 * 配置用の枠。配信画面と同じ縦横比の箱に素材を四角として描き、ドラッグで位置と大きさを決める。
 *
 * 描くのは四角と名前だけで、素材の中身は映さない（プレビューは別 issue）。重なりは構成の並びのままなので、
 * 一覧の「前面へ・背面へ」で入れ替えた結果が四角の重なりにも出る。
 *
 * 注意: 位置と大きさを数として読めない素材（数値欄を空にした直後など）は四角にせず、理由を添える。
 * 読めない値からドラッグを始めると、つまんだ時点の四角が決まらないためである。
 */
const PlacementBox = ({ items, openItemKey, onOpenItem, onChangeRect }: PlacementBoxProps) => {
  const boxRef = useRef<HTMLDivElement>(null)
  /** ドラッグの後始末（窓に付けた耳を外す）。ドラッグしていないあいだは undefined */
  const stopDragRef = useRef<() => void>(undefined)
  /** いまの描画のときの書き戻し先。ドラッグのあいだ古い関数を掴んだままにしない */
  const onChangeRectRef = useRef(onChangeRect)
  useEffect(() => {
    onChangeRectRef.current = onChangeRect
  })

  // 動かしている途中で画面から消えたときに、窓に付けた耳を外す
  useEffect(() => () => stopDragRef.current?.(), [])

  const startDrag = (item: ItemDraft, handle: DragHandle, event: ReactPointerEvent): void => {
    // 前のドラッグが終わっていなければ（指が離れた知らせを取りこぼしていれば）先に始末する
    stopDragRef.current?.()
    // つまんだ素材の設定を開く（どの四角がどの素材かを、数値欄と見比べられるようにする）
    onOpenItem(item.key)
    const box = boxRef.current
    const start = rectNumbersOf(item.rect)
    if (box === null || start === undefined) return
    const size = box.getBoundingClientRect()
    const originX = event.clientX
    const originY = event.clientY
    // 動かすたびに「つまんだ時点の四角」から計算するので、丸めの誤差が積み上がらない
    const move = (moved: globalThis.PointerEvent): void => {
      const { dx, dy } = deltaPercent(moved.clientX - originX, moved.clientY - originY, size.width, size.height)
      onChangeRectRef.current(item.key, toRectDraft(dragRect(start, handle, dx, dy)))
    }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      stopDragRef.current = undefined
    }
    // 枠の外へポインタが出ても追い続けられるよう、耳は窓に付ける
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    // 取り消し（指が離れずに中断される。ブラウザが操作を引き取ったときなど）でも追うのをやめる
    window.addEventListener('pointercancel', end)
    stopDragRef.current = end
  }

  const drawable = items.flatMap((item) => {
    const rect = rectNumbersOf(item.rect)
    return rect === undefined ? [] : [{ item, rect }]
  })

  return (
    <div className="flex flex-col gap-2">
      {/* 配信画面と同じ縦横比（16:9）。中の位置と大きさは割合（％）なので、枠の実際の大きさによらない */}
      <div ref={boxRef} className="relative aspect-video w-full overflow-hidden rounded-md border bg-muted/40">
        {drawable.map(({ item, rect }) => {
          const label = itemLabel(item)
          return (
            <div key={item.key} className="absolute" style={rectStyle(rect)}>
              <button
                type="button"
                aria-label={`${label}を動かす`}
                // touch-none: 触って動かすときに、ブラウザの画面送りへ持っていかれないようにする
                className={`flex size-full touch-none cursor-move items-start overflow-hidden border-2 p-1 text-left text-xs ${
                  openItemKey === item.key ? 'border-primary bg-primary/20' : 'border-foreground/40 bg-foreground/5'
                }`}
                onPointerDown={(event) => startDrag(item, 'move', event)}
                // キーボードで選んだときにも設定を開く（ドラッグは押した時点で開くので、二重に押しても同じ結果になる）
                onClick={() => onOpenItem(item.key)}
              >
                <span className="truncate">{label}</span>
              </button>
              {RESIZE_HANDLES.map((handle) => (
                <span
                  key={handle}
                  role="button"
                  tabIndex={-1}
                  aria-label={`${label}の${HANDLE_LABELS[handle]}をつまむ`}
                  className={`absolute size-2.5 touch-none rounded-xs border border-primary bg-background ${HANDLE_STYLES[handle]}`}
                  onPointerDown={(event) => startDrag(item, handle, event)}
                />
              ))}
            </div>
          )
        })}
      </div>
      {drawable.length < items.length && (
        <p className="text-xs text-destructive">枠に出せない素材があります（位置と大きさを数として読めません）。数値欄で直してください</p>
      )}
    </div>
  )
}

/**
 * プレビュー。編集中のオーバーレイを、合成ページ（overlay/stage/）そのままの描画で試し見する。
 *
 * 映すのは編集中の構成で、Worker からは読ませない（保存はその時点で配信画面へ反映されるので、保存して
 * からでないと確かめられないプレビューでは「配信画面に出してから確かめる」ことになる）。渡し方は
 * preview.ts の postMessage で、プレビューから「構成を待っている」と知らせてきたときに返す。
 *
 * 素材の中身はすべてサンプルにする（?demo=true）。匿名IRC・アラートのWebSocket・ポーリングを
 * どれもつながないので、配信中のものに加えてもう1組動くことがない（issue #106 で懸念した代償）。
 *
 * 注意: 開いているプレビューは常に1つだけである（OverlayPage が持つ previewOverlayKey）。重なりの1枚を
 * 丸ごと動かすので同時に何枚も動かさないためで、これにより「構成を待っている」知らせに答える相手も
 * 1つに定まる（何枚も開けると、別のカードのプレビューへ自分の構成を渡してしまう）。
 * 注意: 位置と大きさを数として読めない素材は映さず、理由を添える（配置用の枠と同じ扱い）。
 * 注意: 編集が進んだら iframe ごと作り直す（素材の起動をやり直させるほうが、動いているものを
 * 差し替えるより確かである）。打っている途中で何度も作り直さないよう、少し待ってからにする。
 */
const PreviewFrame = ({ draft }: { draft: OverlayDraft }) => {
  // 数として読めない素材は渡さない（渡すと合成ページ側が構成そのものを読めないものとして扱う）
  const drawable = draft.items.filter((item) => rectNumbersOf(item.rect) !== undefined)
  const overlays = toOverlays([{ ...draft, items: drawable }])
  /** いま渡す構成。知らせが届いた時点の最新を渡すため、描くたびに更新する */
  const overlaysRef = useRef(overlays)
  useEffect(() => {
    overlaysRef.current = overlays
  })

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      replyPreviewLayout(event, window.location.origin, overlaysRef.current)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  // 中身が変わったら iframe を作り直す（key に渡す。渡す構成に JSON にできない値は無いので、そのまま印にできる）
  const token = useSettled(JSON.stringify(overlays), PREVIEW_DELAY_MS)

  return (
    <div className="flex flex-col gap-2">
      <Preview
        key={token}
        url={overlayPreviewUrl(window.location.origin, draft.name)}
        title={`オーバーレイ「${draft.name}」のプレビュー`}
        size={STAGE_SIZE}
      />
      {drawable.length < draft.items.length && (
        <p className="text-xs text-destructive">プレビューに出せない素材があります（位置と大きさを数として読めません）。数値欄で直してください</p>
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
}: ItemRowProps) => {
  const id = useId()
  const label = itemLabel(draft)
  const designs = designsFor(draft.kind)
  const schema = schemaFor(draft.kind, draft.id)
  // レジストリに無いデザインも選択欄に残す（開いただけで別のデザインへ移らないようにする。/llm/ のモデルと同じ扱い）
  const designOptions = designs.some((design) => design.id === draft.id)
    ? designs
    : [...designs, { id: draft.id, title: `${draft.id}（登録されていません）` }]

  return (
    <li role="group" aria-label={label} className={ITEM_BOX}>
      <div className="flex items-center gap-1 p-2">
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
            <span className="truncate font-medium">{label}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{rectSummary(draft)}</span>
          </span>
        </Button>
        {/* 一覧では上にあるものが前なので、「前面へ」がひとつ上、「背面へ」がひとつ下に当たる */}
        <Button type="button" variant="ghost" size="sm" aria-label={`${label}をひとつ前面へ`} disabled={!canMoveFront} onClick={() => onMove(1)}>
          前面へ
        </Button>
        <Button type="button" variant="ghost" size="sm" aria-label={`${label}をひとつ背面へ`} disabled={!canMoveBack} onClick={() => onMove(-1)}>
          背面へ
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label={`${label}を外す`} className="text-destructive" onClick={onRemove}>
          <Trash2 aria-hidden="true" />
        </Button>
      </div>

      {/* 保存済みの値を読めなかった理由は、畳んでいても見えるようにする（気づかないまま保存させない） */}
      {draft.problem !== undefined && <p className="px-3 pb-2 text-xs text-destructive">{draft.problem}</p>}

      {open && (
        <div id={`${id}-detail`} className="grid gap-5 border-t p-4 sm:grid-cols-2">
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
              <legend className="mb-2 text-sm font-medium">オーバーレイの中での位置と大きさ（幅・高さに対する割合）</legend>
              {RECT_FIELDS.map((field) => (
                <div key={field.key} className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-${field.key}`} className="text-xs font-normal text-muted-foreground">
                    {field.label}
                  </Label>
                  {/* 空欄は 0 に丸めず、そのままWorkerへ送って理由を返させる（検証はWorkerだけが持つ） */}
                  <Input
                    id={`${id}-${field.key}`}
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
            {schema === undefined ? (
              <p className="text-sm text-muted-foreground">デザインを選び直すと、その素材のパラメータを調整できます。</p>
            ) : Object.keys(schema).length === 0 ? (
              <p className="text-sm text-muted-foreground">この素材に、配信者が決めるパラメータはありません。</p>
            ) : (
              Object.entries(schema).map(([name, spec]) => (
                <ParamField
                  // デザインを変えたら、同じ名前のパラメータでも入力欄を作り直す（前のデザインの色を覚えたままにしない）
                  key={`${draft.id}-${name}`}
                  name={name}
                  spec={spec}
                  value={draft.values[name] ?? spec.default}
                  onChange={(value: AnyParamValue) => onChange({ ...draft, values: { ...draft.values, [name]: value } })}
                />
              ))
            )}
          </div>
        </div>
      )}
    </li>
  )
}

interface OverlayCardProps {
  draft: OverlayDraft
  overlayNames: readonly string[]
  overlayKey: string | null
  /** 開いている素材の識別子（オーバーレイをまたいで1つだけ開く） */
  openItemKey: number | undefined
  onToggleItem(key: number): void
  /** 素材の設定を開く（畳まない。配置用の枠でつまんだときに使う） */
  onOpenItem(key: number): void
  /** このオーバーレイのプレビューを開いているか（同時に開くのは1つだけ） */
  previewOpen: boolean
  onTogglePreview(): void
  onChange(draft: OverlayDraft): void
  onMoveItemToOverlay(item: ItemDraft, to: string): void
  onAskRemoveItem(item: ItemDraft): void
  onAskRemove(): void
  onCopyUrl(url: string): void
  /** 一覧の中でこのオーバーレイを動かせるか（端のオーバーレイでは押せなくする） */
  canMoveUp: boolean
  canMoveDown: boolean
  onMove(offset: number): void
}

/** オーバーレイ1つ（＝OBSのブラウザソース1つ）ぶんのカード。積んだ素材と、貼るURLを持つ */
const OverlayCard = ({
  draft,
  overlayNames,
  overlayKey,
  openItemKey,
  onToggleItem,
  onOpenItem,
  previewOpen,
  onTogglePreview,
  onChange,
  onMoveItemToOverlay,
  onAskRemoveItem,
  onAskRemove,
  onCopyUrl,
  canMoveUp,
  canMoveDown,
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

  /** 配置用の枠でドラッグした結果を、その素材の位置と大きさへ書き戻す */
  const changeRect = (key: number, rect: RectDraft): void =>
    onChange({ ...draft, items: draft.items.map((current) => (current.key === key ? { ...current, rect } : current)) })

  return (
    <Card role="group" aria-label={`オーバーレイ「${draft.name}」`}>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle>
              オーバーレイ <code className="font-mono">{draft.name}</code>
            </CardTitle>
            <CardDescription>OBSのブラウザソース1つぶん。この中の素材は、上にあるものが前に出る（オーバーレイ同士の並びは重なりと関わらない）。</CardDescription>
          </div>
          <div className="flex items-center gap-1">
            {/* オーバーレイ同士の並びは重なりと関わらない（別々のブラウザソースなので）。編集しやすい順に並べ替えるためのもの */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`オーバーレイ「${draft.name}」をひとつ上へ`}
              disabled={!canMoveUp}
              onClick={() => onMove(-1)}
            >
              上へ
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`オーバーレイ「${draft.name}」をひとつ下へ`}
              disabled={!canMoveDown}
              onClick={() => onMove(1)}
            >
              下へ
            </Button>
            <Button type="button" variant="ghost" size="icon" aria-label={`オーバーレイ「${draft.name}」を外す`} className="text-destructive" onClick={onAskRemove}>
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {draft.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">まだ素材がありません。素材を置くまでは保存されません（貼っても何も映らないためです）。</p>
        ) : (
          <>
            <PlacementBox items={draft.items} openItemKey={openItemKey} onOpenItem={onOpenItem} onChangeRect={changeRect} />
            {/* プレビューは見ているあいだだけ動かす（閉じたら iframe ごと外す） */}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" size="sm" onClick={onTogglePreview}>
                {previewOpen ? 'プレビューを閉じる' : 'プレビューを見る'}
              </Button>
              <p className="text-sm text-muted-foreground">
                素材の中身はサンプルです（Twitch にも Worker にもつながず、編集中の位置とパラメータをそのまま映します）。
              </p>
            </div>
            {previewOpen && <PreviewFrame draft={draft} />}
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
              />
            ))}
            </ul>
          </>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-kind`}>足す素材の種類</Label>
            <NativeSelect
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
          </div>
          {designsFor(newKind).length > 0 && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-design`}>足す素材のデザイン</Label>
              <NativeSelect id={`${id}-design`} className="w-44" value={newId} onChange={(event) => setNewId(event.currentTarget.value)}>
                {designsFor(newKind).map((design) => (
                  <NativeSelectOption key={design.id} value={design.id}>
                    {design.title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          {/* 足した素材はいちばん前（構成では並びの末尾、一覧ではいちばん上）に、いっぱいの大きさで入る */}
          <Button type="button" onClick={() => onChange({ ...draft, items: [...draft.items, newItemDraft(newKind, newId)] })}>
            素材を足す
          </Button>
        </div>

        {/* キーが無いときの理由はページの先頭に1度だけ出す（カードごとに繰り返さない） */}
        {url !== null && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-url`}>OBSのブラウザソースに貼るURL</Label>
            <p id={`${id}-size`} className="text-sm text-muted-foreground">
              推奨の大きさ: {STAGE_SIZE.width} × {STAGE_SIZE.height} px（配信画面と同じ大きさ。中の位置と大きさは割合で決まる）
            </p>
            <div className="flex gap-2">
              {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
              <Input id={`${id}-url`} type="password" readOnly autoComplete="off" value={url} aria-describedby={`${id}-size`} />
              <Button type="button" onClick={() => onCopyUrl(url)}>
                URLをコピー
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export const OverlayPage = ({ api, overlayKey }: { api: OverlayLayoutAdminApi; overlayKey: string | null }) => {
  const [drafts, setDrafts] = useState<readonly OverlayDraft[]>([])
  /** 読み込んだ（保存した）時点の中身。いまの中身と食い違えば「未保存の変更があります」と添える */
  const [savedJson, setSavedJson] = useState<string>()
  const [newName, setNewName] = useState('')
  /** 開いている素材の識別子。オーバーレイをまたいで1つだけ開く（一覧が長くなりすぎないようにする） */
  const [openItemKey, setOpenItemKey] = useState<number>()
  /**
   * プレビューを開いているオーバーレイの識別子。1つだけ開く。
   *
   * プレビューは重なりの1枚を丸ごと動かすので、同時に何枚も動かさないためであり、あわせて構成の
   * 取り違えも防ぐ（開いているプレビューが1つなら、構成を待っている知らせに答える相手も1つに定まる）。
   */
  const [previewOverlayKey, setPreviewOverlayKey] = useState<number>()
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
      setSavedJson(JSON.stringify(loaded))
      return ''
    })
    return () => {
      cancelled = true
    }
    // 読み込みは開いたときの1回だけにする（actions は描くたびに作り直されるので、依存には入れない）
  }, [api])

  const overlayNames = overlayNameChoices(drafts)
  const changed = savedJson !== undefined && savedJson !== JSON.stringify(drafts)
  /** 足そうとしている名前（前後の空白を落としたもの）と、それがすでに使われているか */
  const trimmedNewName = newName.trim()
  const nameTaken = drafts.some((draft) => draft.name === trimmedNewName)

  const update = (position: number, draft: OverlayDraft): void => setDrafts(drafts.map((current, index) => (index === position ? draft : current)))

  /** 素材を別のオーバーレイのいちばん前へ移す */
  const moveItemToOverlay = (item: ItemDraft, to: string): void => {
    if (!drafts.some((draft) => draft.name === to)) return
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
    setSavedJson(JSON.stringify(saved))
    return '構成を保存しました'
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
        drafts.map((draft, position) => (
          <OverlayCard
            key={draft.key}
            draft={draft}
            overlayNames={overlayNames}
            overlayKey={overlayKey}
            openItemKey={openItemKey}
            onToggleItem={(key) => setOpenItemKey(openItemKey === key ? undefined : key)}
            onOpenItem={setOpenItemKey}
            previewOpen={previewOverlayKey === draft.key}
            onTogglePreview={() => setPreviewOverlayKey(previewOverlayKey === draft.key ? undefined : draft.key)}
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
            canMoveUp={position > 0}
            canMoveDown={position < drafts.length - 1}
            onMove={(offset) => setDrafts(moveDraft(drafts, position, offset))}
          />
        ))
      )}

      <Card>
        <CardHeader>
          <CardTitle>オーバーレイを足す</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            {/* 見出しが「オーバーレイを足す」なので、入力欄の見出しは画面には出さず、読み上げにだけ残す */}
            {/* 名前の書式（英小文字・数字・ハイフン）は Worker が確かめる */}
            <Input
              id={nameFieldId}
              aria-label="足すオーバーレイの名前"
              aria-describedby={`${nameFieldId}-outline`}
              className="w-44"
              value={newName}
              placeholder="talk"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setNewName(event.currentTarget.value)}
            />
            {/* 見えている「足す」より長い名前を読み上げに渡す（何を足すのかは見出しにしか無いため） */}
            <Button
              type="button"
              aria-label="オーバーレイを足す"
              disabled={trimmedNewName === '' || nameTaken}
              onClick={() => {
                setDrafts([...drafts, newOverlayDraft(trimmedNewName)])
                setNewName('')
              }}
            >
              <Plus aria-hidden="true" />
              足す
            </Button>
          </div>
          {/* 名前がOBSに貼るURLに載ることは、文章で説明せずURLそのものを見せて分からせる */}
          <p id={`${nameFieldId}-outline`} className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
            {nameTaken ? (
              <span className="text-destructive">この名前のオーバーレイはすでにあります。別の名前にしてください。</span>
            ) : (
              trimmedNewName !== '' && <code className="font-mono break-all">{overlayStageUrlOutline(window.location.origin, trimmedNewName)}</code>
            )}
          </p>
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
