/**
 * BGMのプレーヤーの操作（前の曲・再生／停止・次の曲・音量）
 *
 * 下部バー（bgm-bar.tsx）と BGM のページ（bgm-page.tsx）が同じ部品を使い、押したときの振る舞いと見た目をそろえる（issue #236）。
 * 状態はアプリの枠の BgmPlayerProvider（player-context.tsx）から読む。
 *
 * 押したときの結果の出し方は置き場所ごとに違うので、操作は run で包んで渡してもらう（ページはお知らせを浮かべ、
 * 下部バーは失敗だけをバーに出す）。run に渡す関数は、成功したときのお知らせの文言を返す。
 *
 * 注意: 止めているときの「再生」は「次の曲」と同じく Worker に次の曲を決めてもらう（一覧の順・シャッフル）。
 * 音量は幅を取らないよう、ボタンを押すと縦のスライダーが開く形にする。
 * 注意: 音量はつまみを動かしているあいだは送らず、離したときに送る（送るたびに裏方の音量が跳ねないようにするため）。
 */
import { Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { iconButtonName } from '@/core/icon-button'
import type { BgmStep } from './api'
import { volumeOfPercent, volumePercentOf } from './form'
import { useBgmPlayer } from './player-context'

/** スライダーの上限（百分率） */
const MAX_VOLUME_PERCENT = 100

/** 操作を実行し、結果を出す。action は成功したときのお知らせの文言を返す */
export type RunBgmAction = (action: () => Promise<string>) => Promise<void>

interface ControlProps {
  /** 実行中など、押させたくないとき true */
  disabled: boolean
  run: RunBgmAction
}

export const BgmTransport = ({ disabled, run }: ControlProps) => {
  const player = useBgmPlayer()
  const hasSavedTracks = player.savedTracks.length > 0

  const skip = (step: BgmStep) =>
    run(async () => {
      const next = await player.skip(step)
      const title = player.savedTracks.find((track) => track.mediaId === next.mediaId)?.title ?? ''
      return `「${title}」に切り替えました`
    })

  return (
    <>
      <Button type="button" variant="ghost" size="icon-sm" {...iconButtonName('前の曲')} disabled={disabled || !hasSavedTracks} onClick={() => void skip('previous')}>
        <SkipBack aria-hidden="true" className="fill-current" />
      </Button>
      {player.playback.mediaId === null ? (
        <Button type="button" size="icon" className="mx-1 rounded-full" {...iconButtonName('再生')} disabled={disabled || !hasSavedTracks} onClick={() => void skip('next')}>
          <Play aria-hidden="true" className="fill-current" />
        </Button>
      ) : (
        <Button
          type="button"
          size="icon"
          className="mx-1 rounded-full"
          {...iconButtonName('停止')}
          disabled={disabled}
          onClick={() =>
            void run(async () => {
              await player.savePlayback({ ...player.playback, mediaId: null })
              return 'BGMを止めました'
            })
          }
        >
          <Pause aria-hidden="true" className="fill-current" />
        </Button>
      )}
      <Button type="button" variant="ghost" size="icon-sm" {...iconButtonName('次の曲')} disabled={disabled || !hasSavedTracks} onClick={() => void skip('next')}>
        <SkipForward aria-hidden="true" className="fill-current" />
      </Button>
    </>
  )
}

/**
 * 押すと縦のスライダーが上に開く音量。下部バー（bgm-bar.tsx）と BGM のページ（bgm-page.tsx）に置く。
 * ボタンにはいまの音量を出し、開かなくても分かるようにする。
 */
export const BgmVolume = ({ disabled, run }: ControlProps) => {
  const player = useBgmPlayer()
  const labelId = useId()
  /** 動かしているあいだのつまみの位置。動かしていない（または送り終えた）ときは null で、流している音量を出す */
  const [draggingPercent, setDraggingPercent] = useState<number | null>(null)
  const percent = draggingPercent ?? volumePercentOf(player.playback.volume)
  /** 離した音量を送っているあいだ true。送り終えるまでは、枠を閉じてもつまみを離した位置のまま出す */
  const sendingRef = useRef(false)

  return (
    <Popover
      onOpenChange={(open) => {
        // 動かしている途中で閉じた（Escape など）ときは離したことにならず送られないので、動かしていた位置を捨てて流している音量に戻す
        if (!open && !sendingRef.current) setDraggingPercent(null)
      }}
    >
      <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" {...iconButtonName('音量')} />}>
        <Volume2 aria-hidden="true" className="size-4" />
        <span className="w-9 text-right font-mono text-xs tabular-nums">{percent}%</span>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-auto items-center px-2 py-3">
        <span id={labelId} className="sr-only">
          音量
        </span>
        <Slider
          aria-labelledby={labelId}
          orientation="vertical"
          className="h-32"
          min={0}
          max={MAX_VOLUME_PERCENT}
          disabled={disabled}
          value={[percent]}
          onValueChange={(next) => setDraggingPercent(Array.isArray(next) ? (next[0] ?? 0) : next)}
          onValueCommitted={(next) => {
            const committed = Array.isArray(next) ? (next[0] ?? 0) : next
            // 送り終えるまではつまみを離した位置のまま出す（応答の前に元の音量へ戻って見えないようにするため）
            sendingRef.current = true
            void run(async () => {
              await player.savePlayback({ ...player.playback, volume: volumeOfPercent(committed) })
              return `音量を${committed}%にしました`
            }).finally(() => {
              sendingRef.current = false
              setDraggingPercent(null)
            })
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
