/**
 * 合成オーバーレイの構成のページ（レイヤーの編集と、段ごとのOBS用URL）
 *
 * 素材を「レイヤー」として1枚のページ（overlay/stage/index.html）へ重ね、OBSのブラウザソースは
 * 「段」（group）ごとに1つで済ませる（issue #101）。その構成（どの段にどの素材をどこへ置くか）を
 * 配信者が編集する口がこのページである（issue #103）。構成を持つのは Worker（KVの overlay-layout）なので、
 * ここで保存すれば次にオーバーレイが読みに来た時点で反映され、OBSのURLは貼り替えなくてよい。
 *
 * 一覧の並びがそのまま重ねる順（あとのものが前）なので、上から順に「背面 → 前面」で並べる。
 * Workerの呼び出しは admin-api.ts、入力欄の値の変換とデザインのスキーマの引き当ては form.ts、
 * URLの組み立ては url.ts に分けてテストする。素材のパラメータの入力欄は、ギャラリーと同じ
 * 自動生成（src/core/gallery/fields.tsx の ParamField）を使う。
 *
 * 注意: 値の検証は Worker（worker/overlay-layout.ts）だけが持つ。画面は空欄を 0 に丸めず、返ってきた
 * 問題点をレイヤーの名前へ読み替えて並べる（issue #86 で決めた「画面とWorkerで二重に持たない」）。
 * 注意: 保存済みの値が読めないレイヤー（レジストリに無いデザイン・範囲外のパラメータ）でも黙って捨てない。
 * 捨てると、開いて保存しただけでそのレイヤーが消える。理由を出して直させる（Fail-Fast）。
 * 注意: プレビュー（段をそのまま iframe で試し見する）は入れていない。配信中の段をもう1つ動かすことに
 * なるため、まずは数値入力とOBS側での確認に留める（ドラッグでの配置と合わせて別 issue）。
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
  describeLayerProblem,
  designsFor,
  groupChoices,
  layerLabel,
  LAYER_KIND_LABELS,
  newLayerDraft,
  schemaFor,
  toLayerDrafts,
  toLayers,
  type LayerDraft,
  type RectDraft,
} from './form'
import { LAYER_KINDS, type LayerKind } from './layout'
import { overlayStageUrl } from './url'

/** ブラウザソースに設定する推奨の大きさ。段は配信画面と同じ大きさにして、割合（％）で中を置く */
const STAGE_SIZE = { width: 1920, height: 1080 }

/** 位置と大きさの入力欄（％）。並べる順と見出しをここで決める */
const RECT_FIELDS: readonly { key: keyof RectDraft; label: string }[] = [
  { key: 'x', label: '左端の位置（％）' },
  { key: 'y', label: '上端の位置（％）' },
  { key: 'width', label: '幅（％）' },
  { key: 'height', label: '高さ（％）' },
]

/** レイヤーの枠の見た目（/triggers/ の項目の枠と同じ扱い。カードの中にカードを並べて見せない） */
const LAYER_BOX = 'overflow-hidden rounded-lg border'

