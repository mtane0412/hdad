/**
 * BGMのページ
 *
 * 配信で流すBGMの曲（音声・曲名・クレジット表記・クレジット先のURL・曲調・流したい場面）を管理し、流す曲と音量を
 * その場で切り替える画面である（issue #151）。鳴らすのは裏方のページ（overlay/backstage/ の ?bgm=true）で、
 * 流す曲・止める・音量の操作はすぐに Worker へ送り、Worker が裏方のページへ押し出す。
 *
 * 曲の音声は「アップロード」のページで上げた音声から選ぶ（アラートの素材と同じ置き場）。音声1つにつき曲は1つである。
 * 曲の情報の書き換えは「曲の一覧を保存」でまとめて送る。流す曲の切り替えは配信中に何度も行うので、押したらすぐ送る。
 * 配信の話題に合う曲へ Jev に切り替えさせるか（issue #153。既定はオフ）も、押したらすぐ送る。Jev は曲調・流したい場面を
 * 手がかりに選ぶので、どちらも書いていない曲は選ばれない。
 *
 * Workerの呼び出しは api.ts、入力欄の値の変換は form.ts に分けてテストする。
 * 保存の形（ボタンを押す → Workerを呼ぶ → 成功なら知らせ、失敗なら理由を出す）は usePageActions に合わせる。
 *
 * 注意: 値の検証は Worker だけが持つ（画面とWorkerで二重に持たない）。そのため入力欄の値はそのまま送り、
 * 返ってきた問題点を画面に見えている名前へ読み替えて並べる。
 * 注意: まだ保存していない曲は流せない（Worker の一覧に無いため）。流している曲は外せない（Worker も拒む）。
 * 注意: 曲や素材を読めなかったときは、黙って空の一覧に倒さず理由を出す（Fail-Fast）。
 * 注意: Jev が切り替えた曲は、この画面を開き直すまで「いま流している曲」に反映されない（押し出しを受けるのは裏方のページだけ）。
 */
import { Play, Plus, Square, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { AdminApi, MediaItem } from '@/admin/api'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Link } from '@/app/router'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { ApiError } from '@/core/api'
import { iconButtonName } from '@/core/icon-button'
import type { BgmApi, BgmPlayback, BgmSettings, BgmTrack } from './api'
import { describeBgmProblem, newTrackOf, unusedAudioOf, volumeOfPercent, volumePercentOf } from './form'

/** 曲の音声を試し聴きするためのパス。この画面は配信者のセッションで読めるので、オーバーレイ用キーは付けない */
const MEDIA_PATH = '/api/media/'

/** スライダーの上限（百分率） */
const MAX_VOLUME_PERCENT = 100

export interface BgmPageProps {
  /** BGMの読み書き */
  api: BgmApi
  /** 上げてある素材の読み出し（曲にする音声を選ぶために使う） */
  mediaApi: Pick<AdminApi, 'media'>
}

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

