/**
 * BGMのページ
 *
 * 配信で流すBGMの曲（音声・曲名・クレジット表記・クレジット先のURL・曲調・流したい場面）を管理し、流す曲と音量を
 * その場で切り替える画面である（issue #151）。鳴らすのは裏方のページ（overlay/backstage/ の ?bgm=true）で、
 * プレーヤーの操作（再生・停止・次の曲・前の曲・リピート・シャッフル・音量）はすぐに Worker へ送り、Worker が裏方のページへ押し出す。
 *
 * プレーヤーは音楽プレーヤーと同じ形にする。リピートを切っているあいだは、曲が終わると次の曲へ進む
 * （一覧の順。シャッフルを入れていればでたらめに選ぶ。次の曲を決めるのは Worker の worker/bgm-order.ts）。
 * 曲の終わりで進んだ・Jev が切り替えた曲は、裏方のページと同じ押し出しを受け取ってプレーヤーと表に映す。
 *
 * 曲の一覧はデータベースの表のように1曲1行で並べ、行の中で曲名やクレジットを直す。
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
 * 注意: 曲や素材を読めなかったときは、黙って空の一覧に倒さず理由を出す（Fail-Fast）。押し出しを読めなかったときも理由を出す。
 */
import { Headphones, Music, Pause, Play, Plus, Repeat1, Shuffle, SkipBack, SkipForward, Sparkles, Trash2, Volume2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { AdminApi, MediaItem } from '@/admin/api'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Link } from '@/app/router'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Toggle } from '@/components/ui/toggle'
import { ApiError } from '@/core/api'
import { iconButtonName } from '@/core/icon-button'
import { parseBgmNowPlaying, type BgmApi, type BgmPlayback, type BgmSettings, type BgmStep, type BgmTrack } from './api'
import { describeBgmProblem, newTrackOf, unusedAudioOf, volumeOfPercent, volumePercentOf } from './form'

/** 曲の音声を試し聴きするためのパス。この画面は配信者のセッションで読めるので、オーバーレイ用キーは付けない */
const MEDIA_PATH = '/api/media/'

/** スライダーの上限（百分率） */
const MAX_VOLUME_PERCENT = 100

/** 押し出しの接続から受け取るもの（src/core/socket.ts の SocketHandlers と同じ形） */
export interface BgmWatchHandlers {
  /** 生存確認の返事でない文字列が届いた */
  onMessage(text: string): void
  /** 切断した（disconnected）・切断後に再びつながった（reconnected） */
  onStatus(status: 'disconnected' | 'reconnected'): void
  /** 待てば直るかもしれない失敗（つなぎ直しは続ける） */
  onWarning(message: string): void
}

export interface BgmPageProps {
  /** BGMの読み書き */
  api: BgmApi
  /** 上げてある素材の読み出し（曲にする音声を選ぶために使う） */
  mediaApi: Pick<AdminApi, 'media'>
  /** ログイン中の配信者のオーバーレイ用キー。押し出しの経路はこのキーで守られている。未発行なら null */
  overlayKey: string | null
  /** 「いま流している曲」の押し出しにつなぐ。テストで差し替えるために受け取る（本番は socket.ts の connectBgmWatch） */
  connect(overlayKey: string, handlers: BgmWatchHandlers): { close(): void }
}

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

/** プレーヤーのリピート・シャッフルの見た目。入れているあいだは背景を付けず、色で示す（音楽プレーヤーと同じ） */
const PLAYER_TOGGLE_CLASS = 'text-muted-foreground aria-pressed:bg-transparent aria-pressed:text-primary hover:aria-pressed:bg-muted'

/** 表の行の中で直せる項目と、列の見出し・入力欄の例 */
const TRACK_FIELDS = [
  { key: 'title', label: '曲名', placeholder: '例: ひだまりの午後' },
  { key: 'credit', label: 'クレジット表記', placeholder: '例: 音楽: 甘茶の音楽工房' },
  { key: 'creditUrl', label: 'クレジット先のURL', placeholder: '例: https://amachamusic.chagasi.com/' },
  { key: 'mood', label: '曲調', placeholder: '例: ゆったりしたアコースティック' },
  { key: 'scene', label: '流したい場面', placeholder: '例: 雑談・作業配信' },
] as const

