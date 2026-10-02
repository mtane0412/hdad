/**
 * アプリの枠（ログインの確認とサイドバー）
 *
 * ページUIはTwitchログインを前提にする。開いたらまず /api/me でログインを確かめ、
 * ログインしていなければ入口だけを出し、ログインしていればサイドバー付きの画面を出す。
 * どのページUIのURL（/wallpaper/ など）を開いてもこの枠が出て、中身だけがパスに応じて切り替わる（ページの一覧は pages.tsx）。
 * OBSに載せるページ（overlay/stage/・overlay/backstage/ など）はこの枠を通らないので、ログインなしで動く。
 *
 * 注意: ログインの確認に失敗したとき（Workerに届かないなど）は未ログイン扱いにせず、エラーを出す（Fail-Fast）。
 * api を引数で受け取るのは、テストで差し替えるため。
 */
import { LogOut, RotateCw, SearchX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AdminApi, Me } from '@/admin/api'
import type { BgmApi } from '@/bgm/api'
import type { BotApi } from '@/bot/api'
import type { DrawApi } from '@/draw/api'
import type { CommentApi } from '@/comments/api'
import type { FocusApi } from '@/focus/api'
import type { LlmApi } from '@/llm/api'
import type { OverlayLayoutAdminApi } from '@/overlay/admin-api'
import type { ScreenAdminApi } from '@/screen/api'
import type { SpeechApi } from '@/speech/api'
import type { StatsApi } from '@/stats/api'
import type { ViewerApi } from '@/viewers/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { Skeleton } from '@/components/ui/skeleton'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PageSearch } from './page-search'
import { findPage, PAGE_GROUPS, type PageContext } from './pages'
import { Link, usePathname } from './router'
import { UnsavedChangesDialog } from './unsaved-changes-dialog'

const LOGIN_PATH = '/api/auth/login'
const APP_NAME = 'HDAD'

type Session = { status: 'checking' } | { status: 'signed-out' } | { status: 'signed-in'; me: Me } | { status: 'failed'; message: string }

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const Centered = ({ children }: { children: React.ReactNode }) => (
  <main className="flex min-h-svh items-center justify-center p-6">{children}</main>
)

const LoginScreen = () => (
  <Centered>
    <Card className="w-full max-w-sm">
      <CardHeader>
        {/* このページの見出しなので h1 にする（CardTitle は h2） */}
        <h1 className="font-heading text-base leading-snug font-medium">HDAD</h1>
        <CardDescription>Hyperfocus-Driven Assistant Director</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">配信者のTwitchアカウントでログインしてください。</p>
        <a className={buttonVariants({ className: 'w-full' })} href={LOGIN_PATH}>
          Twitchでログイン
        </a>
      </CardContent>
    </Card>
  </Centered>
)

/** パスに当たるページがないときの画面 */
const NotFound = ({ pathname }: { pathname: string }) => (
  <div className="flex flex-col items-center gap-3 py-16 text-center">
    <SearchX aria-hidden="true" className="size-10 text-muted-foreground" />
    <p className="text-sm">
      <code className="rounded bg-muted px-1.5 py-0.5">{pathname}</code> というページはありません
    </p>
    <p className="text-sm text-muted-foreground">サイドバーか、上の「ページを探す」から移れます。</p>
    <Link href="/" className={buttonVariants({ variant: 'outline' })}>
      ダッシュボードへ戻る
    </Link>
  </div>
)

