/**
 * アプリの枠（ログインの確認とサイドバー）
 *
 * ページUIはTwitchログインを前提にする。開いたらまず /api/me でログインを確かめ、
 * ログインしていなければ入口だけを出し、ログインしていればサイドバー付きの画面を出す。
 * どのページUIのURL（/wallpaper/ など）を開いてもこの枠が出て、中身だけがパスに応じて切り替わる（ページの一覧は pages.tsx）。
 * OBSに載せる素材ページ（<カテゴリ>/<id>/・alerts/）はこの枠を通らないので、ログインなしで動く。
 *
 * 注意: ログインの確認に失敗したとき（Workerに届かないなど）は未ログイン扱いにせず、エラーを出す（Fail-Fast）。
 * api を引数で受け取るのは、テストで差し替えるため。
 */
import { LogOut } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AdminApi, Me } from '@/admin/api'
import type { BotApi } from '@/bot/api'
import type { SpeechApi } from '@/speech/api'
import type { StatsApi } from '@/stats/api'
import type { ViewerApi } from '@/viewers/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { findPage, PAGE_GROUPS, type PageContext } from './pages'
import { Link, usePathname } from './router'

const LOGIN_PATH = '/api/auth/login'

type Session = { status: 'checking' } | { status: 'signed-out' } | { status: 'signed-in'; me: Me } | { status: 'failed'; message: string }

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const Centered = ({ children }: { children: React.ReactNode }) => (
  <main className="flex min-h-svh items-center justify-center p-6">{children}</main>
)

const LoginScreen = () => (
  <Centered>
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>HDAD</CardTitle>
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
  <Alert className="max-w-md">
    <AlertTitle>
      <code>{pathname}</code> というページはありません
    </AlertTitle>
    <AlertDescription>
      <Link href="/" className="underline underline-offset-4">
        ダッシュボードへ戻る
      </Link>
    </AlertDescription>
  </Alert>
)

const Shell = ({ context, onLogout }: { context: PageContext; onLogout: () => void }) => {
  const pathname = usePathname()
  const page = findPage(pathname)

  return (
    <TooltipProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
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
          <SidebarFooter>
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
        <SidebarInset>
          <header className="flex h-12 items-center gap-2 border-b px-4">
            <SidebarTrigger aria-label="サイドバーを開閉する" />
            <h1 className="text-sm font-medium">{page ? page.name : 'ページが見つかりません'}</h1>
          </header>
          {/* ギャラリー同士は同じ部品なので、ページが変わったら key で作り直して前のページの状態を持ち越さない */}
          <div key={pathname} className="p-6">
            {page ? page.render(context) : <NotFound pathname={pathname} />}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}

export const App = ({
  api,
  statsApi,
  botApi,
  viewerApi,
  speechApi,
}: {
  api: AdminApi
  statsApi: StatsApi
  botApi: BotApi
  viewerApi: ViewerApi
  speechApi: SpeechApi
}) => {
  const [session, setSession] = useState<Session>({ status: 'checking' })

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
  }, [api])

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
            <AlertDescription>{session.message}</AlertDescription>
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
            me: session.me,
            onOverlayKeyChange: (overlayKey) => setSession({ status: 'signed-in', me: { ...session.me, overlayKey } }),
          }}
          onLogout={logout}
        />
      )
  }
}
