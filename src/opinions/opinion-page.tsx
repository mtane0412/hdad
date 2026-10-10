/**
 * 意見ボードのページ（/opinions/）
 *
 * 配信者がテーマを出して、視聴者のコメントから取り出した意見を論点ごとに並べる機能（issue #306）を操作する画面である。
 * - テーマを出す・締め切る。出しているあいだだけ、Worker がチャットのコメントを振り分けて意見にする
 * - 取り出した意見を論点ごとに、札の種類・人数・もとのコメントつきで確かめる（人数はこのページにだけ出し、合成ページには出さない）
 * - 荒らしや取り違えの意見を隠す・戻す（隠した意見は合成ページに出なくなる）
 * - 合成ページの中央下に出す視聴者への問いかけ（issue #307）を確かめ、別の問いかけに替えさせる（テーマを出しているあいだだけ）
 *
 * 意見は配信中に Worker が増やしていくので、開いているあいだは一定の間隔で読み直す（REFRESH_MS）。
 * 値の検証は Worker（worker/opinion.ts）だけが持ち、画面は返ってきた問題点を並べるだけにする。
 *
 * 注意: 入力しかけのテーマがあるあいだは、ページを離れる前に確認を出す（useUnsavedChanges）。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Link, useUnsavedChanges } from '@/app/router'
import { LoadFailure } from '@/components/load-failure'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/core/api'
import type { AdminOpinion, AdminOpinionBoard, OpinionApi } from './api'
import { OPINION_KIND_LABELS } from './entry'

/** 開いているあいだに意見ボードを読み直す間隔（ミリ秒）。Worker の振り分け（45秒おき）より短くし、増えた意見を待たせない */
const REFRESH_MS = 15_000

/**
 * 操作の失敗を、出す行にする。Worker が問題点を返したら（テーマの検証）、問題点を1行ずつ並べる。
 */
const opinionFailureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['テーマに問題があります。直してから出し直してください', ...error.problems.map((problem) => `・${problem}`)]
    : [errorMessage(error)]

/** 意見1件。隠す・戻すの操作と、もとのコメントを持つ */
const OpinionItem = ({ opinion, busy, onToggle }: { opinion: AdminOpinion; busy: boolean; onToggle(): void }) => (
  <li role="group" aria-label={`意見「${opinion.text}」`} className={`flex flex-col gap-2 rounded-lg border p-3 ${opinion.hidden ? 'opacity-60' : ''}`}>
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">{OPINION_KIND_LABELS[opinion.kind]}</Badge>
      <span className="font-medium">{opinion.text}</span>
      <span className="text-sm text-muted-foreground">{opinion.people}人</span>
      {opinion.hidden && <Badge variant="outline">隠しています</Badge>}
    </div>
    <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
      {opinion.sources.map((source, index) => (
        // 同じ人が同じ文を2回書くこともあるので、並び順を鍵に含める
        <li key={`${index}-${source.userName}`}>{`${source.userName}: ${source.text}`}</li>
      ))}
    </ul>
    <div>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onToggle}>
        {opinion.hidden ? '戻す' : '隠す'}
      </Button>
    </div>
  </li>
)

