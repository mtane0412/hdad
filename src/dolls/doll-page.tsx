/**
 * 人形のページ（/dolls/）
 *
 * 視聴者に渡す人形（issue #418）の組を、追加・名前と画像の書き換え・削除し、配信で使う組を「いまの人形」に選ぶ画面である。
 * 1組は「ふつうの人形」と「スーパー人形（ふつうの人形 SUPER_DOLL_VALUE 個分）」の2種類で、それぞれ名前と画像を持つ。
 * 画像はアップロードのページで追加した画像の素材から選ぶ。視聴者が持っている数と手での受け渡しは視聴者のページにある。
 *
 * 組は1組ずつ別々に保存する（1組を書き換えるために、ほかの組の書きかけまで送らないため）。
 * 値の検証は Worker（worker/doll.ts）だけが持ち、画面は返ってきた問題点を並べるだけにする（form.ts）。
 *
 * 注意: 保存していない変更（書きかけの組・追加しかけの組）があるあいだは、ページを離れる前に確認を出す（useUnsavedChanges）。
 * 注意: いまの人形の選び直しは、押したその場で Worker に保存する（保存のボタンを待たない。配信の前に1回選ぶだけの操作なので）。
 */
import { useEffect, useId, useState } from 'react'
import type { MediaItem } from '@/admin/api'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Link, useUnsavedChanges } from '@/app/router'
import { StatusDot, Tag } from '@/components/data/data-display'
import { DataTable, DataTableCell, DataTableRow } from '@/components/data/data-table'
import { LoadFailure } from '@/components/load-failure'
import { SaveBar } from '@/components/save-bar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import type { DollApi } from './api'
import { SUPER_DOLL_VALUE, type DollFigure, type DollKind, type DollSet } from './doll'
import { EMPTY_DOLL_DRAFT, dollFailureLines, draftOf, sameDraft, type DollDraft } from './form'

/** 素材の中身の経路。この画面は配信者のセッションで読めるので、オーバーレイ用キーは付けない */
const MEDIA_PATH = '/api/media/'

/** 選択欄で「選ばない」を表す値（Worker は空の ID を「存在しない素材」として拒む） */
const NONE = ''

/** 種類ごとの画面の言い方 */
const KIND_LABELS: Readonly<Record<DollKind, string>> = { normal: 'ふつうの人形', super: 'スーパー人形' }

/** 行の列（ふつうの人形・スーパー人形・いまの人形の印・未保存の印）。どの行も同じ幅にし、上下で列をそろえる */
const DOLL_COLUMNS = 'minmax(0,1fr) minmax(0,1fr) 6rem 4.5rem'

/** 列の見出し。印の列は、印そのものが語を持つので見出しを置かない */
const DOLL_HEADINGS = [{ label: 'ふつうの人形' }, { label: 'スーパー人形' }, { label: '' }, { label: '' }] as const

/** 人形の画像を小さく出す。画像を選んでいなければ何も出さない */
const DollImage = ({ mediaId, className }: { mediaId: string; className: string }) =>
  mediaId === NONE ? null : <img src={`${MEDIA_PATH}${encodeURIComponent(mediaId)}`} alt="" loading="lazy" className={className} />

/** 一覧の1つのセルに、人形の画像と名前を並べる */
const FigureCell = ({ figure }: { figure: DollFigure }) => (
  <span className="flex min-w-0 items-center gap-2">
    <DollImage mediaId={figure.mediaId} className="size-6 shrink-0 rounded-sm object-contain" />
    <span className="truncate">{figure.name}</span>
  </span>
)

/**
 * 人形1種類ぶんの名前と画像の入力欄。
 *
 * @param images 選べる画像（アップロード済みの素材のうち画像だけ）
 */
