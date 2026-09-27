/**
 * 注目コメントのページ
 *
 * 配信中に「今から怖い話をする」と言い出した人が現れたときや、ある人の発言を題に雑談するときに、
 * その1件を配信画面へ大きく映すための指定を受け持つ（issue #94）。取り上げ方は2通りある。
 * - 人に追従する: その人の発言が届くたびに、オーバーレイが映すものを最新の1件へ差し替える
 * - 発言1件を取り上げる: 直近の発言から選んだ1件を固定する（次の発言では差し替わらない）
 *
 * 指定は Worker（KVの focus-target）に保存されるので、オーバーレイの再読み込みは要らない。次にオーバーレイが
 * 読みに来た時点（10秒以内）で切り替わる。URLに相手を埋めないのは、配信中に相手を変えるたびにOBSのURLを
 * 貼り替えることになるためである（読み上げの設定をURLから移した issue #86 と同じ考え方）。
 *
 * Workerの呼び出しは api.ts、URLの組み立ては url.ts に分けてテストする。オーバーレイ用キーはアプリの枠から
 * 受け取り、再発行はトリガーのページ（/triggers/）が受け持つ（キーはほかのオーバーレイと共通のため）。
 *
 * 注意: 直近の発言は、配信中のあいだだけ貯めている記録（stream_chat_messages）から読む。配信していなければ
 * 1件も出ないので、その理由を画面に書く（空の一覧を黙って出すと、読めていないのか発言が無いのか分からない）。
 * 注意: 失敗は黙って無視せず、理由を画面に出す（Fail-Fast）。
 */
import { useEffect, useId, useState } from 'react'
import { usePageActions } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { FocusApi, PickableMessage } from './api'
import type { FocusTarget } from './focused'
import { focusDemoUrl, focusUrl } from './url'

/** ブラウザソースに設定する推奨の大きさ。配信画面と同じ大きさにして、余白ごと重ねる */
const OVERLAY_SIZE = { width: 1920, height: 1080 }

/** 日時を、配信者のブラウザの時間帯で「時:分」に直す */
const 時刻 = (iso: string): string => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** いま取り上げているものの説明 */
const CurrentFocus = ({ target }: { target: FocusTarget | null }) => {
  if (target === null) return <p className="text-sm text-muted-foreground">いまは何も取り上げていません。</p>
  if (target.type === 'viewer') {
    return (
      <p className="text-sm">
        <span className="font-mono">{target.login}</span> さんの発言に追従しています（発言のたびに差し替わります）。
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground">{target.displayName} さんの発言を取り上げています。</p>
      <p className="text-sm">{target.text}</p>
    </div>
  )
}

export const FocusPage = ({ api, overlayKey }: { api: FocusApi; overlayKey: string | null }) => {
  const [target, setTarget] = useState<FocusTarget | null>(null)
  const [messages, setMessages] = useState<readonly PickableMessage[]>([])
  /** 直近の発言を一度でも読めたか。読めるまでは「発言がありません」と書かない */
  const [loaded, setLoaded] = useState(false)
  const [login, setLogin] = useState('')
  const actions = usePageActions()
  const loginFieldId = useId()
  const urlFieldId = useId()
  const sizeHintId = useId()

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

  /** 取り上げるものを保存する。外すときは null を渡す */
  const 取り上げる = (next: FocusTarget | null, notice: string) =>
    actions.run(async () => {
      setTarget(await api.save(next))
      return notice
    })

  const 読み直す = () =>
    actions.run(async () => {
      setMessages(await api.recent())
      setLoaded(true)
      return '直近の発言を読み直しました'
    })

  const copyUrl = async (): Promise<string> => {
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    if (overlayKey === null) throw new Error('オーバーレイ用キーが発行されていません')
    await navigator.clipboard.writeText(focusUrl(window.location.origin, overlayKey))
    return 'OBS用のURLをコピーしました'
  }

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
                onClick={() => void 取り上げる(null, '取り上げをやめました')}
              >
                取り上げをやめる
              </Button>
            </div>
          </div>

          <div role="group" aria-label="人に追従する" className="flex flex-col gap-2">
            <Label htmlFor={loginFieldId}>追従する人のログイン名</Label>
            <div className="flex gap-2">
              <Input
                id={loginFieldId}
                className="max-w-64"
                autoComplete="off"
                placeholder="kowai_hanashi"
                value={login}
                onChange={(event) => setLogin(event.currentTarget.value)}
              />
              <Button type="button" disabled={actions.busy} onClick={() => void 取り上げる({ type: 'viewer', login }, `${login} さんに追従します`)}>
                この人に追従する
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">その人が発言するたび、最新の1件に差し替わる（「今から怖い話をする」のような語りに使う）。</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>直近の発言から選ぶ</CardTitle>
          <CardDescription>いま進んでいる配信の発言だけを出す（配信していないあいだは本文を貯めていない）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <Button type="button" variant="outline" disabled={actions.busy} onClick={() => void 読み直す()}>
              発言を読み直す
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
                      {message.displayName}（<span className="font-mono">{message.login}</span>） {時刻(message.at)}
                    </p>
                    <p className="text-sm">{message.text}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={actions.busy}
                      onClick={() =>
                        void 取り上げる(
                          {
                            type: 'message',
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
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={actions.busy}
                      onClick={() => void 取り上げる({ type: 'viewer', login: message.login }, `${message.displayName} さんに追従します`)}
                    >
                      この人に追従する
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
          <CardTitle>OBS用のURL</CardTitle>
          <CardDescription>取り上げた1件を配信画面に出し続ける。取り上げるものはこのページで変える。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {overlayKey === null ? (
            <Alert variant="destructive">
              <AlertTitle>OBS用のURLを表示できません</AlertTitle>
              <AlertDescription>オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください</AlertDescription>
            </Alert>
          ) : (
            <>
              <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
              <p id={sizeHintId} className="text-sm text-muted-foreground">
                推奨の大きさ: {OVERLAY_SIZE.width} × {OVERLAY_SIZE.height} px（配信画面と同じ大きさ）
              </p>
              <div className="flex gap-2">
                {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
                <Input
                  id={urlFieldId}
                  type="password"
                  readOnly
                  autoComplete="off"
                  value={focusUrl(window.location.origin, overlayKey)}
                  aria-describedby={sizeHintId}
                />
                <Button type="button" disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
                  URLをコピー
                </Button>
              </div>

              <div className="flex items-center gap-3">
                {/* オーバーレイはアプリの外なので、router.tsx の Link ではなく普通の `<a>` で開く */}
                <a className={buttonVariants({ variant: 'outline' })} href={focusDemoUrl(window.location.origin)} target="_blank" rel="noreferrer">
                  デモを開く
                </a>
                <p className="text-sm text-muted-foreground">サンプルの発言で見た目と配置を確かめる。</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