export const OpinionPage = ({ api }: { api: OpinionApi }) => {
  /** 最後に読んだ意見ボード。読み込むまでは undefined */
  const [board, setBoard] = useState<AdminOpinionBoard>()
  const [loadError, setLoadError] = useState<string>()
  /** 入力しかけのテーマ */
  const [title, setTitle] = useState('')
  const actions = usePageActions(opinionFailureLines)
  const titleId = useId()
  /**
   * 画面の操作の世代。操作で表示を書き換える前に進め、操作より前に始めた読み直しの結果は捨てる
   * （古い結果で、隠した意見や締め切ったテーマを元に戻さないため）
   */
  const generation = useRef(0)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      const startedAt = generation.current
      api.read().then(
        (next) => {
          if (cancelled || startedAt !== generation.current) return
          setBoard(next)
          setLoadError(undefined)
        },
        (error: unknown) => {
          if (!cancelled) setLoadError(errorMessage(error))
        },
      )
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [api])

  /** 出しているテーマ。出していなければ null（締め切ったテーマは含めない） */
  const openTheme = board?.theme !== undefined && board.theme !== null && board.theme.closedAt === null ? board.theme : null
  useUnsavedChanges(openTheme === null && title.trim() !== '')

  if (loadError !== undefined && board === undefined) return <LoadFailure title="意見ボードを読み込めませんでした" message={loadError} />
  if (board === undefined) return <Skeleton className="h-48 w-full" />

  const open = (): Promise<void> =>
    actions.run(async () => {
      const theme = await api.openTheme(title)
      generation.current += 1
      setBoard({ theme, topics: [] })
      setTitle('')
      return `テーマ「${theme.title}」を出しました`
    })

  const askClose = (themeId: number): void =>
    actions.ask({
      title: 'テーマを締め切りますか？',
      description: '締め切ると、それ以降のコメントは意見にしません。合成ページには、次のテーマを出すまで締め切ったテーマの意見ボードが残ります。',
      actionLabel: 'テーマを締め切る',
      run: async () => {
        const theme = await api.closeTheme(themeId)
        generation.current += 1
        setBoard((previous) => (previous === undefined ? previous : { ...previous, theme }))
        return `テーマ「${theme.title}」を締め切りました`
      },
    })

  const replacePrompt = (themeId: number): Promise<void> =>
    actions.run(async () => {
      const theme = await api.replacePrompt(themeId)
      generation.current += 1
      setBoard((previous) => (previous === undefined ? previous : { ...previous, theme }))
      return '問いかけを替えました'
    })

  const toggle = (opinion: AdminOpinion): Promise<void> =>
    actions.run(async () => {
      const hidden = !opinion.hidden
      await api.setHidden(opinion.id, hidden)
      generation.current += 1
      setBoard((previous) =>
        previous === undefined
          ? previous
          : {
              ...previous,
              topics: previous.topics.map((topic) => ({
                ...topic,
                opinions: topic.opinions.map((current) => (current.id === opinion.id ? { ...current, hidden } : current)),
              })),
            },
      )
      return hidden ? `「${opinion.text}」を隠しました` : `「${opinion.text}」を戻しました`
    })

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}
      {loadError !== undefined && <p className="text-sm text-destructive">{loadError}</p>}
      <Card>
        <CardHeader>
          <CardTitle>テーマ</CardTitle>
          <CardDescription>
            テーマを出しているあいだ、チャットのコメントから意見を取り出して論点ごとに並べます。
            <Link href="/overlay/" className="underline underline-offset-4">オーバーレイ</Link>で素材「意見ボード」を置くと配信画面に映ります（人数は映しません）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {openTheme !== null ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-lg font-semibold">{openTheme.title}</span>
                <Button type="button" variant="outline" disabled={actions.busy} onClick={() => askClose(openTheme.id)}>
                  締め切る
                </Button>
              </div>
              <section role="group" aria-label="視聴者への問いかけ" className="flex flex-col gap-2 rounded-lg border border-dashed p-3">
                <h2 className="text-sm font-semibold text-muted-foreground">こんな観点からも聞いてみたい（合成ページの中央下に出ます）</h2>
                {openTheme.prompt !== null ? (
                  <p className="font-medium">{openTheme.prompt}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">まだ問いかけはありません。最初の意見が出たら作ります。</p>
                )}
                <div>
                  <Button type="button" size="sm" variant="outline" disabled={actions.busy} onClick={() => void replacePrompt(openTheme.id)}>
                    別の問いかけにする
                  </Button>
                </div>
              </section>
            </>
          ) : (
            <>
              {board.theme !== null && <p className="text-sm text-muted-foreground">{`締め切ったテーマ: ${board.theme.title}`}</p>}
              <div className="flex flex-col gap-2">
                <Label htmlFor={titleId}>テーマ</Label>
                <Input id={titleId} value={title} placeholder="例: 配信中にAIをどこまで使っていい？" onChange={(event) => setTitle(event.currentTarget.value)} />
              </div>
              <div>
                <Button type="button" disabled={actions.busy} onClick={() => void open()}>
                  テーマを出す
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      {board.theme !== null && (
        <Card>
          <CardHeader>
            <CardTitle>意見</CardTitle>
            <CardDescription>コメントから取り出した意見です。荒らしや取り違えの意見は「隠す」と合成ページに出なくなります。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {board.topics.length === 0 && <p className="text-sm text-muted-foreground">まだ意見がありません。コメントは45秒ほどおきにまとめて振り分けます。</p>}
            {board.topics.map((topic) => (
              <section key={topic.id} role="group" aria-label={`論点「${topic.title}」`} className="flex flex-col gap-2">
                <h2 className="font-semibold">{topic.title}</h2>
                <ul className="flex flex-col gap-2">
                  {topic.opinions.map((opinion) => (
                    <OpinionItem key={opinion.id} opinion={opinion} busy={actions.busy} onToggle={() => void toggle(opinion)} />
                  ))}
                </ul>
              </section>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