/** 失敗を画面に出す行にする。検証の問題点は、画面に見えている名前に読み替えて1行ずつ並べる */
const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['BGMの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeBgmProblem(problem)}`)]
    : [errorMessage(error)]

/** 曲を表の中で呼ぶ名前。曲名を消したあいだも行を名前で呼べるよう、番号で補う */
const trackNameOf = (track: BgmTrack, index: number): string => (track.title === '' ? `${index + 1}曲目` : track.title)

/** 表の1行（曲1つ） */
const TrackRow = ({
  track,
  index,
  playing,
  playable,
  previewing,
  busy,
  onChange,
  onPlay,
  onPreview,
  onRemove,
}: {
  track: BgmTrack
  index: number
  /** いま流している曲か */
  playing: boolean
  /** 流せるか（保存済みの曲だけ流せる） */
  playable: boolean
  /** 試し聴きしている曲か */
  previewing: boolean
  busy: boolean
  onChange(next: BgmTrack): void
  onPlay(): void
  onPreview(): void
  onRemove(): void
}) => {
  const name = trackNameOf(track, index)

  return (
    <TableRow aria-label={name} data-state={playing ? 'selected' : undefined}>
      <TableCell className="w-10">
        {playing ? (
          <span className="flex size-8 items-center justify-center text-primary">
            <Volume2 aria-hidden="true" className="size-4" />
            <span className="sr-only">流しています</span>
          </span>
        ) : (
          <Button type="button" size="icon" variant="ghost" {...iconButtonName(`「${name}」を流す`)} disabled={busy || !playable} onClick={onPlay}>
            <Play aria-hidden="true" />
          </Button>
        )}
      </TableCell>
      <TableCell className="w-8 text-right font-mono text-xs text-muted-foreground tabular-nums">{index + 1}</TableCell>
      {TRACK_FIELDS.map((field) => (
        <TableCell key={field.key} className="min-w-40 p-1">
          {/* 表計算のように、枠を出さずに行の中で直せる入力欄にする。列の見出しがあるので、名前は読み上げにだけ渡す */}
          <Input
            aria-label={field.label}
            value={track[field.key]}
            placeholder={field.placeholder}
            className="h-8 border-transparent bg-transparent shadow-none hover:border-input focus-visible:border-ring dark:bg-transparent"
            onChange={(event) => onChange({ ...track, [field.key]: event.currentTarget.value })}
          />
        </TableCell>
      ))}
      <TableCell className="w-20">
        <div className="flex justify-end gap-1">
          <Toggle size="sm" aria-label={`「${name}」を試し聴きする`} title={`「${name}」を試し聴きする`} pressed={previewing} onPressedChange={onPreview}>
            <Headphones aria-hidden="true" />
          </Toggle>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-destructive"
            {...iconButtonName(`「${name}」を外す`)}
            disabled={busy || playing}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

export const BgmPage = ({ api, mediaApi, overlayKey, connect }: BgmPageProps) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  /** Worker に保存されている曲。流せるかどうかはこちらで決める */
  const [savedTracks, setSavedTracks] = useState<readonly BgmTrack[]>([])
  /** 入力欄の曲（保存前の書き換えを含む） */
  const [tracks, setTracks] = useState<readonly BgmTrack[]>([])
  const [playback, setPlayback] = useState<BgmPlayback>({ mediaId: null, volume: 0, repeat: false, shuffle: false })
  const [settings, setSettings] = useState<BgmSettings>({ judgeWithJev: false })
  /** スライダーの位置。動かしているあいだは送らず、離したときに送る */
  const [volumePercent, setVolumePercent] = useState(0)
  const [media, setMedia] = useState<readonly MediaItem[]>([])
  const [adding, setAdding] = useState('')
  /** 試し聴きしている曲の素材のID */
  const [previewId, setPreviewId] = useState<string | null>(null)
  /** 押し出しを受け取れていないときの理由。受け取れていれば null */
  const [watchProblem, setWatchProblem] = useState<string | null>(null)
  const actions = usePageActions(failureLines)
  const playerTitleId = useId()
  const volumeLabelId = useId()

  /**
   * 再生の設定の世代。押し出しが届くたび・再生の設定を取りに行くたびに進める。
   *
   * 操作の応答（HTTP）は Worker が押し出したあとに返るので、曲の終わりや Jev によるもっと新しい押し出しより
   * 遅れて届くことがある。取りに行ったときから世代が進んでいたら、その応答は古いので映さない。
   */
  const playbackRevision = useRef(0)

  /** 再生の設定を取りに行く直前に呼ぶ。返した関数は、応答を映してよい（あいだに新しいものが届いていない）かを答える */
  const beginPlaybackRequest = (): (() => boolean) => {
    playbackRevision.current += 1
    const revision = playbackRevision.current
    return () => revision === playbackRevision.current
  }

  /** Worker から読んだ・受け取った再生の設定を画面に映す */
  const showPlayback = (next: BgmPlayback): void => {
    setPlayback(next)
    setVolumePercent(volumePercentOf(next.volume))
  }

  useEffect(() => {
    let cancelled = false
    const isLatest = beginPlaybackRequest()
    Promise.all([api.load(), mediaApi.media()]).then(
      ([bgm, loadedMedia]) => {
        if (cancelled) return
        setSavedTracks(bgm.tracks)
        setTracks(bgm.tracks)
        if (isLatest()) showPlayback(bgm.playback)
        setSettings(bgm.settings)
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

  // 曲の終わりで次の曲へ進んだ・Jev が切り替えたことを、裏方のページと同じ押し出しで受け取る
  useEffect(() => {
    // キーが無ければつなげない（表示は下の watchNotice が受け持つ）
    if (overlayKey === null) return
    const connection = connect(overlayKey, {
      onMessage: (text) => {
        try {
          const nowPlaying = parseBgmNowPlaying(text)
          const { volume, repeat, shuffle } = nowPlaying
          beginPlaybackRequest()
          showPlayback({ mediaId: nowPlaying.track?.mediaId ?? null, volume, repeat, shuffle })
          setWatchProblem(null)
        } catch (error) {
          setWatchProblem(errorMessage(error))
        }
      },
      onStatus: (status) => {
        if (status === 'disconnected') {
          setWatchProblem('BGMの切り替えを受け取れていません。つなぎ直しています')
          return
        }
        // つながっていない間に切り替わっていたかもしれないので、読み直す。別の画面で曲の一覧が保存されていても
        // 流している曲を引けるよう、保存済みの一覧も読み直す（書きかけの入力欄はそのまま残す）
        const isLatest = beginPlaybackRequest()
        api.load().then(
          (bgm) => {
            setSavedTracks(bgm.tracks)
            if (isLatest()) showPlayback(bgm.playback)
            setWatchProblem(null)
          },
          (error: unknown) => setWatchProblem(errorMessage(error)),
        )
      },
      onWarning: (message) => setWatchProblem(message),
    })
    return () => connection.close()
  }, [api, connect, overlayKey])

  if (loaded.status === 'loading') return <Skeleton className="h-64 w-full" aria-label="BGMを読み込んでいます" />
  if (loaded.status === 'failed') {
    return <LoadFailure title="BGMを表示できません" message={loaded.message} />
  }

  /** 押し出しを受け取れていないことの知らせ。受け取れていれば null */
  const watchNotice =
    overlayKey === null ? 'オーバーレイ用キーが未発行のため、曲の終わりや Jev による切り替えをこの画面に映せません' : watchProblem
  const playingTrack = savedTracks.find((track) => track.mediaId === playback.mediaId) ?? null
  const hasSavedTracks = savedTracks.length > 0
  const candidates = unusedAudioOf(media, tracks)
  /** 選択欄の値。選んだ音声が候補から消えていたら（追加したあとなど）先頭を選んでいることにする */
  const addingId = candidates.some((item) => item.id === adding) ? adding : (candidates[0]?.id ?? '')
  const previewIndex = tracks.findIndex((track) => track.mediaId === previewId)
  const previewTrack = tracks[previewIndex]

  /** 流す曲・音量・リピート・シャッフルを Worker へ送る。Worker が裏方のページへ押し出す */
  const sendPlayback = (next: BgmPlayback, message: string) =>
    actions.run(async () => {
      const isLatest = beginPlaybackRequest()
      const saved = await api.savePlayback(next)
      if (isLatest()) showPlayback(saved)
      return message
    })

  /** 次の曲・前の曲へ進めてもらう。どの曲にするか（一覧の順・シャッフル）は Worker が決める */
  const skip = (step: BgmStep) =>
    actions.run(async () => {
      const isLatest = beginPlaybackRequest()
      const next = await api.skip(step)
      if (isLatest()) showPlayback(next)
      const title = savedTracks.find((track) => track.mediaId === next.mediaId)?.title ?? ''
      return `「${title}」に切り替えました`
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
    <div className="flex flex-col gap-6">
      {actions.feedback}

      {/* 音楽プレーヤーの再生バーのように、左に曲・中央に操作・右に音量を1行に収める（狭い画面では縦に並べる） */}
      <section aria-label="プレーヤー" className="flex flex-col gap-2">
        <Card className="py-3">
          <CardContent className="grid items-center gap-3 px-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div className="flex min-w-0 items-center gap-3">
              <div aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <Music className="size-4" />
              </div>
              <div className="min-w-0" role="status" aria-labelledby={playerTitleId}>
                <p id={playerTitleId} className="truncate text-sm font-medium">
                  {playingTrack === null ? 'BGMを止めています' : playingTrack.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">{playingTrack === null ? '再生で一覧の曲を流し始めます' : playingTrack.credit}</p>
              </div>
            </div>

            <div className="flex items-center justify-center gap-1">
              <Toggle
                size="sm"
                aria-label="シャッフル"
                title="シャッフル（次の曲をでたらめに選ぶ）"
                className={PLAYER_TOGGLE_CLASS}
                pressed={playback.shuffle}
                disabled={actions.busy}
                onPressedChange={(pressed) =>
                  void sendPlayback({ ...playback, shuffle: pressed }, pressed ? 'シャッフルで次の曲を選びます' : '一覧の順に次の曲へ進みます')
                }
              >
                <Shuffle aria-hidden="true" />
              </Toggle>
              <Button type="button" variant="ghost" size="icon-sm" {...iconButtonName('前の曲')} disabled={actions.busy || !hasSavedTracks} onClick={() => void skip('previous')}>
                <SkipBack aria-hidden="true" className="fill-current" />
              </Button>
              {playback.mediaId === null ? (
                <Button
                  type="button"
                  size="icon"
                  className="mx-1 rounded-full"
                  {...iconButtonName('再生')}
                  disabled={actions.busy || !hasSavedTracks}
                  onClick={() => void skip('next')}
                >
                  <Play aria-hidden="true" className="fill-current" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  className="mx-1 rounded-full"
                  {...iconButtonName('停止')}
                  disabled={actions.busy}
                  onClick={() => void sendPlayback({ ...playback, mediaId: null }, 'BGMを止めました')}
                >
                  <Pause aria-hidden="true" className="fill-current" />
                </Button>
              )}
              <Button type="button" variant="ghost" size="icon-sm" {...iconButtonName('次の曲')} disabled={actions.busy || !hasSavedTracks} onClick={() => void skip('next')}>
                <SkipForward aria-hidden="true" className="fill-current" />
              </Button>
              <Toggle
                size="sm"
                aria-label="リピート"
                title="リピート（流している曲を繰り返す）"
                className={PLAYER_TOGGLE_CLASS}
                pressed={playback.repeat}
                disabled={actions.busy}
                onPressedChange={(pressed) =>
                  void sendPlayback({ ...playback, repeat: pressed }, pressed ? '流している曲を繰り返します' : '曲が終わったら次の曲へ進みます')
                }
              >
                <Repeat1 aria-hidden="true" />
              </Toggle>
            </div>

            <div className="flex items-center justify-center gap-2 md:justify-end">
              {/* Jev は曲調・流したい場面を手がかりに選ぶので、どちらも書いていない曲は選ばれない */}
              <Toggle
                size="sm"
                aria-label="配信の話題に合う曲へ自動で切り替える（Jev）"
                title="配信の話題に合う曲へ自動で切り替える（Jev）"
                className={`mr-2 ${PLAYER_TOGGLE_CLASS}`}
                pressed={settings.judgeWithJev}
                disabled={actions.busy}
                onPressedChange={(pressed) => void saveSettings({ judgeWithJev: pressed })}
              >
                <Sparkles aria-hidden="true" />
              </Toggle>
              <span id={volumeLabelId} className="sr-only">
                音量
              </span>
              <Volume2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <Slider
                aria-labelledby={volumeLabelId}
                className="w-28"
                min={0}
                max={MAX_VOLUME_PERCENT}
                value={[volumePercent]}
                onValueChange={(next) => setVolumePercent(Array.isArray(next) ? (next[0] ?? 0) : next)}
                onValueCommitted={(next) => {
                  const percent = Array.isArray(next) ? (next[0] ?? 0) : next
                  void sendPlayback({ ...playback, volume: volumeOfPercent(percent) }, `音量を${percent}%にしました`)
                }}
              />
              <output aria-labelledby={volumeLabelId} className="w-9 text-right font-mono text-xs text-muted-foreground tabular-nums">
                {volumePercent}%
              </output>
            </div>
          </CardContent>
        </Card>
        {watchNotice !== null && <p className="text-sm text-destructive">{watchNotice}</p>}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>曲</CardTitle>
          <CardDescription>
            音声は「<Link href="/media/" className="underline underline-offset-4">アップロード</Link>」のページで上げる。クレジット表記は配布元が求める書き方のまま書く。
            鳴らすのは「コネクター」のページで BGM を入れたURL（OBSのブラウザソース）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {tracks.length === 0 ? (
            <p className="text-sm text-muted-foreground">曲はまだありません。</p>
          ) : (
            <div className="rounded-lg border">
              <Table aria-label="曲の一覧">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <span className="sr-only">流す</span>
                    </TableHead>
                    <TableHead className="w-8 text-right">#</TableHead>
                    {TRACK_FIELDS.map((field) => (
                      <TableHead key={field.key}>{field.label}</TableHead>
                    ))}
                    <TableHead className="w-20">
                      <span className="sr-only">操作</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tracks.map((track, index) => (
                    <TrackRow
                      key={track.mediaId}
                      track={track}
                      index={index}
                      playing={track.mediaId === playback.mediaId}
                      playable={savedTracks.some((saved) => saved.mediaId === track.mediaId)}
                      previewing={track.mediaId === previewId}
                      busy={actions.busy}
                      onChange={(next) => setTracks((current) => current.map((other) => (other.mediaId === next.mediaId ? next : other)))}
                      onPlay={() => void sendPlayback({ ...playback, mediaId: track.mediaId }, `「${track.title}」に切り替えました`)}
                      onPreview={() => setPreviewId((current) => (current === track.mediaId ? null : track.mediaId))}
                      onRemove={() => setTracks((current) => current.filter((other) => other.mediaId !== track.mediaId))}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {previewTrack !== undefined && (
            // 試し聴きはこの画面だけで鳴らす（配信には乗らない）。押したときだけ読み込む
            <audio
              key={previewTrack.mediaId}
              src={`${MEDIA_PATH}${encodeURIComponent(previewTrack.mediaId)}`}
              controls
              autoPlay
              aria-label={`${trackNameOf(previewTrack, previewIndex)} の試し聴き`}
              className="w-full"
            />
          )}

          {candidates.length > 0 && (
            // 選んだ音声がそのまま見えているので、入力欄の見出しは読み上げにだけ残す
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
