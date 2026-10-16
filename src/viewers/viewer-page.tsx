/**
 * 視聴者のページ
 *
 * チャットで発言した人の記録（Workerが貯めたもの）を一覧で出し、配信者がメモを書いたり、記録を消したりする。
 * 配信が終わったあとにLLMが作った人物像（summary）も出すが、配信者が書いたメモ（note）とは別々に出す
 * （機械の推測と人が書いたものを混ぜない。人物像はここからは書き換えられない）。
 * ログインの確認とログアウトはアプリの枠（src/app/app.tsx）が受け持つので、ここではログイン済みを前提にする。
 * Workerの呼び出しは api.ts、操作の実行と結果の表示は `@/admin/page-actions` に任せる。
 *
 * 注意: 件数が多くなるので全件は出さず、PAGE_SIZE 件ずつ読む。続きは一覧の最後の人の「最後の発言日時」を目印に取る。
 * 注意: 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。一覧を取得できなければ操作盤を出さない。
 */
import { Search, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Identifier, Quantity, StatusDot } from '@/components/data/data-display'
import { DataTable, DataTableCell, DataTableRow } from '@/components/data/data-table'
import { SaveBar } from '@/components/save-bar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { formatDateTime } from '@/stats/summary'
import { iconButtonName } from '@/core/icon-button'
import type { Viewer, ViewerApi, ViewerChannel, ViewerQuery } from './api'

/** 一度に読む件数。これと同じ件数が返ってきたら、まだ続きがあるとみなす */
const PAGE_SIZE = 50

/** バッジの種類の名前を、画面に出す日本語にする。ここに無い種類はそのまま出す */
const badgeLabels: Record<string, string> = {
  broadcaster: '配信者',
  moderator: 'モデレーター',
  vip: 'VIP',
  subscriber: 'サブスク',
}

/**
 * 観測したその人自身のチャンネルの内容を、一覧に出す1行にする。
 *
 * 「調べたが配信した記録が無い」ことも書くのは、「まだ調べていない」（channel が null なので、この関数は呼ばれない）
 * と見分けられるようにするためである。配信者が画面で「この人は配信していない」と読み取れるのは、調べた場合だけである。
 */
const channelSummary = (channel: ViewerChannel): string => {
  const observedAt = `${formatDateTime(channel.checkedAt)}時点`
  if (channel.categoryName === '' && channel.title === '') return `自分では配信していないようです（${observedAt}）`
  // カテゴリだけ・タイトルだけが空のこともあるので、あるものだけをつなぐ
  const content = [channel.categoryName, channel.title === '' ? '' : `「${channel.title}」`].filter((part) => part !== '').join('')
  return `自分でも配信: ${content}（${observedAt}）`
}

/** 行の列（名前・発言回数・最後の発言・メモの有無）。見出しの行と人の行で同じ幅にし、上下で列をそろえる */
const VIEWER_COLUMNS = 'minmax(0,1fr) 4.5rem 8rem 4rem'

const VIEWER_HEADINGS = [{ label: '名前' }, { label: '発言', align: 'end' }, { label: '最後の発言' }, { label: 'メモ' }] as const

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

