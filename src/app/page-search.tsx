/**
 * ページを探して移る窓（コマンドパレット）
 *
 * サイドバーの項目は15を超えるので、名前の一部や言い換え（「OBS」「アラート」など）を打って Enter で移れるようにする。
 * Cmd+K（Mac 以外は Ctrl+K）でどのページからでも開き、サイドバーの上部のボタンからも開ける。
 *
 * 注意: 一覧は pages.tsx の PAGE_GROUPS から作る。ページを足したらここを直す必要はない。
 */
import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { PAGE_GROUPS } from './pages'
import { navigate } from './router'

/** Mac なら ⌘、それ以外は Ctrl を案内する（押せるのはどちらでもよい） */
const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.userAgent)

/** 窓を開くキー（Cmd+K / Ctrl+K）かどうか。日本語の変換中に打った k は数えない */
const isOpenShortcut = (event: KeyboardEvent): boolean =>
  !event.isComposing && event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey

/**
 * サイドバーの上部に置くボタンと、それが開く窓。
 *
 * 注意: ボタンはサイドバーの項目の形なので、SidebarMenuItem の内側に置く。
 *
 * @param pathname いまのパス。窓の中でいまのページに印を付けるのに使う
 */
export const PageSearch = ({ pathname }: { pathname: string }) => {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isOpenShortcut(event)) return
      event.preventDefault()
      setOpen((current) => !current)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const go = (path: string) => {
    setOpen(false)
    if (path !== pathname) navigate(path)
  }

  return (
    <>
      <SidebarMenuButton
        variant="outline"
        tooltip="ページを探す"
        className="text-muted-foreground"
        onClick={() => setOpen(true)}
        aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
      >
        <Search aria-hidden="true" />
        <span>ページを探す</span>
        {/* アイコンだけに畳んだサイドバーでは、キーの案内を隠して虫眼鏡だけにする */}
        <KbdGroup aria-hidden="true" className="ml-auto group-data-[collapsible=icon]:hidden">
          <Kbd>{isMac() ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </SidebarMenuButton>
      <CommandDialog open={open} onOpenChange={setOpen} title="ページを移動" description="ページの名前の一部を打って、Enter で移ります">
        <Command>
        <CommandInput placeholder="ページの名前・OBS・アラートなど" />
        <CommandList>
          <CommandEmpty>当てはまるページはありません</CommandEmpty>
          {PAGE_GROUPS.map((group) => (
            <CommandGroup key={group.label} heading={group.label}>
              {group.pages.map((page) => (
                <CommandItem
                  key={page.path}
                  value={page.name}
                  keywords={page.keywords ? [...page.keywords] : undefined}
                  onSelect={() => go(page.path)}
                >
                  <page.icon aria-hidden="true" />
                  <span>{page.name}</span>
                  {page.path === pathname && <span className="ml-auto text-xs text-muted-foreground">いまのページ</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
