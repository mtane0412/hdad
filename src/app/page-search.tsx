/**
 * ページを探して移る窓（コマンドパレット）
 *
 * サイドバーの項目は15を超えるので、名前の一部や言い換え（「OBS」「アラート」など）を打って Enter で移れるようにする。
 * Cmd+K（Mac 以外は Ctrl+K）でどのページからでも開き、見出しの横のボタンからも開ける。
 *
 * 注意: 一覧は pages.tsx の PAGE_GROUPS から作る。ページを足したらここを直す必要はない。
 */
import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { PAGE_GROUPS } from './pages'
import { navigate } from './router'

/** Mac なら ⌘、それ以外は Ctrl を案内する（押せるのはどちらでもよい） */
const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.userAgent)

/** 窓を開くキー（Cmd+K / Ctrl+K）かどうか。日本語の変換中に打った k は数えない */
const isOpenShortcut = (event: KeyboardEvent): boolean =>
  !event.isComposing && event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey

/**
 * 見出しの横に置くボタンと、それが開く窓。
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto shrink-0 gap-2 text-muted-foreground max-sm:size-9 max-sm:px-0"
        onClick={() => setOpen(true)}
        aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
      >
        <Search aria-hidden="true" />
        {/* 狭い画面では虫眼鏡だけにして見出しの場所を空ける（名前は読み上げ用に残す） */}
        <span className="max-sm:sr-only">ページを探す</span>
        <KbdGroup aria-hidden="true" className="max-sm:hidden">
          <Kbd>{isMac() ? '⌘' : 'Ctrl'}</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </Button>
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
