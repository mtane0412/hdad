/**
 * 画面の下端に固定する、配信中の操作のバー（issue #235）
 *
 * どのページを見ていても、配信中に何度も触る操作（文字起こしのオン・オフなど）に手が届くようにする。
 * 形は音楽プレーヤー（Spotify など）にならい、サイドバーの下まで画面の幅いっぱいに通す。
 * 並びは左・中央・右の3つに分け、左にいま流している曲・中央に再生の操作・右に音量（BGM。src/bgm/bgm-bar.tsx。#236）を置き、
 * 右にはそのほかの切り替え（ポモドーロ（src/pomodoro/pomodoro-bar.tsx。#237）・テキストの本文の書き換え（src/text/text-bar.tsx。#294）・文字起こし・読み上げのミュート（src/speech/speech-mute-control.tsx。#238））を並べる。
 * 同じ操作をエージェントから呼べるよう、WebMCP のツールの登録（src/webmcp/webmcp-tools.tsx。#279）もここに置く
 * （普段は何も描かず、登録を断られたときだけ右端に理由を出す）。
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
import { SpeechMuteControl } from '@/speech/speech-mute-control'
import type { TextApi } from '@/text/api'
import { TextBar } from '@/text/text-bar'
import { RecognitionControl } from '@/transcript/recognition-control'
import { WebMcpTools } from '@/webmcp/webmcp-tools'
import type { PageEntry, WebMcpApis } from '@/webmcp/tools'
import { PAGE_GROUPS } from './pages'

/** エージェントに見せるページ（サイドバーの項目と同じ並び） */
const WEBMCP_PAGES: readonly PageEntry[] = PAGE_GROUPS.flatMap((group) => group.pages.map((page) => ({ group: group.label, path: page.path, name: page.name })))

/**
 * @param apis WebMCP のツールが使う Worker の Api（アプリの枠の PageContext）
 * @param textApi テキストの本文の書き換え（text-bar.tsx）が使う Worker の Api
 */
export const BottomBar = ({ apis, textApi }: { apis: WebMcpApis; textApi: TextApi }) => {
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
            <TextBar api={textApi} />
            <RecognitionControl />
            <SpeechMuteControl />
            <WebMcpTools pages={WEBMCP_PAGES} apis={apis} />
          </>
        }
      />
    </div>
  )
}
