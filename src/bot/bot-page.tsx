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
import { ApiError } from '@/core/api'
import type { BotApi, BotCommandItem, BotStatus, DeviceCode } from './api'
import { describeProblem, toCommandInput, toDraft, type CommandDraft } from './form'
import { nextIntervalSeconds } from './poll'

/** botの接続を始めるURL。Twitchの認可画面へ移動する */
const CONNECT_PATH = '/api/auth/login?role=bot'
/** Twitchが決めているチャット本文の上限（文字） */
const MAX_MESSAGE_LENGTH = 500
const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
/** クールダウンの上限（秒）。Workerの検証と同じ値 */
const MAX_COOLDOWN_SECONDS = 60 * 60

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 失敗の理由を、画面に出す行にする。設定の問題点があれば、1行ずつ並べる */
const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['コマンドの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeProblem(problem)}`)]
    : [errorMessage(error)]

const wait = (seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * MILLISECONDS_PER_SECOND))

type Loaded = { status: 'loading' } | { status: 'ready'; bot: BotStatus | null } | { status: 'failed'; message: string }

interface CommandRowProps {
  position: number
  draft: CommandDraft
  onChange(draft: CommandDraft): void
  onRemove(): void
}

const CommandRow = ({ position, draft, onChange, onRemove }: CommandRowProps) => {
  const id = useId()
  const update = (patch: Partial<CommandDraft>): void => onChange({ ...draft, ...patch })

  return (
    <li aria-label={`${position}番目のコマンド`} className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-name`}>{position}番目のコマンド名</Label>
        <Input id={`${id}-name`} type="text" value={draft.name} placeholder="discord" onChange={(event) => update({ name: event.currentTarget.value })} />
        <p className="text-xs text-muted-foreground">チャットでは「!{draft.name === '' ? 'コマンド名' : draft.name}」と入力します</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-cooldown`}>{position}番目のクールダウン（秒）</Label>
        <Input
          id={`${id}-cooldown`}
          type="number"
          min={0}
          max={MAX_COOLDOWN_SECONDS}
          value={draft.cooldownSeconds}
          onChange={(event) => update({ cooldownSeconds: event.currentTarget.value })}
        />
        <p className="text-xs text-muted-foreground">この秒数のあいだは、続けて打たれても応答しません（0なら毎回応答）</p>
      </div>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Label htmlFor={`${id}-reply`}>{position}番目の応答文</Label>
        <Input
          id={`${id}-reply`}
          type="text"
          maxLength={MAX_MESSAGE_LENGTH}
          value={draft.reply}
          placeholder="@{user} こんばんは"
          onChange={(event) => update({ reply: event.currentTarget.value })}
        />
        <p className="text-xs text-muted-foreground">使える差し込み語: {'{user}'}（発言した人のログイン名）</p>
      </div>
      <Button type="button" variant="ghost" size="sm" className="justify-self-start text-destructive" onClick={onRemove}>
        {position}番目のコマンドを外す
      </Button>
    </li>
  )
}

export interface BotPageProps {
  api: BotApi
}

export const BotPage = ({ api }: BotPageProps) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // 別の端末での接続を待っている間に見せるコード。待っていなければ undefined
  const [deviceCode, setDeviceCode] = useState<DeviceCode>()
  const [drafts, setDrafts] = useState<readonly CommandDraft[]>([])
  // 画面を離れた後に問い合わせを続けないための目印
  const leftRef = useRef(false)
  const messageFieldId = useId()

  useEffect(() => {
    let cancelled = false
    // コマンドの一覧も一緒に読む。片方でも読めなければ、黙って空の一覧にせず理由を出す
    Promise.all([api.status(), api.commands()]).then(
      ([bot, commands]) => {
        if (cancelled) return
        setDrafts(commands.map(toDraft))
        setLoaded({ status: 'ready', bot })
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
    setFailure([])
    setNotice('')
    setBusy(true)
    try {
      setNotice(await action())
    } catch (error) {
      setFailure(failureLines(error))
    } finally {
      setBusy(false)
    }
  }

  const addCommand = async (): Promise<string> => {
    setDrafts([...drafts, { name: '', reply: '', cooldownSeconds: '0' }])
    return 'コマンドを足しました。保存するまで反映されません'
  }

  const saveCommands = async (): Promise<string> => {
    const inputs: BotCommandItem[] = drafts.map((draft, index) => {
      try {
        return toCommandInput(draft)
      } catch (error) {
        throw new Error(`${index + 1}番目のコマンド: ${errorMessage(error)}`, { cause: error })
      }
    })
    setDrafts((await api.saveCommands(inputs)).map(toDraft))
    return `コマンドを${inputs.length}件保存しました`
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
    let intervalSeconds = issued.intervalSeconds
    try {
      for (;;) {
        // 画面を離れたら問い合わせをやめる（戻ってきたときは、読み込み時の status で接続状態が分かる）
        if (leftRef.current) return ''
        const result = await api.pollDeviceCode(issued.deviceCode)
        if (result.status === 'connected') {
          setLoaded({ status: 'ready', bot: result.bot })
          return `botアカウント「${result.bot.login}」を接続しました`
        }
        // 速すぎると言われた場合は、次からの間隔を延ばす
        intervalSeconds = nextIntervalSeconds(intervalSeconds, result)
        await wait(intervalSeconds)
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
      {failure.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>うまくいきませんでした</AlertTitle>
          <AlertDescription>
            {failure.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </AlertDescription>
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

      <Card>
        <CardHeader>
          <CardTitle>コマンド</CardTitle>
          <CardDescription>
            チャットで「!コマンド名」と打たれたときに、botが送り返す文言です。登録するまでは何にも応答しません
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">コマンドを1つも登録していません。</p>
          ) : (
            <ul aria-label="コマンドの一覧" className="flex flex-col gap-4">
              {drafts.map((draft, index) => (
                <CommandRow
                  // 入力中は名前が空だったり重複したりするので、並び順を鍵にする
                  key={index}
                  position={index + 1}
                  draft={draft}
                  onChange={(next) => setDrafts(drafts.map((current, at) => (at === index ? next : current)))}
                  onRemove={() => setDrafts(drafts.filter((_, at) => at !== index))}
                />
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={() => void run(addCommand)}>
              コマンドを足す
            </Button>
            <Button type="button" disabled={busy} onClick={() => void run(saveCommands)}>
              コマンドを保存する
            </Button>
          </div>
        </CardContent>
      </Card>

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