const FigureFields = ({ kind, value, images, onChange }: { kind: DollKind; value: DollFigure; images: readonly MediaItem[]; onChange(value: DollFigure): void }) => {
  const id = useId()
  const label = KIND_LABELS[kind]
  // 一覧に無い素材が選ばれていれば、別の画像に見せずにそのまま出す（使われている画像は消せないので、ふつうは起きない）
  const missing = value.mediaId !== NONE && !images.some((item) => item.id === value.mediaId)
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor={`${id}-name`}>{`${label}の名前`}</Label>
        <Input id={`${id}-name`} value={value.name} placeholder={kind === 'normal' ? '例: クマ人形' : '例: スーパークマ人形'} onChange={(event) => onChange({ ...value, name: event.currentTarget.value })} />
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor={`${id}-image`}>{`${label}の画像`}</Label>
        <div className="flex items-center gap-2">
          <NativeSelect id={`${id}-image`} className="w-full" value={value.mediaId} onChange={(event) => onChange({ ...value, mediaId: event.currentTarget.value })}>
            <NativeSelectOption value={NONE}>選ばない</NativeSelectOption>
            {missing && <NativeSelectOption value={value.mediaId}>見つからない素材（{value.mediaId}）</NativeSelectOption>}
            {images.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <DollImage mediaId={value.mediaId} className="size-9 shrink-0 rounded-md border object-contain" />
        </div>
      </div>
    </div>
  )
}

/** 人形の組（ふつうの人形とスーパー人形）の入力欄の組。保存済みの組と、追加の入力欄で同じものを使う */
const DollFields = ({ value, images, onChange }: { value: DollDraft; images: readonly MediaItem[]; onChange(value: DollDraft): void }) => (
  <div className="flex flex-col gap-4">
    <FigureFields kind="normal" value={value.normal} images={images} onChange={(normal) => onChange({ ...value, normal })} />
    <FigureFields kind="super" value={value.super} images={images} onChange={(superFigure) => onChange({ ...value, super: superFigure })} />
  </div>
)