export const ViewerPage = ({ api }: { api: ViewerApi }) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [viewers, setViewers] = useState<readonly Viewer[]>([])
  /** メモの下書き（保存するまでの入力。ユーザーIDごとに持つ） */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [hasMore, setHasMore] = useState(false)
  /** 人物像とメモ欄を開いている人のユーザーID。一覧を見渡せるよう、開くのは1人ずつにする */
  const [openId, setOpenId] = useState<string | null>(null)
  const actions = usePageActions()
  const searchFieldId = useId()

  useEffect(() => {
    let cancelled = false
    api.list({ limit: PAGE_SIZE }).then(
      (firstPage) => {
        if (cancelled) return
        setViewers(firstPage)
        setHasMore(firstPage.length === PAGE_SIZE)
        setLoaded({ status: 'ready' })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  if (loaded.status === 'loading') return <Skeleton className="h-64 w-full" aria-label="視聴者の記録を読み込んでいます" />
  if (loaded.status === 'failed') {
    return (
      <LoadFailure title="視聴者の記録を表示できません" message={loaded.message} />
    )
  }

  /** 一覧を取り直す（検索）か、続きを追加する（もっと読み込む） */
  const load = async (query: ViewerQuery, append: boolean): Promise<string> => {
    const page = await api.list({ ...query, limit: PAGE_SIZE })
    setViewers((current) => (append ? [...current, ...page] : page))
    setHasMore(page.length === PAGE_SIZE)
    return append ? `${page.length}件を読み込みました` : `${page.length}件が見つかりました`
  }

  const saveNote = async (viewer: Viewer): Promise<string> => {
    const note = drafts[viewer.userId] ?? viewer.note
    const saved = await api.saveNote(viewer.userId, note)
    setViewers((current) => current.map((other) => (other.userId === viewer.userId ? { ...other, note: saved } : other)))
    return `${viewer.displayName} へのメモを保存しました`
  }

  const removeViewer = async (viewer: Viewer): Promise<string> => {
    await api.remove(viewer.userId)
    setViewers((current) => current.filter((other) => other.userId !== viewer.userId))
    return `${viewer.displayName} の記録を削除しました`
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>視聴者</CardTitle>
          <CardDescription>チャットで発言した人の記録。最後に発言した順に並ぶ。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void actions.run(() => load({ search }, false))
            }}
          >
            <Label htmlFor={searchFieldId}>ログイン名で検索</Label>
            <div className="flex gap-2">
              <Input
                id={searchFieldId}
                type="search"
                value={search}
                placeholder="前方一致（例: hana）"
                onChange={(event) => setSearch(event.target.value)}
              />
              <Button type="submit" size="icon" {...iconButtonName('検索')} disabled={actions.busy}>
                <Search aria-hidden="true" />
              </Button>
            </div>
          </form>

          {viewers.length === 0 ? (
            <p className="text-sm text-muted-foreground">記録のある人はまだありません。</p>
          ) : (
            <DataTable label="視聴者の一覧" columns={VIEWER_COLUMNS} headings={VIEWER_HEADINGS}>
              {viewers.map((viewer) => {
                const open = openId === viewer.userId
                const memo = drafts[viewer.userId] ?? viewer.note
                const unsaved = memo !== viewer.note
                return (
                  <DataTableRow
                    key={viewer.userId}
                    label={viewer.displayName}
                    // 行を押すと、その場で下に人物像・メモ欄・削除のボタンが開く（もう一度押すと閉じる）
                    expand={{
                      open,
                      onToggle: () => setOpenId(open ? null : viewer.userId),
                      detail: (
                        <>
                          <p className="text-xs text-muted-foreground">{`初回 ${formatDateTime(viewer.firstSeenAt)}`}</p>
                          {viewer.summary !== '' && (
                            <p className="rounded-md bg-muted px-3 py-2 text-xs">
                              <span className="text-muted-foreground">
                                {`AIによる人物像${viewer.summarizedAt === null ? '' : `（${formatDateTime(viewer.summarizedAt)}時点）`}: `}
                              </span>
                              {viewer.summary}
                            </p>
                          )}
                          <Textarea
                            aria-label={`${viewer.displayName} へのメモ`}
                            rows={2}
                            value={memo}
                            placeholder="どういう人か、何を話したか"
                            onChange={(event) => setDrafts((current) => ({ ...current, [viewer.userId]: event.target.value }))}
                          />
                          <SaveBar
                            label="メモを保存する"
                            name={`${viewer.displayName} のメモを保存する`}
                            busy={actions.busy}
                            unsaved={unsaved}
                            onSave={() => void actions.run(() => saveNote(viewer))}
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-destructive"
                              {...iconButtonName(`${viewer.displayName} の記録を削除`)}
                              disabled={actions.busy}
                              onClick={() =>
                                actions.ask({
                                  title: `${viewer.displayName} の記録を削除しますか？`,
                                  description: 'メモと人物像も消え、元に戻せません。次の発言では初めての人として記録し直します。',
                                  actionLabel: '削除する',
                                  run: () => removeViewer(viewer),
                                })
                              }
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </SaveBar>
                        </>
                      ),
                    }}
                  >
                    <DataTableCell>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span className="font-medium">{viewer.displayName}</span>
                          <Identifier prefix="@" className="text-muted-foreground">
                            {viewer.login}
                          </Identifier>
                          {viewer.badges.map((badge) => (
                            <span key={badge} className="rounded-sm border px-1 text-xs text-muted-foreground">
                              {badgeLabels[badge] ?? badge}
                            </span>
                          ))}
                        </span>
                        {/* 相手も配信者だと分かるよう、観測したカテゴリとタイトルは閉じた行にも出す */}
                        {viewer.channel !== null && <span className="truncate text-xs text-muted-foreground">{channelSummary(viewer.channel)}</span>}
                      </span>
                    </DataTableCell>
                    <DataTableCell align="end">
                      <Quantity value={viewer.messageCount} unit="回" />
                    </DataTableCell>
                    <DataTableCell className="text-xs text-muted-foreground tabular-nums">{formatDateTime(viewer.lastSeenAt)}</DataTableCell>
                    {/* 閉じた行でも、保存していない書きかけのメモがあることを見落とさないようにする */}
                    <DataTableCell className="text-xs text-muted-foreground">
                      {unsaved ? <StatusDot tone="attention">未保存</StatusDot> : viewer.note !== '' && 'メモあり'}
                    </DataTableCell>
                  </DataTableRow>
                )
              })}
            </DataTable>
          )}

          {hasMore && (
            <Button
              type="button"
              variant="outline"
              disabled={actions.busy}
              // 続きは、いま出ている最後の人より後ろを取る（並びが最後の発言順なので、これで続きになる）。
              // ユーザーIDも渡すのは、同じ日時に発言した人がここで途切れていても取りこぼさないため
              onClick={() =>
                void actions.run(() =>
                  load({ search, before: viewers[viewers.length - 1]?.lastSeenAt, beforeUserId: viewers[viewers.length - 1]?.userId }, true),
                )
              }
            >
              もっと読み込む
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
