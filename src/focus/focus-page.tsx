/**
 * 注目コメントのページ
 *
 * ある人の発言を題に雑談するときなどに、直近の発言から1件を選び、その人のアイコン・名前と一緒に
 * 配信画面へ大きく映すための指定を受け持つ（issue #94）。選んだ1件は次の発言では差し替わらない。
 *
 * 指定は Worker（KVの focus-comment）に保存されるので、オーバーレイの再読み込みは要らない。次にオーバーレイが
 * 読みに来た時点（10秒以内）で切り替わる。URLに相手を埋めないのは、配信中に相手を変えるたびにOBSのURLを
 * 貼り替えることになるためである（読み上げの設定をURLから移した issue #86 と同じ考え方）。
 *
 * 配信画面への出し方はこのページが受け持たない。注目コメント専用のオーバーレイ（focus/overlay/）は消したので
 * （issue #107）、映すには合成オーバーレイの管理画面（/overlay/）で素材として置く。ここからはそこへ案内するだけにする。
 *
 * Workerの呼び出しは api.ts に分けてテストする。
 *
 * 注意: 直近の発言は、配信中のあいだだけ貯めている記録（stream_chat_messages）から読む。配信していなければ
 * 1件も出ないので、その理由を画面に書く（空の一覧を黙って出すと、読めていないのか発言が無いのか分からない）。
 * 注意: 失敗は黙って無視せず、理由を画面に出す（Fail-Fast）。
 */
import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePageActions } from '@/admin/page-actions'
import { Link } from '@/app/router'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { iconButtonName } from '@/core/icon-button'
import type { FocusApi, FocusPick, PickableMessage } from './api'
import type { FocusTarget } from './focused'

/** 日時を、配信者のブラウザの時間帯で「時:分」に直す */
const time = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * いま取り上げている1件。配信画面に映るものと同じく、アイコン・名前・本文を並べる。
 *
 * 注意: アイコンは shadcn/ui の Avatar ではなく素の img で出す。Avatar は画像を読み込み終えるまで
 * img を置かないので、アイコンのURLが壊れていても画面で気付けない（配信画面の素材も素の img で出す）。
 */
const CurrentFocus = ({ target }: { target: FocusTarget | null }) => {
  if (target === null) return <p className="text-sm text-muted-foreground">いまは何も取り上げていません。</p>
  return (
    <div className="flex items-start gap-3">
      {/* 隣の名前と同じ人を指す飾りなので、代替文字は空にする */}
      <img src={target.profileImageUrl} alt="" className="size-10 shrink-0 rounded-full" />
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{target.displayName} さんの発言を取り上げています。</p>
        <p className="text-sm">{target.text}</p>
      </div>
    </div>
  )
}

export const FocusPage = ({ api }: { api: FocusApi }) => {
  const [target, setTarget] = useState<FocusTarget | null>(null)
  const [messages, setMessages] = useState<readonly PickableMessage[]>([])
  /** 直近の発言を一度でも読めたか。読めるまでは「発言がありません」と書かない */
  const [loaded, setLoaded] = useState(false)
  const actions = usePageActions()

  // 開いたときに、取り上げているものと直近の発言を読む
  useEffect(() => {
    let cancelled = false
    void actions.run(async () => {
      const [loadedTarget, recent] = await Promise.all([api.load(), api.recent()])
      if (cancelled) return ''
      setTarget(loadedTarget)
      setMessages(recent)
      setLoaded(true)
      return ''
    })
    return () => {
      cancelled = true
    }
    // 読み込みは開いたときの1回だけにする（actions は描くたびに作り直されるので、依存には入れない）
  }, [api])

  /** 選んだ発言を取り上げる。外すときは null を渡す */
  const focus = (next: FocusPick | null, notice: string) =>
    actions.run(async () => {
      setTarget(await api.save(next))
      return notice
    })

  const reload = () =>
    actions.run(async () => {
      setMessages(await api.recent())
      setLoaded(true)
      return '直近の発言を読み直しました'
    })

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>いま取り上げているもの</CardTitle>
          <CardDescription>変えるとOBSの再読み込みなしで、10秒以内に配信画面へ反映される。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* 直近の発言の一覧にも同じ本文・同じ名前のボタンが並ぶので、領域に名前を付けて読み分けられるようにする */}
          <div role="group" aria-label="いま取り上げているもの" className="flex flex-col gap-4">
            <CurrentFocus target={target} />
            <div>
              <Button
                type="button"
                variant="outline"
                disabled={actions.busy || target === null}
                onClick={() => void focus(null, '取り上げをやめました')}
              >
                取り上げをやめる
              </Button>
            </div>
          </div>

        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>直近の発言から選ぶ</CardTitle>
          <CardDescription>
            いま進んでいる配信の発言を1件選ぶと、その人のアイコン・名前と一緒に配信画面の中央へ大きく映る（配信していないあいだは本文を貯めていない）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              {...iconButtonName('発言を読み直す')}
              disabled={actions.busy}
              onClick={() => void reload()}
            >
              <RotateCw aria-hidden="true" />
            </Button>
          </div>

          {messages.length === 0 ? (
            loaded && <p className="text-sm text-muted-foreground">配信中の発言がありません。</p>
          ) : (
            <ul aria-label="直近の発言" className="flex flex-col gap-2">
              {messages.map((message) => (
                <li key={message.messageId} className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex flex-col gap-1">
                    <p className="text-xs text-muted-foreground">
                      {message.displayName}（<span className="font-mono">{message.login}</span>） {time(message.at)}
                    </p>
                    <p className="text-sm">{message.text}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={actions.busy}
                      onClick={() =>
                        void focus(
                          {
                            messageId: message.messageId,
                            login: message.login,
                            displayName: message.displayName,
                            text: message.text,
                          },
                          `${message.displayName} さんの発言を取り上げました`,
                        )
                      }
                    >
                      この発言を取り上げる
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>配信画面への出し方</CardTitle>
          <CardDescription>取り上げた1件を映すには、オーバーレイに「注目コメント」の素材を置く。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            置いたあとは、取り上げるものをこのページで変えるだけでよい（OBSのURLは貼り替えなくてよい）。
          </p>
          {/* オーバーレイの管理画面はアプリのページなので、router.tsx の Link で移る */}
          <Link href="/overlay/" className={buttonVariants({ variant: 'outline' })}>
            オーバーレイの構成を開く
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
