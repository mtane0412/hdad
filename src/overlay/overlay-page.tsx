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
 * 自動生成（src/core/gallery/fields.tsx の ParamField）を使う。
 *
 * 注意: 値の検証は Worker（worker/overlay-layout.ts）だけが持つ。画面は空欄を 0 に丸めず、返ってきた
 * 問題点をオーバーレイと素材の名前へ読み替えて並べる（issue #86 で決めた「画面とWorkerで二重に持たない」）。
 * 注意: 素材を1つも持たないオーバーレイは送らない（Workerが拒む。OBSに貼っても何も映らないURLを
 * 作らせないため）。足した名前は画面が覚えておき、素材を置いた時点で保存されるようにする。
 * 注意: 保存済みの値が読めない素材（レジストリに無いデザイン・範囲外のパラメータ）でも黙って捨てない。
 * 捨てると、開いて保存しただけでその素材が消える。理由を出して直させる（Fail-Fast）。
 * 注意: プレビュー（オーバーレイをそのまま iframe で試し見する）は入れていない。配信中のオーバーレイを
 * もう1つ動かすことになるため、まずは数値入力とOBS側での確認に留める（ドラッグでの配置と合わせて別 issue）。
 */
import { ChevronDown, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ApiError } from '../core/api'
import { ParamField } from '../core/gallery/fields'
import type { AnyParamValue } from '../core/params'
import type { OverlayLayoutAdminApi } from './admin-api'
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
import { ITEM_KINDS, type ItemKind } from './layout'
import { overlayStageUrl } from './url'

/** ブラウザソースに設定する推奨の大きさ。オーバーレイは配信画面と同じ大きさにして、割合（％）で中を置く */
const STAGE_SIZE = { width: 1920, height: 1080 }

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
 * 素材ページ側で「未対応のパラメータ」として拒まれる）。
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
            <CardDescription>OBSのブラウザソース1つぶんが「オーバーレイ」で、その中に素材を積む。</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">まだオーバーレイがありません。下の「オーバーレイを足す」から作ってください。</p>
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
          <CardDescription>
            アバターやゲーム画面を挟みたいところで分ける。名前はOBSに貼るURLに載るので、変えないかぎりURLは貼り替えなくてよい。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={nameFieldId}>足すオーバーレイの名前</Label>
            {/* 名前の書式（英小文字・数字・ハイフン）は Worker が確かめる */}
            <Input
              id={nameFieldId}
              className="w-44"
              value={newName}
              placeholder="talk"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setNewName(event.currentTarget.value)}
            />
          </div>
          <Button
            type="button"
            disabled={newName.trim() === '' || drafts.some((draft) => draft.name === newName.trim())}
            onClick={() => {
              setDrafts([...drafts, newOverlayDraft(newName.trim())])
              setNewName('')
            }}
          >
            オーバーレイを足す
          </Button>
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
