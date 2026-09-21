/**
 * アラートの管理画面
 *
 * OBS用のURL・素材・トリガーの操作盤を出す。ログインの確認とログアウトはアプリの枠（src/app/app.tsx）が受け持つので、
 * ここではログイン済みを前提にする。画面の状態（素材・報酬・入力中のトリガー）はここで持ち、
 * Workerの呼び出しは api.ts、入力欄の値の変換は form.ts に任せる。
 *
 * 注意: 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。
 * 素材や保存済みの設定を取得できなければ操作盤を出さない。報酬の一覧だけ取得できないときは、操作盤は出したまま理由を出す。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { ApiError } from '@/core/api'
import { isAlertEvent, isAnnouncementColor, type AdminApi, type AlertEvent, type AnnouncementColor, type MediaItem, type Reward } from './api'
import {
  colorOptions,
  describeProblem,
  eventOptions,
  formatBytes,
  overlayUrl,
  placeholdersFor,
  rewardOptions,
  toDraft,
  toTriggerInput,
  type SelectOption,
  type TriggerDraft,
} from './form'

const MEDIA_PATH = '/api/media/'
const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
/** 文言欄の入力例。イベント種別ごとに、使える差し込み語だけを使った例を出す */
const MESSAGE_PLACEHOLDERS: Readonly<Record<AlertEvent, string>> = {
  [REDEMPTION]: '{user} さんが「{reward}」を交換しました',
  'channel.follow': '{user} さんがフォローしました',
  'channel.subscribe': '{user} さんがティア{tier}でサブスクしました',
  'channel.subscription.message': '{user} さんが{months}か月目のサブスク（ティア{tier}）',
  'channel.raid': '{user} さんが{viewers}人でレイドしました',
}
const KIND_LABELS = { image: '画像', video: '動画', audio: '音声' } as const
const MIN_DURATION_SECONDS = 1
const MAX_DURATION_SECONDS = 60
const MAX_VOLUME_PERCENT = 100
const MAX_MESSAGE_LENGTH = 200
/** チャットに送る文言の上限（Twitchのチャット1通の上限） */
const MAX_CHAT_MESSAGE_LENGTH = 500
const DEFAULT_DURATION_SECONDS = '5'
const DEFAULT_VOLUME_PERCENT = '100'
/** 新しく足したトリガーのアナウンスの色（チャンネルの色） */
const DEFAULT_ANNOUNCEMENT_COLOR: AnnouncementColor = 'primary'