const Shell = ({ context, onLogout }: { context: PageContext; onLogout: () => void }) => {
  const pathname = usePathname()
  const page = findPage(pathname)
  const title = page ? page.name : 'ページが見つかりません'
  const headingRef = useRef<HTMLHeadingElement>(null)
  const firstPathname = useRef(pathname)

  // ブラウザのタブや履歴の一覧で、どのページか見分けられるようにする。
  // 枠が消えたとき（ログアウトしてログインの入口に戻ったときなど）は、アプリ名だけに戻す
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`
    return () => {
      document.title = APP_NAME
    }
  }, [title])

  // ページを移ったら見出しへフォーカスを移し、読み上げソフトが新しいページの先頭から読めるようにする。
  // 開いた直後（最初のパス）はブラウザの既定のまま、どこにもフォーカスを置かない
  useEffect(() => {
    if (pathname === firstPathname.current) return
    firstPathname.current = ''
    headingRef.current?.focus()
  }, [pathname])

  return (
    <TooltipProvider>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm shadow-md focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        本文へ移動
      </a>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          {/* サイドバーの見出しと末尾も、読み上げソフトの「ランドマーク」で飛べる領域にする */}
          <SidebarHeader role="banner">
            <div className="px-2 py-1 group-data-[collapsible=icon]:hidden">
              <span className="font-mono text-sm font-semibold">HDAD</span>
              <span className="block text-[10px] leading-tight text-muted-foreground">Hyperfocus-Driven Assistant Director</span>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <nav aria-label="サイト内の移動">
              {PAGE_GROUPS.map((group) => (
                <SidebarGroup key={group.label}>
                  <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.pages.map((item) => (
                        <SidebarMenuItem key={item.path}>
                          <SidebarMenuButton
                            isActive={item.path === pathname}
                            tooltip={item.name}
                            render={<Link href={item.path} aria-current={item.path === pathname ? 'page' : undefined} />}
                          >
                            <item.icon aria-hidden="true" />
                            <span>{item.name}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </nav>
          </SidebarContent>
          <SidebarFooter role="region" aria-label="アカウント">
            <SidebarMenu>
              <SidebarMenuItem>
                <span className="truncate px-2 font-mono text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">{context.me.login}</span>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="ログアウト" onClick={onLogout}>
                  <LogOut aria-hidden="true" />
                  <span>ログアウト</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset id="main">
          <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur supports-backdrop-filter:bg-background/75">
            <SidebarTrigger aria-label="サイドバーを開閉する" />
            <h1 ref={headingRef} tabIndex={-1} className="truncate text-base font-semibold tracking-tight outline-none">
              {title}
            </h1>
            <PageSearch pathname={pathname} />
          </header>
          {/* ページが変わったら key で作り直し、前のページの状態を持ち越さない */}
          <div key={pathname} className="mx-auto w-full max-w-5xl p-4 sm:p-6">
            {page ? page.render(context) : <NotFound pathname={pathname} />}
          </div>
        </SidebarInset>
      </SidebarProvider>
      <UnsavedChangesDialog />
    </TooltipProvider>
  )
}

export const App = ({
  api,
  statsApi,
  botApi,
  viewerApi,
  speechApi,
  screenApi,
  focusApi,
  commentApi,
  drawApi,
  llmApi,
  overlayApi,
  bgmApi,
}: {
  api: AdminApi
  statsApi: StatsApi
  botApi: BotApi
  viewerApi: ViewerApi
  speechApi: SpeechApi
  screenApi: ScreenAdminApi
  focusApi: FocusApi
  commentApi: CommentApi
  drawApi: DrawApi
  llmApi: LlmApi
  overlayApi: OverlayLayoutAdminApi
  bgmApi: BgmApi
}) => {
  const [session, setSession] = useState<Session>({ status: 'checking' })
  // 確かめ直すたびに増やし、ログインの確認をもう一度走らせる
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    api.me().then(
      (me) => {
        if (!cancelled) setSession(me === null ? { status: 'signed-out' } : { status: 'signed-in', me })
      },
      (error: unknown) => {
        if (!cancelled) setSession({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, attempt])

  const logout = () => {
    api.logout().then(
      () => setSession({ status: 'signed-out' }),
      (error: unknown) => setSession({ status: 'failed', message: errorMessage(error) }),
    )
  }

  switch (session.status) {
    case 'checking':
      return (
        <Centered>
          <Skeleton className="h-40 w-full max-w-sm" aria-label="ログインを確認しています" />
        </Centered>
      )
    case 'signed-out':
      return <LoginScreen />
    case 'failed':
      return (
        <Centered>
          <Alert variant="destructive" className="max-w-md">
            <AlertTitle>ログインを確認できませんでした</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{session.message}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSession({ status: 'checking' })
                  setAttempt((current) => current + 1)
                }}
              >
                <RotateCw aria-hidden="true" />
                もう一度確かめる
              </Button>
            </AlertDescription>
          </Alert>
        </Centered>
      )
    case 'signed-in':
      return (
        <Shell
          context={{
            api,
            statsApi,
            botApi,
            viewerApi,
            speechApi,
            screenApi,
            focusApi,
            commentApi,
            drawApi,
            llmApi,
            overlayApi,
            bgmApi,
            me: session.me,
            onOverlayKeyChange: (overlayKey) => setSession({ status: 'signed-in', me: { ...session.me, overlayKey } }),
          }}
          onLogout={logout}
        />
      )
  }
}