/** 失敗を画面に出す行にする。設定の問題点は、送った順のレイヤーの名前へ読み替えて1行ずつ並べる */
const failureLines = (error: unknown, labels: readonly string[]): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['オーバーレイの構成に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeLayerProblem(problem, labels)}`)]
    : [errorMessage(error)]

/** そのレイヤーがどこに置かれているかの要約（見出しに出す） */
const rectSummary = (draft: LayerDraft): string =>
  `${draft.group} の段 / 左${draft.rect.x}% 上${draft.rect.y}% 幅${draft.rect.width}% 高さ${draft.rect.height}%`

interface LayerRowProps {
  draft: LayerDraft
  groups: readonly string[]
  open: boolean
  /** 前面へ・背面へ動かせるか（端のレイヤーでは押せなくする） */
  canMoveFront: boolean
  canMoveBack: boolean
  onToggle(): void
  onChange(draft: LayerDraft): void
  onMove(offset: number): void
  onRemove(): void
}

/**
 * レイヤー1件ぶんの操作盤。
 *
 * 項目が多いので、ふだんは要約だけを見出しに出して折りたたむ（/triggers/ と同じ扱い）。
 * デザインを変えたらパラメータは新しいデザインの既定値にする（前のデザインの名前が残ると、保存しても
 * 素材ページ側で「未対応のパラメータ」として拒まれる）。
 */
const LayerRow = ({ draft, groups, open, canMoveFront, canMoveBack, onToggle, onChange, onMove, onRemove }: LayerRowProps) => {
  const id = useId()
  const label = layerLabel(draft)
  const designs = designsFor(draft.kind)
  const schema = schemaFor(draft.kind, draft.id)
  // レジストリに無いデザインも選択欄に残す（開いただけで別のデザインへ移らないようにする。/llm/ のモデルと同じ扱い）
  const designOptions = designs.some((design) => design.id === draft.id) ? designs : [...designs, { id: draft.id, title: `${draft.id}（登録されていません）` }]

  return (
    <li role="group" aria-label={label} className={LAYER_BOX}>
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
        {/* 並びがそのまま重ねる順なので、動かす向きは一覧の上下ではなく「前面・背面」で言う */}
        <Button type="button" variant="ghost" size="sm" aria-label={`${label}をひとつ背面へ`} disabled={!canMoveBack} onClick={() => onMove(-1)}>
          背面へ
        </Button>
        <Button type="button" variant="ghost" size="sm" aria-label={`${label}をひとつ前面へ`} disabled={!canMoveFront} onClick={() => onMove(1)}>
          前面へ
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
                    const nextId = event.currentTarget.value
                    // パラメータはデザインごとに違うので、既定値から作り直す
                    onChange({ ...newLayerDraft(draft.kind, nextId, draft.group), rect: draft.rect })
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
              <Label htmlFor={`${id}-group`}>段</Label>
              <NativeSelect
                id={`${id}-group`}
                className="w-full"
                value={draft.group}
                onChange={(event) => onChange({ ...draft, group: event.currentTarget.value })}
              >
                {groups.map((group) => (
                  <NativeSelectOption key={group} value={group}>
                    {group}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <fieldset className="grid grid-cols-2 gap-3">
              <legend className="mb-2 text-sm font-medium">段の中での位置と大きさ（段の幅・高さに対する割合）</legend>
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
                  key={name}
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

/** 段1つぶんのOBS用URL（キーが入るので伏せ字で出す） */
const GroupUrl = ({ group, url, onCopy }: { group: string; url: string; onCopy(): void }) => {
  const fieldId = useId()
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={fieldId}>{group} の段のOBS用URL</Label>
      <div className="flex gap-2">
        {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
        <Input id={fieldId} type="password" readOnly autoComplete="off" value={url} />
        <Button type="button" aria-label={`${group} の段のURLをコピー`} onClick={onCopy}>
          コピー
        </Button>
      </div>
    </div>
  )
}

export const OverlayPage = ({ api, overlayKey }: { api: OverlayLayoutAdminApi; overlayKey: string | null }) => {
  const [drafts, setDrafts] = useState<readonly LayerDraft[]>([])
  /** 読み込んだ（保存した）時点の中身。いまの中身と食い違えば「未保存の変更があります」と添える */
  const [savedJson, setSavedJson] = useState<string>()
  /** 配信者がこの画面で足した段。レイヤーを置くまでは構成に現れないので、ここで覚えておく */
  const [addedGroups, setAddedGroups] = useState<readonly string[]>([])
  const [newGroup, setNewGroup] = useState('')
  const [openPosition, setOpenPosition] = useState<number>()
  const [newKind, setNewKind] = useState<LayerKind>('wallpaper')
  const [newId, setNewId] = useState(designsFor('wallpaper')[0]?.id ?? '')
  /** 送ったレイヤーの名前（送った順）。Workerが返した問題点の位置を読み替えるのに使う */
  const submittedLabelsRef = useRef<readonly string[]>([])
  const actions = usePageActions((error) => failureLines(error, submittedLabelsRef.current))
  const kindFieldId = useId()
  const designFieldId = useId()
  const groupFieldId = useId()
  const sizeHintId = useId()

  // 開いたときに保存済みの構成を読む
  useEffect(() => {
    let cancelled = false
    void actions.run(async () => {
      const layers = await api.load()
      if (cancelled) return ''
      const loaded = toLayerDrafts(layers)
      setDrafts(loaded)
      setSavedJson(JSON.stringify(loaded))
      return ''
    })
    return () => {
      cancelled = true
    }
    // 読み込みは開いたときの1回だけにする（actions は描くたびに作り直されるので、依存には入れない）
  }, [api])

  const groups = groupChoices(drafts, addedGroups)
  const changed = savedJson !== undefined && savedJson !== JSON.stringify(drafts)

  const update = (position: number, draft: LayerDraft): void => setDrafts(drafts.map((current, index) => (index === position ? draft : current)))

  /** レイヤーを1つ動かす。並びがそのまま重ねる順なので、動かすと開いている位置もついていく */
  const move = (position: number, offset: number): void => {
    const next = [...drafts]
    const [moved] = next.splice(position, 1)
    if (!moved) return
    next.splice(position + offset, 0, moved)
    setDrafts(next)
    setOpenPosition(openPosition === position ? position + offset : openPosition)
  }

  const remove = (position: number): void => {
    setDrafts(drafts.filter((_, index) => index !== position))
    // 外した行より後ろは位置が1つ繰り上がる
    setOpenPosition(openPosition === undefined || openPosition === position ? undefined : openPosition > position ? openPosition - 1 : openPosition)
  }

  const add = (): void => {
    const group = groups[0]
    if (group === undefined) return
    setDrafts([...drafts, newLayerDraft(newKind, newId, group)])
  }

  const save = async (): Promise<string> => {
    submittedLabelsRef.current = drafts.map(layerLabel)
    const savedDrafts = toLayerDrafts(await api.save(toLayers(drafts)))
    setDrafts(savedDrafts)
    setSavedJson(JSON.stringify(savedDrafts))
    return '構成を保存しました'
  }

  const copyUrl = async (url: string): Promise<string> => {
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    await navigator.clipboard.writeText(url)
    return 'OBS用のURLをコピーしました'
  }

  /** レイヤーが1つも無い段。ブラウザソースを置いても何も映らないので、URLを出す前に知らせる */
  const emptyGroups = groups.filter((group) => !drafts.some((draft) => draft.group === group))

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>レイヤー</CardTitle>
          <CardDescription>
            上から下へ重ねる（下にあるものが前に出る）。段ごとに1つのブラウザソースへまとまるので、アバターやゲーム画面を挟みたいところで段を分ける。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">まだレイヤーがありません。下の「レイヤーを足す」から置いてください。</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {drafts.map((draft, position) => (
                <LayerRow
                  // 並べ替えで位置が変わるので、位置ではなく「何番目に読み込んだ・足したか」では区別できない。
                  // 同じ種類・同じデザインのレイヤーも並べられるため、位置をキーにする（入力欄の中身は draft が持つ）
                  key={position}
                  draft={draft}
                  groups={groups}
                  open={openPosition === position}
                  canMoveBack={position > 0}
                  canMoveFront={position < drafts.length - 1}
                  onToggle={() => setOpenPosition(openPosition === position ? undefined : position)}
                  onChange={(next) => update(position, next)}
                  onMove={(offset) => move(position, offset)}
                  onRemove={() =>
                    actions.ask({
                      title: `${layerLabel(draft)}を外しますか？`,
                      description: 'このレイヤーの位置とパラメータは失われます。保存するまでは構成に反映されません。',
                      actionLabel: 'レイヤーを外す',
                      run: async () => {
                        remove(position)
                        return 'レイヤーを外しました（保存すると反映されます）'
                      },
                    })
                  }
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>レイヤーを足す</CardTitle>
          <CardDescription>足したレイヤーはいちばん前（一覧の末尾）に、段いっぱいの大きさで入る。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor={kindFieldId}>足すレイヤーの種類</Label>
            <NativeSelect
              id={kindFieldId}
              className="w-44"
              value={newKind}
              onChange={(event) => {
                const kind = LAYER_KINDS.find((candidate) => candidate === event.currentTarget.value) ?? 'wallpaper'
                setNewKind(kind)
                // デザインIDを持たない種類では空文字にする
                setNewId(designsFor(kind)[0]?.id ?? '')
              }}
            >
              {LAYER_KINDS.map((kind) => (
                <NativeSelectOption key={kind} value={kind}>
                  {LAYER_KIND_LABELS[kind]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {designsFor(newKind).length > 0 && (
            <div className="flex flex-col gap-2">
              <Label htmlFor={designFieldId}>足すレイヤーのデザイン</Label>
              <NativeSelect id={designFieldId} className="w-44" value={newId} onChange={(event) => setNewId(event.currentTarget.value)}>
                {designsFor(newKind).map((design) => (
                  <NativeSelectOption key={design.id} value={design.id}>
                    {design.title}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          )}
          <Button type="button" onClick={add}>
            レイヤーを足す
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>段とOBS用URL</CardTitle>
          <CardDescription>段ごとに1つのブラウザソースを置く。段の名前を変えないかぎり、このURLは貼り替えなくてよい。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor={groupFieldId}>足す段の名前</Label>
              {/* 段の名前の書式（英小文字・数字・ハイフン）は Worker が確かめる */}
              <Input
                id={groupFieldId}
                className="w-44"
                value={newGroup}
                placeholder="talk"
                spellCheck={false}
                autoCapitalize="off"
                onChange={(event) => setNewGroup(event.currentTarget.value)}
              />
            </div>
            <Button
              type="button"
              disabled={newGroup.trim() === ''}
              onClick={() => {
                setAddedGroups([...addedGroups, newGroup.trim()])
                setNewGroup('')
              }}
            >
              段を足す
            </Button>
          </div>

          {overlayKey === null ? (
            <Alert variant="destructive">
              <AlertTitle>OBS用のURLを表示できません</AlertTitle>
              <AlertDescription>オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください</AlertDescription>
            </Alert>
          ) : (
            <>
              <p id={sizeHintId} className="text-sm text-muted-foreground">
                推奨の大きさ: {STAGE_SIZE.width} × {STAGE_SIZE.height} px（配信画面と同じ大きさ。中の位置と大きさは割合で決まる）
              </p>
              {groups
                .filter((group) => drafts.some((draft) => draft.group === group))
                .map((group) => {
                  const url = overlayStageUrl(window.location.origin, overlayKey, group)
                  return <GroupUrl key={group} group={group} url={url} onCopy={() => void actions.run(() => copyUrl(url))} />
                })}
              {emptyGroups.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  レイヤーを置いていない段（{emptyGroups.join('・')}）のURLは出していません。段にレイヤーを置くと出ます。
                </p>
              )}
            </>
          )}
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
