/**
 * アップロードのページ
 *
 * アラートで流す素材（画像・動画・音声）を置き、一覧と削除を受け持つ。どの素材をどのイベントで流すかは
 * トリガーのページ（trigger-page.tsx）が決める。ログインの確認とログアウトはアプリの枠（src/app/app.tsx）が
 * 受け持つので、ここではログイン済みを前提にする。
 * Workerの呼び出しは api.ts、操作の実行と結果の表示は page-actions.tsx に任せる。
 *
 * 注意: 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。素材の一覧を取得できなければ操作盤を出さない。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import type { AdminApi, MediaItem } from './api'
import { formatBytes, kindLabels } from './form'
import { errorMessage, usePageActions } from './page-actions'

const MEDIA_PATH = '/api/media/'

/** 素材の中身のURL。この画面は配信者のセッションで読めるので、オーバーレイ用キーは付けない */
const mediaUrl = (id: string): string => `${MEDIA_PATH}${encodeURIComponent(id)}`

/** 素材を小さく試し見・試し聴きするための要素 */
const MediaPreview = ({ item }: { item: MediaItem }) => {
  const className = 'size-full object-contain'
  switch (item.kind) {
    case 'image':
      return <img src={mediaUrl(item.id)} alt="" loading="lazy" className={className} />
    // 一覧を開いただけで全素材を読み込まないよう、preload は none にする（動画は大きい）
    case 'video':
      return <video src={mediaUrl(item.id)} controls preload="none" aria-label={`${item.name} の再生`} className={className} />
    case 'audio':
      return <audio src={mediaUrl(item.id)} controls preload="none" aria-label={`${item.name} の再生`} className="w-full" />
  }
}

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

export const MediaPage = ({ api }: { api: AdminApi }) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [media, setMedia] = useState<readonly MediaItem[]>([])
  const actions = usePageActions()
  const fileRef = useRef<HTMLInputElement>(null)
  const fileFieldId = useId()

  useEffect(() => {
    let cancelled = false
    api.media().then(
      (loadedMedia) => {
        if (cancelled) return
        setMedia(loadedMedia)
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

  if (loaded.status === 'loading') return <Skeleton className="h-64 w-full" aria-label="素材を読み込んでいます" />
  if (loaded.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle>読み込みに失敗しました</AlertTitle>
        <AlertDescription>素材を表示できません: {loaded.message}</AlertDescription>
      </Alert>
    )
  }

  const upload = async (): Promise<string> => {
    const file = fileRef.current?.files?.[0]
    if (!file) throw new Error('アップロードするファイルを選んでください')
    const uploaded = await api.upload(file)
    setMedia((current) => [uploaded, ...current])
    if (fileRef.current) fileRef.current.value = ''
    return `素材「${uploaded.name}」をアップロードしました`
  }

  const removeMedia = async (item: MediaItem): Promise<string> => {
    await api.removeMedia(item.id)
    setMedia((current) => current.filter((other) => other.id !== item.id))
    return `素材「${item.name}」を削除しました`
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>素材</CardTitle>
          <CardDescription>アラートで流す画像・動画・音声。どの出来事で流すかは「トリガー」で決める。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor={fileFieldId}>ファイル（1つ50MBまで）</Label>
          <div className="flex gap-2">
            <Input ref={fileRef} id={fileFieldId} type="file" accept="image/*,video/*,audio/*" />
            <Button type="button" disabled={actions.busy} onClick={() => void actions.run(upload)}>
              アップロード
            </Button>
          </div>
          {media.length === 0 ? (
            <p className="text-sm text-muted-foreground">素材はまだありません。</p>
          ) : (
            <ul aria-label="素材の一覧" className="grid gap-3 sm:grid-cols-2">
              {media.map((item) => (
                <li key={item.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                    <MediaPreview item={item} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <strong className="truncate text-sm font-medium">{item.name}</strong>
                    <span className="text-xs text-muted-foreground">{`${kindLabels[item.kind]}・${formatBytes(item.size)}`}</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    aria-label={`${item.name} を削除`}
                    disabled={actions.busy}
                    onClick={() =>
                      actions.ask({
                        title: `素材「${item.name}」を削除しますか？`,
                        description: '削除した素材は元に戻せません。',
                        actionLabel: '削除する',
                        run: () => removeMedia(item),
                      })
                    }
                  >
                    削除
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