/** 素材の中身のURL。管理画面は配信者のセッションで読めるので、オーバーレイ用キーは付けない */
const mediaUrl = (id: string): string => `${MEDIA_PATH}${encodeURIComponent(id)}`

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 失敗の理由を、画面に出す行にする。設定の問題点があれば、1行ずつ並べる */
const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['トリガーの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeProblem(problem)}`)]
    : [errorMessage(error)]

/** 実行の前に確かめる操作。確かめてから run を実行する */
interface Confirmation {
  title: string
  description: string
  actionLabel: string
  run(): Promise<string>
}

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

const Select = ({ id, options, value, onChange }: { id: string; options: readonly SelectOption[]; value: string; onChange(value: string): void }) => (
  <NativeSelect id={id} className="w-full" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
    {options.map((option) => (
      <NativeSelectOption key={option.value} value={option.value}>
        {option.label}
      </NativeSelectOption>
    ))}
  </NativeSelect>
)

interface TriggerRowProps {
  position: number
  draft: TriggerDraft
  media: readonly MediaItem[]
  rewards: readonly Reward[]
  onChange(draft: TriggerDraft): void
  onRemove(): void
}

const TriggerRow = ({ position, draft, media, rewards, onChange, onRemove }: TriggerRowProps) => {
  const id = useId()
  const update = (patch: Partial<TriggerDraft>): void => onChange({ ...draft, ...patch })
  const mediaOptions = media.map((item) => ({ value: item.id, label: `${item.name}（${KIND_LABELS[item.kind]}）` }))
  // 報酬を選べるのはチャンネルポイント交換だけ。ほかのイベントでは報酬の欄を出さない（保存時にも送られない）
  const isRedemption = draft.event === REDEMPTION

  return (
    <li aria-label={`${position}番目のトリガー`} className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-event`}>イベント</Label>
        {/* 選択肢はイベント種別だけなので isAlertEvent は必ず通る。型を絞るための確認 */}
        <Select id={`${id}-event`} options={eventOptions} value={draft.event} onChange={(event) => isAlertEvent(event) && update({ event })} />
      </div>
      {isRedemption && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-reward`}>報酬</Label>
          <Select id={`${id}-reward`} options={rewardOptions(rewards, draft.rewardId)} value={draft.rewardId} onChange={(rewardId) => update({ rewardId })} />
        </div>
      )}

      {/* ここから下は、このイベントのときに行う動作。種類ごとに実行者が違う（アラートはオーバーレイ、チャットはWorker） */}
      <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-alert-enabled`}
            checked={draft.alertEnabled}
            // 素材が未選択のまま出すことにすると、選択欄には最初の素材が見えているのに保存時に拒まれる。
            // そこで、出すことにした時点で選択欄が見せているとおりの素材（先頭）を選んでおく
            onCheckedChange={(checked) =>
              update(checked === true ? { alertEnabled: true, mediaId: draft.mediaId === '' ? (media[0]?.id ?? '') : draft.mediaId } : { alertEnabled: false })
            }
          />
          <Label htmlFor={`${id}-alert-enabled`}>アラートを出す</Label>
        </div>
        {draft.alertEnabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-media`}>素材</Label>
              <Select id={`${id}-media`} options={mediaOptions} value={draft.mediaId} onChange={(mediaId) => update({ mediaId })} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-duration`}>表示時間（1〜60秒）</Label>
              <Input
                id={`${id}-duration`}
                type="number"
                min={MIN_DURATION_SECONDS}
                max={MAX_DURATION_SECONDS}
                value={draft.durationSeconds}
                onChange={(event) => update({ durationSeconds: event.currentTarget.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <span id={`${id}-volume`} className="text-sm leading-none font-medium">
                音量
              </span>
              <div className="flex h-8 items-center gap-3">
                <Slider
                  aria-labelledby={`${id}-volume`}
                  min={0}
                  max={MAX_VOLUME_PERCENT}
                  value={[Number(draft.volumePercent)]}
                  onValueChange={(next) => update({ volumePercent: String(Array.isArray(next) ? next[0] : next) })}
                />
                <output className="w-12 text-right font-mono text-xs tabular-nums">{draft.volumePercent}%</output>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor={`${id}-message`}>文言（空欄なら出さない）</Label>
              <Input
                id={`${id}-message`}
                type="text"
                maxLength={MAX_MESSAGE_LENGTH}
                value={draft.message}
                placeholder={MESSAGE_PLACEHOLDERS[draft.event]}
                onChange={(event) => update({ message: event.currentTarget.value })}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
        <div className="flex items-center gap-2">
          <Checkbox id={`${id}-chat-enabled`} checked={draft.chatEnabled} onCheckedChange={(checked) => update({ chatEnabled: checked === true })} />
          <Label htmlFor={`${id}-chat-enabled`}>チャットに送る</Label>
        </div>
        {draft.chatEnabled && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-chat-message`}>チャットに送る文言</Label>
            <Input
              id={`${id}-chat-message`}
              type="text"
              maxLength={MAX_CHAT_MESSAGE_LENGTH}
              value={draft.chatMessage}
              placeholder={MESSAGE_PLACEHOLDERS[draft.event]}
              onChange={(event) => update({ chatMessage: event.currentTarget.value })}
            />
            {/* 送るのは接続しているbotアカウント。未接続だと何も送られないので、どこで接続するかを添える */}
            <p className="text-xs text-muted-foreground">接続しているbotアカウントが送ります（チャットボットのページで接続します）。</p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-announce-enabled`}
            checked={draft.announceEnabled}
            onCheckedChange={(checked) => update({ announceEnabled: checked === true })}
          />
          <Label htmlFor={`${id}-announce-enabled`}>アナウンスを送る</Label>
        </div>
        {draft.announceEnabled && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor={`${id}-announce-message`}>アナウンスの文言</Label>
              <Input
                id={`${id}-announce-message`}
                type="text"
                maxLength={MAX_CHAT_MESSAGE_LENGTH}
                value={draft.announceMessage}
                placeholder={MESSAGE_PLACEHOLDERS[draft.event]}
                onChange={(event) => update({ announceMessage: event.currentTarget.value })}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-announce-color`}>アナウンスの色</Label>
              {/* 選択肢は色だけなので isAnnouncementColor は必ず通る。型を絞るための確認 */}
              <Select
                id={`${id}-announce-color`}
                options={colorOptions}
                value={draft.announceColor}
                onChange={(color) => isAnnouncementColor(color) && update({ announceColor: color })}
              />
            </div>
            {/* アナウンスは普通の発言と違い、botがモデレーターでないとTwitchに拒否される */}
            <p className="text-xs text-muted-foreground sm:col-span-2">
              接続しているbotアカウントが、モデレーターとして送ります（チャットボットのページで接続し、配信者がモデレーター権限を与えてください）。
            </p>
          </div>
        )}
      </div>

      {/* 選んだイベントに存在しない語は置き換わらないため、使える語をその場で知らせる（アラートとチャットで同じ語を使う） */}
      <p className="text-xs text-muted-foreground sm:col-span-2">
        このイベントで使える差し込み語: {placeholdersFor(draft.event).join('・')}
      </p>
      <Button type="button" variant="ghost" size="sm" className="justify-self-start text-destructive" onClick={onRemove}>
        このトリガーを外す
      </Button>
    </li>
  )
}

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

