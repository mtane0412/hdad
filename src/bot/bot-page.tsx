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
import { Plus, Trash2 } from 'lucide-react'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ApiError } from '@/core/api'
import { Checkbox } from '@/components/ui/checkbox'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { BotApi, BotCommandItem, BotStatus, DeviceCode, ModerationRuleItem, ModerationSettings, PunishmentItem } from './api'
import {
  NEW_MODERATION_RULE,
  describeProblem,
  toCommandInput,
  toDraft,
  toModerationRuleDraft,
  toModerationRuleInput,
  type CommandDraft,
  type ModerationRuleDraft,
} from './form'
import { nextIntervalSeconds } from './poll'

/** botの接続を始めるURL。Twitchの認可画面へ移動する */
const CONNECT_PATH = '/api/auth/login?role=bot'
/** Twitchが決めているチャット本文の上限（文字） */
const MAX_MESSAGE_LENGTH = 500
const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
/** クールダウンの上限（秒）。Workerの検証と同じ値 */
const MAX_COOLDOWN_SECONDS = 60 * 60
/** タイムアウトの上限（秒）。Twitchの決まりで7日 */
const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 失敗の理由を、画面に出す行にする。設定の問題点があれば、1行ずつ並べる */
const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeProblem(problem)}`)]
    : [errorMessage(error)]

/** ルールの種類の選択肢。値は保存の形（api.ts の ModerationRuleItem）と同じ */
const RULE_KINDS: { value: ModerationRuleItem['kind']; label: string }[] = [
  { value: 'url', label: 'URLを含む' },
  { value: 'word', label: '禁止語を含む' },
  { value: 'repeat', label: '同じ文面の連投' },
]

/** 処分の選択肢。重い順ではなく、軽い順に並べる（選び間違いを減らすため） */
const PUNISHMENT_TYPES: { value: PunishmentItem['type']; label: string }[] = [
  { value: 'delete', label: '発言を削除' },
  { value: 'timeout', label: 'タイムアウト' },
  { value: 'ban', label: 'BAN' },
]

/** 自動モデレーションの除外のスイッチ。表示する順に並べる */
const EXEMPTIONS: { key: 'exemptBroadcaster' | 'exemptVip' | 'exemptSubscriber'; label: string }[] = [
  { key: 'exemptBroadcaster', label: '配信者とモデレーターを対象外にする' },
  { key: 'exemptVip', label: 'VIPを対象外にする' },
  { key: 'exemptSubscriber', label: 'サブスクライバーを対象外にする' },
]

/**
 * 選択欄の値を、ルールの種類・処分の種類に読み替える。
 *
 * 選択欄が返すのは文字列なので、選択肢に無い値は受け取らない（型を偽らずに絞り込むため）。
 * 選択肢は画面が作っているので、当てはまらないことは起きない。それでも起きたら、いちばん穏やかなものに倒す。
 */
const toRuleKind = (value: string): ModerationRuleDraft['kind'] => RULE_KINDS.find((kind) => kind.value === value)?.value ?? 'url'

const toPunishmentType = (value: string): ModerationRuleDraft['punishmentType'] =>
  PUNISHMENT_TYPES.find((punishment) => punishment.value === value)?.value ?? 'delete'

/** 保存済みの設定を、入力欄の値にする */
const toModerationDraft = (settings: ModerationSettings): ModerationDraft => ({
  enabled: settings.enabled,
  exemptBroadcaster: settings.exemptBroadcaster,
  exemptVip: settings.exemptVip,
  exemptSubscriber: settings.exemptSubscriber,
  rules: settings.rules.map(toModerationRuleDraft),
})

const wait = (seconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, seconds * MILLISECONDS_PER_SECOND))

type Loaded = { status: 'loading' } | { status: 'ready'; bot: BotStatus | null } | { status: 'failed'; message: string }

/** 自動モデレーションの入力欄が持つ値。ルールだけが文字列の下書きで、スイッチはそのまま真偽値で持つ */
interface ModerationDraft extends Omit<ModerationSettings, 'rules'> {
  rules: ModerationRuleDraft[]
}

/** 読み込む前に使う値。読み込みが終わるまで画面には出さない */
const EMPTY_MODERATION: ModerationDraft = { enabled: false, exemptBroadcaster: true, exemptVip: true, exemptSubscriber: true, rules: [] }

interface CommandRowProps {
  position: number
  draft: CommandDraft
  /** 保存を待っている間は操作させない（保存の応答で入力中の値が消えてしまうため） */
  disabled: boolean
  onChange(draft: CommandDraft): void
  onRemove(): void
}

/**
 * コマンド1件ぶんの行。
 *
 * 表の中に入力欄を置くため、見出しは列（TableHead）が受け持ち、各欄の名前は aria-label で与える。
 * 見出しだけでは「何番目の行か」が分からないので、ラベルには位置を含める。
 */
const CommandRow = ({ position, draft, disabled, onChange, onRemove }: CommandRowProps) => {
  const update = (patch: Partial<CommandDraft>): void => onChange({ ...draft, ...patch })

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-1">
          <span aria-hidden="true" className="text-muted-foreground">
            !
          </span>
          <Input
            type="text"
            aria-label={`${position}番目のコマンド名`}
            value={draft.name}
            placeholder="discord"
            disabled={disabled}
            onChange={(event) => update({ name: event.currentTarget.value })}
          />
        </div>
      </TableCell>
      <TableCell>
        <Input
          type="text"
          aria-label={`${position}番目の応答文`}
          maxLength={MAX_MESSAGE_LENGTH}
          value={draft.reply}
          placeholder="@{user} こんばんは"
          disabled={disabled}
          onChange={(event) => update({ reply: event.currentTarget.value })}
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          aria-label={`${position}番目のクールダウン（秒）`}
          className="w-24"
          min={0}
          max={MAX_COOLDOWN_SECONDS}
          value={draft.cooldownSeconds}
          disabled={disabled}
          onChange={(event) => update({ cooldownSeconds: event.currentTarget.value })}
        />
      </TableCell>
      <TableCell>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`${position}番目のコマンドを外す`}
          className="text-destructive"
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </TableCell>
    </TableRow>
  )
}

interface ModerationRuleRowProps {
  position: number
  draft: ModerationRuleDraft
  /** 保存を待っている間は操作させない（保存の応答で入力中の値が消えてしまうため） */
  disabled: boolean
  onChange(draft: ModerationRuleDraft): void
  onRemove(): void
}

/**
 * 自動モデレーションのルール1件ぶんの行。
 *
 * コマンドの行と同じく、見出しは列（TableHead）が受け持ち、各欄の名前は位置を含む aria-label で与える。
 * 条件の欄は種類によって中身が変わる（URLは入力する値が無いので、何を見るかを文で添える）。
 */
const ModerationRuleRow = ({ position, draft, disabled, onChange, onRemove }: ModerationRuleRowProps) => {
  const update = (patch: Partial<ModerationRuleDraft>): void => onChange({ ...draft, ...patch })

  return (
    <TableRow>
      <TableCell>
        <NativeSelect
          className="w-full"
          aria-label={`${position}番目のルールの種類`}
          value={draft.kind}
          disabled={disabled}
          onChange={(event) => update({ kind: toRuleKind(event.currentTarget.value) })}
        >
          {RULE_KINDS.map((kind) => (
            <NativeSelectOption key={kind.value} value={kind.value}>
              {kind.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </TableCell>
      <TableCell>
        {draft.kind === 'word' && (
          <Input
            type="text"
            aria-label={`${position}番目の禁止語`}
            value={draft.word}
            placeholder="宣伝"
            disabled={disabled}
            onChange={(event) => update({ word: event.currentTarget.value })}
          />
        )}
        {draft.kind === 'repeat' && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              aria-label={`${position}番目の連投とみなす回数`}
              className="w-20"
              min={2}
              max={10}
              value={draft.count}
              disabled={disabled}
              onChange={(event) => update({ count: event.currentTarget.value })}
            />
            <span className="text-sm text-muted-foreground">回を</span>
            <Input
              type="number"
              aria-label={`${position}番目の連投を数える時間（秒）`}
              className="w-24"
              min={10}
              max={600}
              value={draft.windowSeconds}
              disabled={disabled}
              onChange={(event) => update({ windowSeconds: event.currentTarget.value })}
            />
            <span className="text-sm text-muted-foreground">秒のあいだに</span>
          </div>
        )}
        {draft.kind === 'url' && <p className="text-sm text-muted-foreground">URLを含む発言が対象です</p>}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label={`${position}番目の処分`}
            value={draft.punishmentType}
            disabled={disabled}
            onChange={(event) => update({ punishmentType: toPunishmentType(event.currentTarget.value) })}
          >
            {PUNISHMENT_TYPES.map((punishment) => (
              <NativeSelectOption key={punishment.value} value={punishment.value}>
                {punishment.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {draft.punishmentType === 'timeout' && (
            <Input
              type="number"
              aria-label={`${position}番目のタイムアウトの長さ（秒）`}
              className="w-24"
              min={1}
              max={MAX_TIMEOUT_SECONDS}
              value={draft.durationSeconds}
              disabled={disabled}
              onChange={(event) => update({ durationSeconds: event.currentTarget.value })}
            />
          )}
        </div>
      </TableCell>
      <TableCell>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`${position}番目のルールを外す`}
          className="text-destructive"
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </TableCell>
    </TableRow>
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
  // 最後に保存（または読み込み）した内容。いまの入力と比べて、保存するものがあるかを決める
  const [savedDrafts, setSavedDrafts] = useState<readonly CommandDraft[]>([])
  const [moderation, setModeration] = useState<ModerationDraft>(EMPTY_MODERATION)
  // 最後に保存（または読み込み）した自動モデレーションの設定。いまの入力と比べて、保存するものがあるかを決める
  const [savedModeration, setSavedModeration] = useState<ModerationDraft>(EMPTY_MODERATION)
  // 画面を離れた後に問い合わせを続けないための目印
  const leftRef = useRef(false)
  const messageFieldId = useId()
  const moderationFieldId = useId()

  useEffect(() => {
    let cancelled = false
    // コマンドと自動モデレーションの設定も一緒に読む。1つでも読めなければ、黙って空の設定にせず理由を出す
    Promise.all([api.status(), api.commands(), api.moderation()]).then(
      ([bot, commands, moderationSettings]) => {
        if (cancelled) return
        const loadedDrafts = commands.map(toDraft)
        setDrafts(loadedDrafts)
        setSavedDrafts(loadedDrafts)
        const loadedModeration = toModerationDraft(moderationSettings)
        setModeration(loadedModeration)
        setSavedModeration(loadedModeration)
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
  /** 保存していない変更があるか。入力の中身をそのまま見比べる（件数も並び順も含めて確かめたいため） */
  const dirty = JSON.stringify(drafts) !== JSON.stringify(savedDrafts)
  /** 自動モデレーションに、保存していない変更があるか */
  const moderationDirty = JSON.stringify(moderation) !== JSON.stringify(savedModeration)

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
    const saved = (await api.saveCommands(inputs)).map(toDraft)
    setDrafts(saved)
    setSavedDrafts(saved)
    return `コマンドを${inputs.length}件保存しました`
  }

  const addModerationRule = async (): Promise<string> => {
    setModeration({ ...moderation, rules: [...moderation.rules, NEW_MODERATION_RULE] })
    return 'ルールを足しました。保存するまで反映されません'
  }

  const saveModeration = async (): Promise<string> => {
    const rules: ModerationRuleItem[] = moderation.rules.map((draft, index) => {
      try {
        return toModerationRuleInput(draft)
      } catch (error) {
        throw new Error(`${index + 1}番目のルール: ${errorMessage(error)}`, { cause: error })
      }
    })
    const saved = toModerationDraft(await api.saveModeration({ ...moderation, rules }))
    setModeration(saved)
    setSavedModeration(saved)
    return '自動モデレーションの設定を保存しました'
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
          <CardDescription>チャットを読み書きするTwitchアカウント。配信者とは別のアカウントを使えます</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {bot === null ? (
            <>
              <p className="text-sm text-muted-foreground">botアカウントを接続していません。</p>
              <div className="flex flex-wrap gap-2">
                <a href={CONNECT_PATH} className={buttonVariants()}>
                  接続する
                </a>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void run(connectWithDeviceCode)}>
                  別の端末で接続する
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                「接続する」は、このブラウザのTwitchのログインをbotに切り替えてから押してください。切り替えたくないときは「別の端末で接続する」を使います
              </p>
            </>
          ) : (
            <>
              <p className="text-sm">
                <span className="font-medium">{bot.login}</span>
                <span className="text-muted-foreground">（ユーザーID: {bot.userId}）</span>
              </p>
              {!bot.isModerator && (
                <Alert variant="destructive">
                  <AlertTitle>モデレーター権限がありません</AlertTitle>
                  <AlertDescription>
                    配信者がTwitchのチャットで <code>/mod {bot.login}</code>{' '}
                    を実行してください。それまでBAN・タイムアウト・発言の削除・アナウンスは使えません
                  </AlertDescription>
                </Alert>
              )}
              {bot.missingScopes.length > 0 && (
                <Alert variant="destructive">
                  <AlertTitle>権限が足りません</AlertTitle>
                  <AlertDescription>{bot.missingScopes.join('・')} が認可されていません。接続し直してください</AlertDescription>
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
            <CardDescription>botでログイン済みの端末で下のリンクを開き、このコードを入力してください</CardDescription>
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
          <CardDescription>チャットで「!コマンド名」と打たれたときに、botが送り返す文言</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-4">
          {drafts.length > 0 && (
            <Table aria-label="コマンドの一覧">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-48">コマンド</TableHead>
                  <TableHead>応答文</TableHead>
                  <TableHead className="w-32">クールダウン（秒）</TableHead>
                  {/* 行を外すボタンの列。見出しの文言は要らないが、列の名前は読み上げのために置く */}
                  <TableHead className="w-12">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drafts.map((draft, index) => (
                  <CommandRow
                    // 入力中は名前が空だったり重複したりするので、並び順を鍵にする
                    key={index}
                    position={index + 1}
                    draft={draft}
                    disabled={busy}
                    onChange={(next) => setDrafts(drafts.map((current, at) => (at === index ? next : current)))}
                    onRemove={() => setDrafts(drafts.filter((_, at) => at !== index))}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="icon" aria-label="コマンドを足す" disabled={busy} onClick={() => void run(addCommand)}>
              <Plus aria-hidden="true" />
            </Button>
            {/* 保存するものが無いときにボタンを出さない。変更したときだけ出す */}
            {dirty && (
              <Button type="button" disabled={busy} onClick={() => void run(saveCommands)}>
                コマンドを保存する
              </Button>
            )}
          </div>
          {drafts.length > 0 && (
            <p className="text-xs text-muted-foreground">
              応答文の {'{user}'} は発言した人の名前に、{'{summary}'} は配信の「これまでのあらすじ」に置き換わります
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>自動モデレーション</CardTitle>
          <CardDescription>
            ルールに当てはまる発言を、botが自動で削除・タイムアウト・BANします（TwitchのAutoModとは別のしくみ）
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-4">
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${moderationFieldId}-enabled`}
              checked={moderation.enabled}
              disabled={busy}
              onCheckedChange={(checked) => setModeration({ ...moderation, enabled: checked === true })}
            />
            <Label htmlFor={`${moderationFieldId}-enabled`}>自動モデレーションを有効にする</Label>
          </div>
          <div className="flex flex-col gap-2">
            {EXEMPTIONS.map((exemption) => (
              <div key={exemption.key} className="flex items-center gap-2">
                <Checkbox
                  id={`${moderationFieldId}-${exemption.key}`}
                  checked={moderation[exemption.key]}
                  disabled={busy}
                  onCheckedChange={(checked) => setModeration({ ...moderation, [exemption.key]: checked === true })}
                />
                <Label htmlFor={`${moderationFieldId}-${exemption.key}`}>{exemption.label}</Label>
              </div>
            ))}
          </div>
          {/* 配信者とモデレーターへの処分はTwitch自身が断るので、除外を切ると失敗が積み上がるだけになる */}
          <p className="text-xs text-muted-foreground">
            Twitchはモデレーターへの処分を受け付けないので、「配信者とモデレーターを対象外にする」は切らないことをおすすめします
          </p>

          {moderation.rules.length > 0 && (
            <Table aria-label="自動モデレーションのルールの一覧">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">種類</TableHead>
                  <TableHead>条件</TableHead>
                  <TableHead className="w-64">処分</TableHead>
                  {/* 行を外すボタンの列。見出しの文言は要らないが、列の名前は読み上げのために置く */}
                  <TableHead className="w-12">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {moderation.rules.map((draft, index) => (
                  <ModerationRuleRow
                    // 入力中は中身が重なることがあるので、並び順を鍵にする
                    key={index}
                    position={index + 1}
                    draft={draft}
                    disabled={busy}
                    onChange={(next) => setModeration({ ...moderation, rules: moderation.rules.map((current, at) => (at === index ? next : current)) })}
                    onRemove={() => setModeration({ ...moderation, rules: moderation.rules.filter((_, at) => at !== index) })}
                  />
                ))}
              </TableBody>
            </Table>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="icon" aria-label="ルールを足す" disabled={busy} onClick={() => void run(addModerationRule)}>
              <Plus aria-hidden="true" />
            </Button>
            {/* 保存するものが無いときにボタンを出さない。変更したときだけ出す */}
            {moderationDirty && (
              <Button type="button" disabled={busy} onClick={() => void run(saveModeration)}>
                自動モデレーションを保存する
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {bot !== null && (
        <Card>
          <CardHeader>
            <CardTitle>テスト送信</CardTitle>
            <CardDescription>入力した文言を、botの名前でチャットへ送ります</CardDescription>
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
