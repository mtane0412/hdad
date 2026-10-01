/**
 * タブの映像のページ（/tab/）
 *
 * Chrome のタブ1枚の映像と音を、合成ページの素材「タブの映像」へ出すための拡張（extension/）を配り、使い方を案内する。
 * 取り込みと送信は拡張の中（offscreen document）で行うので、このページは配信中に開いておかなくてよい
 * （以前はこのページが送り手で、開いたままにしないと映らなかった）。
 *
 * 拡張はこのページからダウンロードさせる（GET /api/admin/tab/extension.zip）。Worker がこの置き場所につなぐ設定と権限を
 * 入れて返すので、配信者が置き場所を書かずに済む（issue #168）。
 *
 * 映さないサイト（issue #165）の一覧を出し、消せるようにする。登録は拡張のボタンの右クリックから行うので、ここに入力欄は置かない
 * （手で打たせない。docs/principles.md の方針2）。
 *
 * 注意: 一覧を読めないときは、空の一覧と見分けがつくよう理由を出す。
 */
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { iconButtonName } from '@/core/icon-button'
import type { TabApi } from './api'

/** 拡張の zip。この置き場所につなぐ設定と権限が入る（worker/tab-extension.ts） */
const EXTENSION_ZIP_PATH = '/api/admin/tab/extension.zip'

/** 映さないサイトの一覧。読み込み・消す操作を受け持つ */
const BlockedHosts = ({ api }: { api: TabApi }) => {
  /** 読み込み中は undefined */
  const [hosts, setHosts] = useState<string[]>()
  const [loadFailure, setLoadFailure] = useState('')
  const actions = usePageActions()

  useEffect(() => {
    let cancelled = false
    api.loadBlockedHosts().then(
      (loaded) => {
        if (!cancelled) setHosts(loaded)
      },
      (error: unknown) => {
        if (!cancelled) setLoadFailure(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  const remove = (host: string) =>
    actions.run(async () => {
      setHosts(await api.removeBlockedHost(host))
      return `${host} を一覧から消しました`
    })

  if (loadFailure !== '') {
    return (
      <Alert variant="destructive">
        <AlertTitle>映さないサイトの一覧を読み込めませんでした</AlertTitle>
        <AlertDescription>{loadFailure}</AlertDescription>
      </Alert>
    )
  }
  if (hosts === undefined) return <Skeleton className="h-16 w-full" aria-label="映さないサイトの一覧を読み込んでいます" />

  return (
    <div className="flex flex-col gap-3">
      {actions.feedback}
      {hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">まだ登録していません。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {hosts.map((host) => (
            <li key={host} className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm">
              <span className="font-mono">{host}</span>
              <Button variant="ghost" size="icon-sm" {...iconButtonName(`${host} を一覧から消す`)} disabled={actions.busy} onClick={() => void remove(host)}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export const TabPage = ({ api }: { api: TabApi }) => (
  <div className="flex flex-col gap-6">
    <Card>
      <CardHeader>
        <CardTitle>拡張を入れる</CardTitle>
        <CardDescription>はじめに一度だけ行います。拡張は、いま開いている HDAD にだけタブの映像を送ります。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* アプリの外（/api/*）なので Link ではなく普通の a で開く */}
        <a href={EXTENSION_ZIP_PATH} download className={buttonVariants({ variant: 'outline', className: 'self-start' })}>
          拡張をダウンロード
        </a>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>ダウンロードした zip を展開します（hdad-tab というフォルダができます）</li>
          <li>Chrome で chrome://extensions を開き、右上の「デベロッパー モード」を有効にします</li>
          <li>「パッケージ化されていない拡張機能を読み込む」を押し、hdad-tab フォルダを選びます</li>
          <li>前の版を入れていたときは、前の版を削除してから読み込みます</li>
        </ol>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>映すタブの選び方</CardTitle>
        <CardDescription>このページは開いておかなくてかまいません。Chrome で HDAD にログインしていれば映せます。</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>映したいタブを開きます</li>
          <li>拡張のショートカット（既定は Alt+Shift+T）を押すか、ツールバーの拡張のボタンを押します。映しているあいだ、ボタンに「ON」が出ます</li>
          <li>別のタブで同じ操作をすると、そのタブに切り替わります</li>
          <li>映しているタブでもう一度押すと、映すのをやめます</li>
        </ol>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>映さないサイト</CardTitle>
        <CardDescription>
          映しているタブがここにあるサイトへ移ると、拡張は合成ページへ送るのを止め（ボタンに「止」が出ます）、映してよいページへ戻ると再開します。
          登録するには、映したくないサイトを開いて、拡張のボタンを右クリックして「このサイトを映さない」を選びます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <BlockedHosts api={api} />
      </CardContent>
    </Card>
  </div>
)