/** 失敗を画面に出す行にする。検証の問題点は、画面に見えている名前に読み替えて1行ずつ並べる */
const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['BGMの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeBgmProblem(problem)}`)]
    : [errorMessage(error)]

/** 曲1つの入力欄 */
const TrackRow = ({
  track,
  index,
  playing,
  playable,
  busy,
  onChange,
  onPlay,
  onRemove,
}: {
  track: BgmTrack
  index: number
  /** いま流している曲か */
  playing: boolean
  /** 流せるか（保存済みの曲だけ流せる） */
  playable: boolean
  busy: boolean
  onChange(next: BgmTrack): void
  onPlay(): void
  onRemove(): void
}) => {
  const id = useId()
  /** 曲名を消したあいだも行を名前で呼べるよう、番号で補う */
  const name = track.title === '' ? `${index + 1}曲目` : track.title
  const field = (key: 'title' | 'credit' | 'creditUrl' | 'mood' | 'scene', label: string, placeholder: string) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${id}-${key}`}>{label}</Label>
      <Input id={`${id}-${key}`} value={track[key]} placeholder={placeholder} onChange={(event) => onChange({ ...track, [key]: event.currentTarget.value })} />
    </div>
  )

  return (
    <li aria-label={name} className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center gap-2">
        <Button type="button" size="icon" variant={playing ? 'default' : 'outline'} {...iconButtonName(`「${name}」を流す`)} disabled={busy || !playable || playing} onClick={onPlay}>
          <Play aria-hidden="true" />
        </Button>
        <strong className="min-w-0 flex-1 truncate text-sm font-medium">{name}</strong>
        {playing && <Badge>流しています</Badge>}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="text-destructive"
          {...iconButtonName(`「${name}」を外す`)}
          disabled={busy || playing}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      {/* 一覧を開いただけで全曲を読み込まないよう、preload は none にする */}
      <audio src={`${MEDIA_PATH}${encodeURIComponent(track.mediaId)}`} controls preload="none" aria-label={`${name} の試し聴き`} className="w-full" />
      <div className="grid gap-3 sm:grid-cols-2">
        {field('title', '曲名', '例: ひだまりの午後')}
        {field('credit', 'クレジット表記', '例: 音楽: 甘茶の音楽工房')}
        {field('creditUrl', 'クレジット先のURL', '例: https://amachamusic.chagasi.com/')}
        {field('mood', '曲調', '例: ゆったりしたアコースティック')}
        {field('scene', '流したい場面', '例: 雑談・作業配信')}
      </div>
    </li>
  )
}

export const BgmPage = ({ api, mediaApi }: BgmPageProps) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  /** Worker に保存されている曲。流せるかどうかはこちらで決める */
  const [savedTracks, setSavedTracks] = useState<readonly BgmTrack[]>([])
  /** 入力欄の曲（保存前の書き換えを含む） */
  const [tracks, setTracks] = useState<readonly BgmTrack[]>([])
  const [playback, setPlayback] = useState<BgmPlayback>({ mediaId: null, volume: 0 })
  const [settings, setSettings] = useState<BgmSettings>({ judgeWithJev: false })
  /** スライダーの位置。動かしているあいだは送らず、離したときに送る */
  const [volumePercent, setVolumePercent] = useState(0)
  const [media, setMedia] = useState<readonly MediaItem[]>([])
  const [adding, setAdding] = useState('')
  const actions = usePageActions(failureLines)
  const volumeLabelId = useId()
  const judgeFieldId = useId()

  useEffect(() => {
    let cancelled = false
    Promise.all([api.load(), mediaApi.media()]).then(
      ([bgm, loadedMedia]) => {
        if (cancelled) return
        setSavedTracks(bgm.tracks)
        setTracks(bgm.tracks)
        setPlayback(bgm.playback)
        setSettings(bgm.settings)
        setVolumePercent(volumePercentOf(bgm.playback.volume))
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
  }, [api, mediaApi])

  if (loaded.status === 'loading') return <Skeleton className="h-64 w-full" aria-label="BGMを読み込んでいます" />
  if (loaded.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle>読み込みに失敗しました</AlertTitle>
        <AlertDescription>BGMを表示できません: {loaded.message}</AlertDescription>
      </Alert>
    )
  }

  const playingTrack = savedTracks.find((track) => track.mediaId === playback.mediaId) ?? null
  const candidates = unusedAudioOf(media, tracks)
  /** 選択欄の値。選んだ音声が候補から消えていたら（追加したあとなど）先頭を選んでいることにする */
  const addingId = candidates.some((item) => item.id === adding) ? adding : (candidates[0]?.id ?? '')

  /** 流す曲と音量を Worker へ送る。Worker が裏方のページへ押し出す */
  const sendPlayback = (next: BgmPlayback, message: string) =>
    actions.run(async () => {
      setPlayback(await api.savePlayback(next))
      return message
    })

  const saveSettings = (next: BgmSettings) =>
    actions.run(async () => {
      setSettings(await api.saveSettings(next))
      return next.judgeWithJev ? '配信の話題に合う曲へ自動で切り替えます' : '自動の切り替えをやめました'
    })

  const addTrack = (): void => {
    const item = candidates.find((candidate) => candidate.id === addingId)
    if (item) setTracks((current) => [...current, newTrackOf(item)])
  }

  const saveTracks = () =>
    actions.run(async () => {
      const saved = await api.saveTracks(tracks)
      setSavedTracks(saved)
      setTracks(saved)
      return '曲の一覧を保存しました'
    })

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>いま流している曲</CardTitle>
          <CardDescription>
            鳴らすのは裏方のページ。「裏方」のページで BGM を入れたURLをOBSに貼り、そのブラウザソースの音声を配信に乗せる。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <p role="status" className="min-w-0 flex-1 text-sm">
              {playingTrack === null ? 'BGMを止めています' : `「${playingTrack.title}」を流しています（${playingTrack.credit}）`}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={actions.busy || playback.mediaId === null}
              onClick={() => void sendPlayback({ mediaId: null, volume: playback.volume }, 'BGMを止めました')}
            >
              <Square aria-hidden="true" />
              止める
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            <span id={volumeLabelId} className="text-sm leading-none font-medium">
              音量
            </span>
            <div className="flex h-8 items-center gap-3">
              <Slider
                aria-labelledby={volumeLabelId}
                min={0}
                max={MAX_VOLUME_PERCENT}
                value={[volumePercent]}
                onValueChange={(next) => setVolumePercent(Array.isArray(next) ? (next[0] ?? 0) : next)}
                onValueCommitted={(next) => {
                  const percent = Array.isArray(next) ? (next[0] ?? 0) : next
                  void sendPlayback({ mediaId: playback.mediaId, volume: volumeOfPercent(percent) }, `音量を${percent}%にしました`)
                }}
              />
              <output className="w-12 text-right font-mono text-xs tabular-nums">{volumePercent}%</output>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={judgeFieldId}
              checked={settings.judgeWithJev}
              disabled={actions.busy}
              onCheckedChange={(checked) => void saveSettings({ judgeWithJev: checked === true })}
            />
            <Label htmlFor={judgeFieldId}>配信の話題に合う曲へ自動で切り替える（Jev）</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>曲</CardTitle>
          <CardDescription>
            音声は「<Link href="/media/" className="underline underline-offset-4">アップロード</Link>」のページで上げる。クレジット表記は配布元が求める書き方のまま書く。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {tracks.length === 0 ? (
            <p className="text-sm text-muted-foreground">曲はまだありません。</p>
          ) : (
            <ul aria-label="曲の一覧" className="flex flex-col gap-3">
              {tracks.map((track, index) => (
                <TrackRow
                  key={track.mediaId}
                  track={track}
                  index={index}
                  playing={track.mediaId === playback.mediaId}
                  playable={savedTracks.some((saved) => saved.mediaId === track.mediaId)}
                  busy={actions.busy}
                  onChange={(next) => setTracks((current) => current.map((other) => (other.mediaId === next.mediaId ? next : other)))}
                  onPlay={() => void sendPlayback({ mediaId: track.mediaId, volume: playback.volume }, `「${track.title}」に切り替えました`)}
                  onRemove={() => setTracks((current) => current.filter((other) => other.mediaId !== track.mediaId))}
                />
              ))}
            </ul>
          )}

          {candidates.length > 0 && (
            <div className="flex flex-col gap-2">
              {/* 選んだ音声がそのまま見えているので、入力欄の見出しは読み上げにだけ残す */}
              <div className="flex gap-2">
                <NativeSelect aria-label="追加する音声" className="w-full" value={addingId} onChange={(event) => setAdding(event.currentTarget.value)}>
                  {candidates.map((item) => (
                    <NativeSelectOption key={item.id} value={item.id}>
                      {item.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <Button type="button" variant="outline" size="icon" {...iconButtonName('曲を追加する')} onClick={addTrack}>
                  <Plus aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}

          <div>
            <Button type="button" disabled={actions.busy} onClick={() => void saveTracks()}>
              曲の一覧を保存
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
