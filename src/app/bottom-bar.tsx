/**
 * 画面の下端に固定する、配信中の操作のバー（issue #235）
 *
 * どのページを見ていても、配信中に何度も触る操作（文字起こしのオン・オフなど）に手が届くようにする。
 * 形は音楽プレーヤー（Spotify など）にならい、サイドバーの下まで画面の幅いっぱいに通す。
 * 並びは左・中央・右の3つに分け、左にいま流している曲・中央に再生の操作・右に音量（BGM。src/bgm/bgm-bar.tsx。#236）を置き、
 * 右にはそのほかの切り替え（ポモドーロ（src/pomodoro/pomodoro-bar.tsx。#237）・文字起こし・読み上げのミュート（#238））を並べていく。
 *
 * 狭い画面ではサイドバーが重ねて開く形になり、閉じているあいだはサイドバーの中の開閉ボタンが見えない。
 * そのときだけ、左端にサイドバーを開くボタンを出す。
 *
 * 注意: SidebarProvider・BgmPlayerProvider・PomodoroTimerProvider の内側で使う（サイドバーを開くのに useSidebar を、
 *   BGMの状態に useBgmPlayer を、ポモドーロのタイマーに usePomodoroTimer を使うため）。高さは SidebarProvider に置いた
 *   --bottom-bar-height に従う（サイドバーの下端と本文の下の余白も同じ値を使う。src/app/app.tsx）。
 */
import { PanelLeft } from 'lucide-react'
import { BgmBar } from '@/bgm/bgm-bar'
import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { iconButtonName } from '@/core/icon-button'
import { PomodoroBar } from '@/pomodoro/pomodoro-bar'
import { RecognitionControl } from '@/transcript/recognition-control'

export const BottomBar = () => {
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <div
      role="region"
      aria-label="配信中の操作"
      className="fixed inset-x-0 bottom-0 z-20 grid h-(--bottom-bar-height) grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-t bg-sidebar px-4 text-sidebar-foreground"
    >
      <BgmBar
        start={
          isMobile && (
            <Button
              type="button"
              variant="ghost"
              className="size-9 shrink-0 rounded-full text-muted-foreground"
              onClick={() => setOpenMobile(true)}
              {...iconButtonName('サイドバーを開く')}
            >
              <PanelLeft aria-hidden="true" className="size-5" />
            </Button>
          )
        }
        end={
          <>
            <PomodoroBar />
            <RecognitionControl />
          </>
        }
      />
    </div>
  )
}