type Loaded = { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready'; images: readonly MediaItem[] }

/**
 * @param loadMedia アップロード済みの素材を読む（画像だけを選択肢にする）。描き直しても同じ関数を渡す（読み直しを繰り返さないため）
 */
export const DollPage = ({ api, loadMedia }: { api: DollApi; loadMedia(): Promise<MediaItem[]> }) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  /** 保存済みの組（追加した順） */
  const [saved, setSaved] = useState<readonly DollSet[]>([])
  /** 組ごとの書きかけ（ID ごと）。保存済みと同じなら未保存の変更は無い */
  const [drafts, setDrafts] = useState<ReadonlyMap<number, DollDraft>>(new Map())
  /** 追加の入力欄の中身 */
  const [added, setAdded] = useState<DollDraft>(EMPTY_DOLL_DRAFT)
  /** 入力欄を開いている組の ID。一覧を見渡せるよう、開くのは1組ずつにする */
  const [openId, setOpenId] = useState<number | null>(null)
  const actions = usePageActions(dollFailureLines)

  useEffect(() => {
    let cancelled = false
    Promise.all([api.list(), loadMedia()]).then(
      ([{ sets }, media]) => {
        if (cancelled) return
        setSaved(sets)
        setLoaded({ status: 'ready', images: media.filter((item) => item.kind === 'image') })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, loadMedia])

  const currentDraft = (set: DollSet): DollDraft => drafts.get(set.id) ?? draftOf(set)
  const changed = saved.some((set) => !sameDraft(currentDraft(set), draftOf(set))) || !sameDraft(added, EMPTY_DOLL_DRAFT)
  useUnsavedChanges(changed)

  if (loaded.status === 'failed') return <LoadFailure title="人形を読み込めませんでした" message={loaded.message} />
  if (loaded.status === 'loading') return <Skeleton className="h-48 w-full" aria-label="人形を読み込んでいます" />
  const { images } = loaded

  /** 保存した組を、Worker が返したもので置き換え、書きかけを捨てる */
  const replace = (set: DollSet): void => {
    setSaved((previous) => previous.map((current) => (current.id === set.id ? set : current)))
    setDrafts((previous) => {
      const next = new Map(previous)
      next.delete(set.id)
      return next
    })
  }

  const save = (set: DollSet): Promise<void> =>
    actions.run(async () => {
      const updated = await api.update(set.id, currentDraft(set))
      replace(updated)
      return `「${updated.normal.name}」を保存しました`
    })

  const add = (): Promise<void> =>
    actions.run(async () => {
      const set = await api.create(added)
      setSaved((previous) => [...previous, set])
      setAdded(EMPTY_DOLL_DRAFT)
      return `「${set.normal.name}」を追加しました`
    })

  /** いまの人形を選び直す（null なら外す）。Worker が返した一覧で、すべての組の印を描き直す */
  const selectCurrent = (set: DollSet, setId: number | null): Promise<void> =>
    actions.run(async () => {
      const sets = await api.selectCurrent(setId)
      // 書きかけは保ったまま、印（current）だけを Worker が返したものにする
      setSaved((previous) => previous.map((current) => sets.find((other) => other.id === current.id) ?? current))
      return setId === null ? `「${set.normal.name}」をいまの人形から外しました` : `「${set.normal.name}」をいまの人形にしました`
    })

  const askRemove = (set: DollSet): void =>
    actions.ask({
      title: `「${set.normal.name}」を消しますか？`,
      description: '一度でも視聴者に渡したことのある人形は、集めた記録が残っているので消せません。',
      actionLabel: '人形を消す',
      run: async () => {
        await api.remove(set.id)
        setSaved((previous) => previous.filter((current) => current.id !== set.id))
        setDrafts((previous) => {
          const next = new Map(previous)
          next.delete(set.id)
          return next
        })
        return `「${set.normal.name}」を消しました`
      },
    })

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}
      <Card>
        <CardHeader>
          <CardTitle>人形</CardTitle>
          <CardDescription>
            {`視聴者に渡す人形です。ふつうの人形と、ふつうの人形${SUPER_DOLL_VALUE}つ分のスーパー人形を1組にして登録し、配信で使う組を「いまの人形」に選びます。`}
            渡した人形は配信をまたいで残り、
            <Link href="/viewers/" className="underline underline-offset-4">
              視聴者
            </Link>
            のページで数を見たり、手で渡したりできます。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col">
          {saved.length === 0 ? (
            <p className="text-sm text-muted-foreground">まだ人形がありません。下で追加してください。</p>
          ) : (
            <DataTable label="人形の一覧" columns={DOLL_COLUMNS} headings={DOLL_HEADINGS}>
              {saved.map((set) => {
                const draft = currentDraft(set)
                const unsaved = !sameDraft(draft, draftOf(set))
                const open = openId === set.id
                return (
                  <DataTableRow
                    key={set.id}
                    label={`人形「${set.normal.name}」`}
                    // 行を押すと、その場で下に入力欄が開く（もう一度押すと閉じる）
                    expand={{
                      open,
                      onToggle: () => setOpenId(open ? null : set.id),
                      detail: (
                        <>
                          <DollFields value={draft} images={images} onChange={(next) => setDrafts((previous) => new Map(previous).set(set.id, next))} />
                          <SaveBar label="保存する" name={`${set.normal.name} を保存する`} busy={actions.busy} unsaved={unsaved} onSave={() => void save(set)}>
                            <Button type="button" variant="outline" disabled={actions.busy} onClick={() => void selectCurrent(set, set.current ? null : set.id)}>
                              {set.current ? 'いまの人形から外す' : 'いまの人形にする'}
                            </Button>
                            <Button type="button" variant="outline" className="text-destructive" disabled={actions.busy} onClick={() => askRemove(set)}>
                              消す
                            </Button>
                          </SaveBar>
                        </>
                      ),
                    }}
                  >
                    <DataTableCell>
                      <FigureCell figure={set.normal} />
                    </DataTableCell>
                    <DataTableCell>
                      <FigureCell figure={set.super} />
                    </DataTableCell>
                    <DataTableCell>{set.current && <Tag tone="teal">いまの人形</Tag>}</DataTableCell>
                    {/* 閉じた行でも、保存していない書きかけがあることを見落とさないようにする */}
                    <DataTableCell>{unsaved && <StatusDot tone="attention">未保存</StatusDot>}</DataTableCell>
                  </DataTableRow>
                )
              })}
            </DataTable>
          )}
        </CardContent>
      </Card>
      <Card role="group" aria-label="人形を追加">
        <CardHeader>
          <CardTitle>人形を追加</CardTitle>
          <CardDescription>
            画像は
            <Link href="/media/" className="underline underline-offset-4">
              アップロード
            </Link>
            のページで追加した画像から選びます。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <DollFields value={added} images={images} onChange={setAdded} />
          <div>
            <Button type="button" disabled={actions.busy} onClick={() => void add()}>
              追加する
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
