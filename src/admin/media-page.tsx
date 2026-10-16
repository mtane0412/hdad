/**
 * アップロードのページ
 *
 * アラートで流す素材（画像・動画・音声）と、VRMの演出で出す VRM（issue #358）を置き、一覧と削除を受け持つ。どの素材をどのイベントで流すかは
 * トリガーのページ（trigger-page.tsx）が決める。ログインの確認とログアウトはアプリの枠（src/app/app.tsx）が
 * 受け持つので、ここではログイン済みを前提にする。
 * Workerの呼び出しは api.ts、操作の実行と結果の表示は page-actions.tsx に任せる。
 *
 * 注意: 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。素材の一覧を取得できなければ操作盤を出さない。
 */
import { Box, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Identifier, Tag, type TagTone } from '@/components/data/data-display'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { iconButtonName } from '@/core/icon-button'
import type { AdminApi, MediaItem, MediaKind } from './api'
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
    // VRM は3Dのモデルで、小さく見せるには three.js での読み込みが要る。一覧を開くたびに重いモデルを読まないよう、立体のアイコンだけを出す
    // （種類の名前は隣の列の札に出るので、ここで繰り返さない）
    case 'vrm':
      return <Box aria-hidden="true" className="size-5 text-muted-foreground" />
  }
}

/** 素材の種類ごとの札の色。種類を見分けるためだけの色 */
const KIND_TONES: Readonly<Record<MediaKind, TagTone>> = { image: 'blue', video: 'purple', audio: 'orange', vrm: 'indigo' }

/** 行の列（見本・名前・種類・大きさ・上げた日・削除）。見出しの行と素材の行で同じ幅にし、上下で列をそろえる */
const MEDIA_COLUMNS = 'grid-cols-[7rem_minmax(0,1fr)_4.5rem_5rem_6rem_2.25rem]'

/** 上げた日。ブラウザのタイムゾーンの日付で出す（時刻まで出すと列が広がるだけで、見分けるのに使わないため） */
const uploadedDate = (uploadedAt: string): string => new Date(uploadedAt).toLocaleDateString('ja-JP')

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
      <LoadFailure title="素材を表示できません" message={loaded.message} />
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
    <div className="flex flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>素材</CardTitle>
          <CardDescription>アラートで流す画像・動画・音声と、VRMの演出で出す VRM。どの出来事で流すかは「トリガー」で決める。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor={fileFieldId}>ファイル（1つ50MBまで）</Label>
          <div className="flex gap-2">
            <Input ref={fileRef} id={fileFieldId} type="file" accept="image/*,video/*,audio/*,.vrm" />
            <Button type="button" disabled={actions.busy} onClick={() => void actions.run(upload)}>
              アップロード
            </Button>
          </div>
          {media.length === 0 ? (
            <p className="text-sm text-muted-foreground">素材はまだありません。</p>
          ) : (
            <div className="flex flex-col">
              {/* 列の見出し。読み上げでは各行がそのまま読まれるので、見た目だけの見出しにする */}
              <div aria-hidden="true" className={`grid ${MEDIA_COLUMNS} gap-3 border-b px-3 py-1.5 text-xs font-medium text-muted-foreground`}>
                <span>見本</span>
                <span>名前</span>
                <span>種類</span>
                <span className="text-right">大きさ</span>
                <span>上げた日</span>
              </div>
              <ul aria-label="素材の一覧" className="flex flex-col">
                {media.map((item) => (
                  <li key={item.id} className={`grid ${MEDIA_COLUMNS} items-center gap-3 border-b px-3 py-1.5`}>
                    <div className="flex h-10 items-center justify-center overflow-hidden rounded-md bg-muted">
                      <MediaPreview item={item} />
                    </div>
                    {/* 長い名前は1行で省略し、全文はホバー（title）で読めるようにする */}
                    <span className="min-w-0 truncate" title={item.name}>
                      <Identifier>{item.name}</Identifier>
                    </span>
                    <span>
                      <Tag tone={KIND_TONES[item.kind]}>{kindLabels[item.kind]}</Tag>
                    </span>
                    <span className="text-right whitespace-nowrap tabular-nums">{formatBytes(item.size)}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{uploadedDate(item.uploadedAt)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      {...iconButtonName(`${item.name} を削除`)}
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
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
