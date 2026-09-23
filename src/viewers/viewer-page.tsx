/**
 * 視聴者のページ
 *
 * チャットで発言した人の記録（Workerが貯めたもの）を一覧で出し、配信者がメモを書いたり、記録を消したりする。
 * ログインの確認とログアウトはアプリの枠（src/app/app.tsx）が受け持つので、ここではログイン済みを前提にする。
 * Workerの呼び出しは api.ts、操作の実行と結果の表示は `@/admin/page-actions` に任せる。
 *
 * 注意: 件数が多くなるので全件は出さず、PAGE_SIZE 件ずつ読む。続きは一覧の最後の人の「最後の発言日時」を目印に取る。
 * 注意: 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。一覧を取得できなければ操作盤を出さない。
 */
import { useEffect, useId, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { formatDateTime } from '@/stats/summary'
import type { Viewer, ViewerApi, ViewerQuery } from './api'

/** 一度に読む件数。これと同じ件数が返ってきたら、まだ続きがあるとみなす */
const PAGE_SIZE = 50

/** バッジの種類の名前を、画面に出す日本語にする。ここに無い種類はそのまま出す */
const badgeLabels: Record<string, string> = {
  broadcaster: '配信者',
  moderator: 'モデレーター',
  vip: 'VIP',
  subscriber: 'サブスク',
}

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

export const ViewerPage = ({ api }: { api: ViewerApi }) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [viewers, setViewers] = useState<readonly Viewer[]>([])
  /** メモの下書き（保存するまでの入力。ユーザーIDごとに持つ） */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [search, setSearch] = useState('')
  const [hasMore, setHasMore] = useState(false)
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
      <Alert variant="destructive">
        <AlertTitle>読み込みに失敗しました</AlertTitle>
        <AlertDescription>視聴者の記録を表示できません: {loaded.message}</AlertDescription>
      </Alert>
    )
  }

  /** 一覧を取り直す（検索）か、続きを足す（もっと読み込む） */
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
    <div className="flex max-w-4xl flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        チャットで発言した人の記録。サブスクやVIPの状態はTwitchが持つものなので、最後に見たバッジを控えるだけにしている。
      </p>

      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>視聴者</CardTitle>
          <CardDescription>最後に発言した順に並ぶ。メモは配信者だけが見られる。</CardDescription>
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
              <Button type="submit" disabled={actions.busy}>
                検索
              </Button>
            </div>
          </form>

          {viewers.length === 0 ? (
            <p className="text-sm text-muted-foreground">記録のある人はまだありません。</p>
          ) : (
            <ul aria-label="視聴者の一覧" className="flex flex-col gap-3">
              {viewers.map((viewer) => (
                <li key={viewer.userId} className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <strong className="text-sm font-medium">{viewer.displayName}</strong>
                    <span className="text-xs text-muted-foreground">{`@${viewer.login}`}</span>
                    {viewer.badges.map((badge) => (
                      <span key={badge} className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        {badgeLabels[badge] ?? badge}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {`${viewer.messageCount}回発言・初回 ${formatDateTime(viewer.firstSeenAt)}・最後 ${formatDateTime(viewer.lastSeenAt)}`}
                  </p>
                  <Textarea
                    aria-label={`${viewer.displayName} へのメモ`}
                    rows={2}
                    value={drafts[viewer.userId] ?? viewer.note}
                    placeholder="どういう人か、何を話したか"
                    onChange={(event) => setDrafts((current) => ({ ...current, [viewer.userId]: event.target.value }))}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      aria-label={`${viewer.displayName} のメモを保存`}
                      disabled={actions.busy}
                      onClick={() => void actions.run(() => saveNote(viewer))}
                    >
                      メモを保存
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      aria-label={`${viewer.displayName} の記録を削除`}
                      disabled={actions.busy}
                      onClick={() =>
                        actions.ask({
                          title: `${viewer.displayName} の記録を削除しますか？`,
                          description: 'メモを含めて消え、元に戻せません。また発言があれば、初めての人として記録し直します。',
                          actionLabel: '削除する',
                          run: () => removeViewer(viewer),
                        })
                      }
                    >
                      削除
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {hasMore && (
            <Button
              type="button"
              variant="outline"
              disabled={actions.busy}
              // 続きは、いま出ている最後の人の「最後の発言日時」より前を取る（並びが最後の発言順なので、これで続きになる）
              onClick={() => void actions.run(() => load({ search, before: viewers[viewers.length - 1]?.lastSeenAt }, true))}
            >
              もっと読み込む
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
