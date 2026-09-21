/**
 * アプリの枠（ログインの確認とサイドバー）
 *
 * ページUIはTwitchログインを前提にする。開いたらまず /api/me でログインを確かめ、
 * ログインしていなければ入口だけを出し、ログインしていればサイドバー付きの画面を出す。
 * OBSに載せる素材ページ（<カテゴリ>/<id>/・alerts/）はこの枠を通らないので、ログインなしで動く。
 *
 * 注意: ログインの確認に失敗したとき（Workerに届かないなど）は未ログイン扱いにせず、エラーを出す（Fail-Fast）。
 * api を引数で受け取るのは、テストで差し替えるため。
 */
import { Clock, Image, LayoutDashboard, LogOut, MessageSquare, Siren, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AdminApi, Me } from '@/admin/api'
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
import { Dashboard } from './dashboard'

/** 枠が使うWorkerの呼び出し（ログインの確認とログアウト） */
export type SessionApi = Pick<AdminApi, 'me' | 'logout'>

const LOGIN_PATH = '/api/auth/login'

interface NavItem {
  name: string
  href: string
  icon: LucideIcon
}

/** サイドバーの項目。カテゴリを増やしたらここに足す */
const NAV_GROUPS: readonly { label: string; items: readonly NavItem[] }[] = [
  { label: '配信', items: [{ name: 'ダッシュボード', href: '/', icon: LayoutDashboard }] },
  {
    label: '素材',
    items: [
      { name: '壁紙', href: '/wallpaper/', icon: Image },
      { name: '時計', href: '/clock/', icon: Clock },
      { name: 'チャット', href: '/chat/', icon: MessageSquare },
      { name: 'アラート', href: '/admin/', icon: Siren },
    ],
  },
]

type Session = { status: 'checking' } | { status: 'signed-out' } | { status: 'signed-in'; me: Me } | { status: 'failed'; message: string }

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const Centered = ({ children }: { children: React.ReactNode }) => (
  <main className="flex min-h-svh items-center justify-center p-6">{children}</main>
)

const LoginScreen = () => (
  <Centered>
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>stream-assets</CardTitle>
        <CardDescription>配信者のTwitchアカウントでログインしてください。</CardDescription>
      </CardHeader>
      <CardContent>
        <a className={buttonVariants({ className: 'w-full' })} href={LOGIN_PATH}>
          Twitchでログイン
        </a>
      </CardContent>
    </Card>
  </Centered>
)

const Shell = ({ me, onLogout }: { me: Me; onLogout: () => void }) => (
  <TooltipProvider>
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <span className="px-2 py-1 font-mono text-sm font-semibold group-data-[collapsible=icon]:hidden">stream-assets</span>
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label="サイト内の移動">
            {NAV_GROUPS.map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map((item) => (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton
                          isActive={item.href === '/'}
                          tooltip={item.name}
                          render={<a href={item.href} aria-current={item.href === '/' ? 'page' : undefined} />}
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
              <span className="truncate px-2 font-mono text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">{me.login}</span>
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
          <h1 className="text-sm font-medium">ダッシュボード</h1>
        </header>
        <div className="p-6">
          <Dashboard />
        </div>
      </SidebarInset>
    </SidebarProvider>
  </TooltipProvider>
)

export const App = ({ api }: { api: SessionApi }) => {
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
      return <Shell me={session.me} onLogout={logout} />
  }
}