export interface AdminPageProps {
  api: AdminApi
  /** ログイン中の配信者のオーバーレイ用キー。発行されていなければ null */
  overlayKey: string | null
  /** キーを再発行した。アプリの枠が持つログイン情報を新しいキーに書き換えてもらう */
  onOverlayKeyChange(overlayKey: string): void
}

export const AdminPage = ({ api, overlayKey, onOverlayKeyChange }: AdminPageProps) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [media, setMedia] = useState<readonly MediaItem[]>([])
  const [rewards, setRewards] = useState<readonly Reward[]>([])
  const [drafts, setDrafts] = useState<readonly TriggerDraft[]>([])
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState<readonly string[]>([])
  // 報酬の一覧を取得できなかった理由。操作の失敗（failure）と分けて持ち、ほかの操作が成功しても消さない
  const [rewardsFailure, setRewardsFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const fileRef = useRef<HTMLInputElement>(null)
  // 保存を待つ間に入力欄が書き換えられたかを、保存の応答が届いた時点で確かめるために持つ
  const draftsRef = useRef(drafts)
  const urlFieldId = useId()
  const fileFieldId = useId()

  const replaceDrafts = (next: readonly TriggerDraft[]): void => {
    draftsRef.current = next
    setDrafts(next)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([api.media(), api.config()]).then(
      ([loadedMedia, triggers]) => {
        if (cancelled) return
        setMedia(loadedMedia)
        const loadedDrafts = triggers.map(toDraft)
        draftsRef.current = loadedDrafts
        setDrafts(loadedDrafts)
        setLoaded({ status: 'ready' })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    // 報酬の一覧はTwitchに問い合わせるので、素材や保存済みの設定より失敗しやすい（チャンネルポイントを使えないチャンネルなど）。
    // 失敗しても素材の管理は続けられるよう画面は出し、理由を表示する。報酬を選べない間も「すべての報酬」は選べる
    api.rewards().then(
      (loadedRewards) => {
        if (!cancelled) setRewards(loadedRewards)
      },
      (error: unknown) => {
        if (!cancelled) setRewardsFailure(`チャンネルポイント報酬の一覧を取得できませんでした: ${errorMessage(error)}`)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  if (overlayKey === null) {
    return (
      <Alert variant="destructive">
        <AlertTitle>管理画面を表示できません</AlertTitle>
        <AlertDescription>オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください</AlertDescription>
      </Alert>
    )
  }
  if (loaded.status === 'loading') return <Skeleton className="h-64 w-full" aria-label="素材と設定を読み込んでいます" />
  if (loaded.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle>読み込みに失敗しました</AlertTitle>
        <AlertDescription>管理画面を表示できません: {loaded.message}</AlertDescription>
      </Alert>
    )
  }

  const url = overlayUrl(window.location.origin, overlayKey)

  /** 操作を実行し、終わったら結果を知らせる。失敗したら理由を出す。実行中はボタンを押せなくして二重の送信を防ぐ */
  const run = async (action: () => Promise<string>): Promise<void> => {
    setFailure([])
    setNotice('')
    setBusy(true)
    try {
      setNotice(await action())
    } catch (error) {
      setFailure(failureLines(error))
    } finally {
      setBusy(false)
    }
  }

  const copyUrl = async (): Promise<string> => {
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    await navigator.clipboard.writeText(url)
    return 'OBS用のURLをコピーしました'
  }

  const rotateKey = async (): Promise<string> => {
    onOverlayKeyChange(await api.rotateOverlayKey())
    return 'キーを再発行しました。新しいURLをOBSに貼り替えてください'
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

  const addTrigger = async (): Promise<string> => {
    const first = media[0]
    // 素材が1つもなければアラートは出せないので、チャットに送るだけのトリガーとして足す
    replaceDrafts([
      ...drafts,
      {
        event: REDEMPTION,
        rewardId: '',
        alertEnabled: first !== undefined,
        mediaId: first?.id ?? '',
        durationSeconds: DEFAULT_DURATION_SECONDS,
        volumePercent: DEFAULT_VOLUME_PERCENT,
        message: '',
        chatEnabled: first === undefined,
        chatMessage: '',
        announceEnabled: false,
        announceMessage: '',
        announceColor: DEFAULT_ANNOUNCEMENT_COLOR,
      },
    ])
    return 'トリガーを足しました。保存するまで反映されません'
  }

  const saveTriggers = async (): Promise<string> => {
    const inputs = drafts.map((draft, index) => {
      try {
        return toTriggerInput(draft)
      } catch (error) {
        throw new Error(`${index + 1}番目のトリガー: ${errorMessage(error)}`, { cause: error })
      }
    })
    const submitted = drafts
    const saved = await api.saveConfig(inputs)
    // 保存を待つ間に入力欄が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    if (draftsRef.current !== submitted) return 'トリガーを保存しました。保存中に書き換えた内容はまだ保存されていません'
    replaceDrafts(saved.map(toDraft))
    return 'トリガーを保存しました。次の交換から反映されます'
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        チャンネルポイントの交換・フォロー・サブスク・レイドで流す素材を置き、どのイベントでどの素材を出すかを決める。
      </p>

      <p role="status" className="min-h-5 text-sm">
        {notice}
      </p>
      {rewardsFailure !== '' && (
        <Alert variant="destructive">
          <AlertTitle>報酬を選べません</AlertTitle>
          <AlertDescription>{rewardsFailure}（「すべての報酬」は選べます）</AlertDescription>
        </Alert>
      )}
      {failure.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>操作に失敗しました</AlertTitle>
          <AlertDescription className="whitespace-pre-line">{failure.join('\n')}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>OBS用のURL</CardTitle>
          <CardDescription>幅と高さは配信のキャンバスと同じ大きさ（1920×1080 など）にする。背景は透過で、素材は中央に表示される。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
          <div className="flex gap-2">
            {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
            <Input id={urlFieldId} type="password" readOnly autoComplete="off" value={url} />
            <Button type="button" disabled={busy} onClick={() => void run(copyUrl)}>
              URLをコピー
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            URLが他人に知られたら、キーを再発行してください。再発行すると今のURLは使えなくなり、OBSのURLを貼り替える必要があります（反映に最大1分かかります）。
          </p>
          <Button
            type="button"
            variant="outline"
            className="self-start text-destructive"
            disabled={busy}
            onClick={() =>
              setConfirmation({
                title: 'キーを再発行しますか？',
                description: 'キーを再発行すると、今のURLは使えなくなります。OBSのURLを貼り替える必要があります。',
                actionLabel: '再発行する',
                run: rotateKey,
              })
            }
          >
            キーを再発行する
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>素材</CardTitle>
          <CardDescription>アラートで流す画像・動画・音声。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor={fileFieldId}>画像・動画・音声のファイル（1つ50MBまで）</Label>
          <div className="flex gap-2">
            <Input ref={fileRef} id={fileFieldId} type="file" accept="image/*,video/*,audio/*" />
            <Button type="button" disabled={busy} onClick={() => void run(upload)}>
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
                    <span className="text-xs text-muted-foreground">{`${KIND_LABELS[item.kind]}・${formatBytes(item.size)}`}</span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    aria-label={`${item.name} を削除`}
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({
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

      <Card>
        <CardHeader>
          <CardTitle>トリガー</CardTitle>
          <CardDescription>
            イベントが起きたら、上から順に探して最初に当てはまったトリガーの素材を流す。文言の <code>{'{user}'}</code> は相手の名前に置き換わる。
            ほかに使える差し込み語はイベントごとに違い、それぞれの文言欄の下に出る。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">トリガーはまだありません。</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {drafts.map((draft, index) => (
                <TriggerRow
                  // トリガーは順番でしか区別できないので、位置をキーにする
                  key={index}
                  position={index + 1}
                  draft={draft}
                  media={media}
                  rewards={rewards}
                  onChange={(next) => replaceDrafts(drafts.map((other, position) => (position === index ? next : other)))}
                  onRemove={() => replaceDrafts(drafts.filter((_, position) => position !== index))}
                />
              ))}
            </ol>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => void run(addTrigger)}>
              トリガーを足す
            </Button>
            <Button type="button" disabled={busy} onClick={() => void run(saveTriggers)}>
              トリガーを保存
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmation !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmation) void run(confirmation.run)
                setConfirmation(undefined)
              }}
            >
              {confirmation?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
