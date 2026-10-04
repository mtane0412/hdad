/**
 * 下部バーに置く、BGMのプレーヤー（issue #236）
 *
 * どのページを見ていても、BGMを再生・停止し、前の曲・次の曲へ移り、音量を変えられるようにする。
 * 下部バー（src/app/bottom-bar.tsx）の左・中央・右の3つの欄に、いま流している曲・再生の操作・音量を置く。
 * 曲名を押すと BGM のページ（/bgm/）へ移る。リピート・シャッフル・Jev の自動切り替えはバーを狭く保つために置かず、
 * BGM のページだけに残す。
 *
 * 状態はアプリの枠の BgmPlayerProvider（player-context.tsx）から読むので、BGM のページのプレーヤーと同じものを映す。
 *
 * 注意: 下部バーの格子の3つの欄をそのまま埋めるため、要素を3つ並べて返す。ほかの操作をバーの左端・右端に足すときは
 *   start・end に渡す。
 * 注意: 読めない・押し出しを受け取れていない・操作に失敗したときは、黙らずに曲名の下に理由を出す（Fail-Fast）。
 *   成功のお知らせは出さない（曲名と音量が変わることで分かるため）。
 */
import { Music } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import { Link } from '@/app/router'
import { BgmTransport, BgmVolume, type RunBgmAction } from './player-controls'
import { useBgmPlayer } from './player-context'

/** BGM の曲の一覧とリピート・シャッフル・Jev の切り替えがあるページ */
const BGM_PAGE_PATH = '/bgm/'

export const BgmBar = ({ start, end }: { start?: React.ReactNode; end?: React.ReactNode }) => {
  const player = useBgmPlayer()
  const [busy, setBusy] = useState(false)
  /** 直前の操作に失敗した理由。次の操作が通ったら消す */
  const [failure, setFailure] = useState<string | null>(null)

  const run: RunBgmAction = async (action) => {
    setBusy(true)
    try {
      await action()
      setFailure(null)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const playingTrack = player.savedTracks.find((track) => track.mediaId === player.playback.mediaId) ?? null
  const title =
    player.loaded.status === 'loading'
      ? 'BGMを読み込んでいます'
      : player.loaded.status === 'failed'
        ? 'BGMを読めません'
        : (playingTrack?.title ?? 'BGMを止めています')
  /** 曲名の下に出す理由。何も問題がなければ null で、そのときはクレジットを出す */
  const problem = failure ?? (player.loaded.status === 'failed' ? player.loaded.message : player.watchNotice)
  const disabled = busy || player.loaded.status !== 'ready'

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        {start}
        <div aria-hidden="true" className="hidden size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground sm:flex">
          <Music className="size-4" />
        </div>
        <div className="min-w-0">
          <Link href={BGM_PAGE_PATH} className="block truncate text-sm font-medium hover:underline">
            {title}
          </Link>
          {problem === null ? (
            <p className="truncate text-xs text-muted-foreground">{playingTrack?.credit}</p>
          ) : (
            <p role="alert" title={problem} className="truncate text-xs text-destructive">
              {problem}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-center gap-1">
        <BgmTransport disabled={disabled} run={run} />
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2">
        {/* 狭い画面では操作と曲名を優先し、音量は BGM のページで変えてもらう */}
        <div className="hidden md:block">
          <BgmVolume disabled={disabled} run={run} />
        </div>
        {end}
      </div>
    </>
  )
}
