/**
 * チャットボットのページ
 *
 * botアカウントの接続状態を出し、接続・切断と、動作確認のためのテスト送信を行う。
 * ログインの確認はアプリの枠（src/app/app.tsx）が受け持つので、ここでは配信者がログイン済みであることを前提にする。
 * 画面の状態（接続状態・入力中の文言）はここで持ち、Workerの呼び出しは api.ts に任せる。
 *
 * 注意: 接続は通常のリンク（/api/auth/login?role=bot）で行う。Twitchの認可画面へ移動するため、
 * アプリ内の移動（Link）ではなく `<a>` を使う。
 * 注意: 失敗は黙って無視せず、理由を画面に出す（Fail-Fast）。状態を読めなかったときも未接続扱いにしない。
 */
import { useEffect, useId, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import type { BotApi, BotStatus, DeviceCode } from './api'

/** botの接続を始めるURL。Twitchの認可画面へ移動する */
const CONNECT_PATH = '/api/auth/login?role=bot'
/** Twitchが決めているチャット本文の上限（文字） */
const MAX_MESSAGE_LENGTH = 500
const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const wait = (seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * MILLISECONDS_PER_SECOND))

type Loaded = { status: 'loading' } | { status: 'ready'; bot: BotStatus | null } | { status: 'failed'; message: string }

export interface BotPageProps {
  api: BotApi
}

