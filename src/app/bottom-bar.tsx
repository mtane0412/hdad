/**
 * 画面の下端に固定する、配信中の操作のバー（issue #235）
 *
 * どのページを見ていても、配信中に何度も触る操作（文字起こしのオン・オフなど）に手が届くようにする。
 * 項目は項目ごとのコンポーネントを並べる形にし、BGM・ポモドーロ・読み上げのミュートはこの並びに足していく（#236〜#238）。
 *
 * 狭い画面ではサイドバーが重ねて開く形になり、閉じているあいだはサイドバーの中の開閉ボタンが見えない。
 * そのときだけ、左端にサイドバーを開くボタンを出す。
 *
 * 注意: SidebarProvider の内側で使う（サイドバーを開くのに useSidebar を使うため）。
 */
import { PanelLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { iconButtonName } from '@/core/icon-button'
import { RecognitionControl } from '@/transcript/recognition-control'

export const BottomBar = () => {
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <div
      role="region"
      aria-label="配信中の操作"
      className="sticky bottom-0 z-10 flex h-12 items-center gap-2 border-t bg-background/90 px-4 backdrop-blur supports-backdrop-filter:bg-background/75"
    >
      {isMobile && (
        <Button type="button" variant="ghost" size="icon-sm" onClick={() => setOpenMobile(true)} {...iconButtonName('サイドバーを開く')}>
          <PanelLeft aria-hidden="true" />
        </Button>
      )}
      <RecognitionControl />
    </div>
  )
}