export const BotPage = ({ api }: BotPageProps) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // 別の端末での接続を待っている間に見せるコード。待っていなければ undefined
  const [deviceCode, setDeviceCode] = useState<DeviceCode>()
  // 画面を離れた後に問い合わせを続けないための目印
  const leftRef = useRef(false)
  const messageFieldId = useId()

  useEffect(() => {
    let cancelled = false
    api.status().then(
      (bot) => {
        if (!cancelled) setLoaded({ status: 'ready', bot })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(
    () => () => {
      leftRef.current = true
    },
    [],
  )

  if (loaded.status === 'loading') return <Skeleton className="h-48 w-full" aria-label="botの接続状態を読み込んでいます" />
  if (loaded.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle>読み込みに失敗しました</AlertTitle>
        <AlertDescription>botの接続状態を確認できません: {loaded.message}</AlertDescription>
      </Alert>
    )
  }

  const { bot } = loaded

  /** 操作を実行し、終わったら結果を知らせる。実行中はボタンを押せなくして二重の送信を防ぐ */
  const run = async (action: () => Promise<string>): Promise<void> => {
    setFailure('')
    setNotice('')
    setBusy(true)
    try {
      setNotice(await action())
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async (): Promise<string> => {
    await api.disconnect()
    setLoaded({ status: 'ready', bot: null })
    return 'botを切断しました'
  }

  /**
   * 別の端末での接続を始め、認可が済むまで問い合わせ続ける。
   *
   * 注意: 認可が済んでいないこと（pending）は失敗ではないので待ち続けるが、
   * 期限切れや拒否はエラーとして届くので、そのまま呼び出し元へ伝えてコードの表示をやめる。
   */
  const connectWithDeviceCode = async (): Promise<string> => {
    const issued = await api.startDeviceCode()
    setDeviceCode(issued)
    try {
      for (;;) {
        // 画面を離れたら問い合わせをやめる（戻ってきたときは、読み込み時の status で接続状態が分かる）
        if (leftRef.current) return ''
        const result = await api.pollDeviceCode(issued.deviceCode)
        if (result.status === 'connected') {
          setLoaded({ status: 'ready', bot: result.bot })
          return `botアカウント「${result.bot.login}」を接続しました`
        }
        await wait(issued.intervalSeconds)
      }
    } finally {
      setDeviceCode(undefined)
    }
  }

  const sendMessage = async (): Promise<string> => {
    // 空白だけの文言はTwitchも受け付けない。Workerへ送る前にここで止める
    if (message.trim() === '') throw new Error('送る文言を入力してください')
    await api.sendMessage(message)
    setMessage('')
    return 'チャットへ送信しました'
  }

  return (
    <div className="flex flex-col gap-6">
      {notice !== '' && (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {failure !== '' && (
        <Alert variant="destructive">
          <AlertTitle>うまくいきませんでした</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>接続しているアカウント</CardTitle>
          <CardDescription>
            チャットを読み書きするTwitchアカウントです。配信者とは別のアカウントを使えます。モデレーター権限は、Twitchのチャットから配信者が与えてください
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {bot === null ? (
            <>
              <p className="text-sm text-muted-foreground">botアカウントを接続していません。</p>
              <div className="flex flex-wrap gap-2">
                <a href={CONNECT_PATH} className={buttonVariants()}>
                  botアカウントを接続する
                </a>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void run(connectWithDeviceCode)}>
                  別の端末で接続する
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                「botアカウントを接続する」は、このブラウザのTwitchのログインをbotに切り替えてから押してください。切り替えたくない場合は「別の端末で接続する」を使うと、botでログイン済みのスマホなどでコードを入力するだけで済みます
              </p>
            </>
          ) : (
            <>
              <p className="text-sm">
                <span className="font-medium">{bot.login}</span>
                <span className="text-muted-foreground">（ユーザーID: {bot.userId}）</span>
              </p>
              {bot.missingScopes.length > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>権限が足りません</AlertTitle>
                  <AlertDescription>
                    このbotには {bot.missingScopes.join('・')} が認可されていません。接続し直してください
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex flex-wrap gap-2">
                <a href={CONNECT_PATH} className={buttonVariants({ variant: 'outline' })}>
                  別のアカウントで接続し直す
                </a>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void run(connectWithDeviceCode)}>
                  別の端末で接続する
                </Button>
                <Button type="button" variant="ghost" className="text-destructive" disabled={busy} onClick={() => setConfirming(true)}>
                  botを切断する
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {deviceCode !== undefined && (
        <Card>
          <CardHeader>
            <CardTitle>別の端末で認可してください</CardTitle>
            <CardDescription>
              botアカウントでログイン済みの端末（スマホなど）で下のリンクを開き、このコードを入力してください。認可が済むと、この画面が自動で切り替わります
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="font-mono text-3xl tracking-[0.3em] tabular-nums">{deviceCode.userCode}</p>
            <a
              href={deviceCode.verificationUri}
              target="_blank"
              rel="noreferrer"
              className={`${buttonVariants({ variant: 'outline' })} self-start`}
            >
              twitch.tv/activate を開く
            </a>
            <p className="text-xs text-muted-foreground">このコードは{Math.round(deviceCode.expiresIn / SECONDS_PER_MINUTE)}分で使えなくなります</p>
          </CardContent>
        </Card>
      )}

      {bot !== null && (
        <Card>
          <CardHeader>
            <CardTitle>テスト送信</CardTitle>
            <CardDescription>入力した文言を、いま接続しているbotの名前で配信チャンネルのチャットへ送ります</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={messageFieldId}>テスト送信する文言</Label>
              <Input
                id={messageFieldId}
                type="text"
                maxLength={MAX_MESSAGE_LENGTH}
                value={message}
                placeholder="配信を始めました"
                onChange={(event) => setMessage(event.currentTarget.value)}
                // IMEの変換確定のEnterで送信しないよう、変換中かどうかを確かめる。
                // 送信中のEnterも受け付けない（ボタンと違い、入力欄は押せなくならないため二重に送られてしまう）
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing && !busy) void run(sendMessage)
                }}
              />
            </div>
            <Button type="button" className="self-start" disabled={busy} onClick={() => void run(sendMessage)}>
              送信する
            </Button>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>botを切断しますか</AlertDialogTitle>
            <AlertDialogDescription>
              このWorkerが持っているbotのトークンを消します。チャットの送信は止まります。つなぎ直すには、もう一度Twitchで認可してください
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            {/* AlertDialogAction は押しても閉じないので、実行と合わせてここで閉じる */}
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void run(disconnect)
                setConfirming(false)
              }}
            >
              切断する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
