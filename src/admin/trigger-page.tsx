/**
 * トリガーのページ
 *
 * OBS用のURLと、「どのイベントで何をするか」（トリガー）の操作盤を出す。素材の追加と削除はアップロードのページ
 * （media-page.tsx）が受け持ち、ここでは置いてある素材から選ぶだけにする。ログインの確認とログアウトは
 * アプリの枠（src/app/app.tsx）が受け持つので、ここではログイン済みを前提にする。
 * 画面の状態（素材・報酬・入力中のトリガー）はここで持ち、Workerの呼び出しは api.ts、入力欄の値の変換は form.ts、
 * 操作の実行と結果の表示は page-actions.tsx に任せる。
 *
 * 注意: 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。
 * 素材や保存済みの設定を取得できなければ操作盤を出さない。報酬の一覧とbotの接続状態だけ取得できないときは、操作盤は出したまま理由を出す。
 */
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Slider } from '@/components/ui/slider'
import { Link } from '@/app/router'
import type { BotApi, BotStatus } from '@/bot/api'
import { ApiError } from '@/core/api'
import {
  isAlertEvent,
  isAnnouncementColor,
  type AdminApi,
  type AlertEvent,
  type AnnouncementColor,
  type ConditionKind,
  type MediaItem,
  type Reward,
  type TriggerCondition,
} from './api'
import {
  addableConditionKinds,
  changeEvent,
  colorOptions,
  conditionLabel,
  createCondition,
  describeProblem,
  eventOptions,
  kindLabels,
  overlayUrl,
  placeholdersFor,
  rewardOptions,
  toDraft,
  toTriggerInput,
  triggerSummary,
  type ConditionKindOption,
  type SelectOption,
  type TriggerDraft,
} from './form'
import { errorMessage, usePageActions } from './page-actions'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const CHAT_MESSAGE = 'channel.chat.message'
/** 文言欄の入力例。イベント種別ごとに、使える差し込み語だけを使った例を出す */
const MESSAGE_PLACEHOLDERS: Readonly<Record<AlertEvent, string>> = {
  [REDEMPTION]: '{user} さんが「{reward}」を交換しました',
  'channel.follow': '{user} さんがフォローしました',
  'channel.subscribe': '{user} さんがティア{tier}でサブスクしました',
  'channel.subscription.message': '{user} さんが{months}か月目のサブスク（ティア{tier}）',
  'channel.raid': '{user} さんが{viewers}人でレイドしました',
  [CHAT_MESSAGE]: '{user} さんが「{message}」と言いました',
}
const MIN_DURATION_SECONDS = 1
const MAX_DURATION_SECONDS = 60
const MAX_VOLUME_PERCENT = 100
const MAX_MESSAGE_LENGTH = 200
/** Twitchのユーザー名（login）の上限。Workerの検証と同じ値 */
const MAX_LOGIN_LENGTH = 25
/** チャットに送る文言の上限（Twitchのチャット1通の上限） */
const MAX_CHAT_MESSAGE_LENGTH = 500
const DEFAULT_DURATION_SECONDS = '5'
const DEFAULT_VOLUME_PERCENT = '100'
/** 新しく足したトリガーのアナウンスの色（チャンネルの色） */
const DEFAULT_ANNOUNCEMENT_COLOR: AnnouncementColor = 'primary'

/** 失敗の理由を、画面に出す行にする。設定の問題点があれば、1行ずつ並べる */
const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['トリガーの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${describeProblem(problem)}`)]
    : [errorMessage(error)]

const Select = ({ id, options, value, onChange }: { id: string; options: readonly SelectOption[]; value: string; onChange(value: string): void }) => (
  <NativeSelect id={id} className="w-full" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
    {options.map((option) => (
      <NativeSelectOption key={option.value} value={option.value}>
        {option.label}
      </NativeSelectOption>
    ))}
  </NativeSelect>
)

interface ConditionFieldsProps {
  /** 入力欄のIDの前置き。1つの行の中で条件ごとに違うIDにする */
  idPrefix: string
  conditions: readonly TriggerCondition[]
  rewards: readonly Reward[]
  /** 足せる条件の種類（すでに足してある種類と、このイベントに付けられない種類は含まれない） */
  addable: readonly ConditionKindOption[]
  onChange(index: number, condition: TriggerCondition): void
  onAdd(kind: ConditionKind): void
  onRemove(index: number): void
}

/**
 * 条件の一覧の入力欄。
 *
 * 条件はすべてを満たしたときだけ当てはまる（and）ので、その旨を見出しに書く。
 * 条件が1件もないときは、そのイベントが起きればいつでも動くことを知らせる（設定漏れと取り違えないため）。
 * 足せる種類は種類ごとのボタンで出す（そのイベントに付けられる種類は多くても2つなので、選択欄と「足す」ボタンに分けるより手数が少ない）。
 * 入力欄は種類ごとに違うので、種類で分けて出す（文面は部分一致の文字列、ユーザーはTwitchのユーザー名、報酬は選択欄）。
 */
const ConditionFields = ({ idPrefix, conditions, rewards, addable, onChange, onAdd, onRemove }: ConditionFieldsProps) => (
  <div className="flex flex-col gap-3 rounded-md border border-dashed p-3 sm:col-span-2">
    <span className="text-sm leading-none font-medium">条件（すべてを満たしたときだけ動く）</span>
    {conditions.length === 0 ? (
      <p className="text-xs text-muted-foreground">条件がないので、このイベントが起きればいつでも動きます。</p>
    ) : (
      <ul className="flex flex-col gap-3">
        {conditions.map((condition, index) => (
          // 同じ種類の条件は1件までなので、種類をキーにできる
          <li key={condition.kind} className="flex items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {/* 入れる値を持つ条件だけがラベルの行き先（入力欄）を持つ。持たない条件は、行き先のないラベルにせず見出しとして出す */}
              {condition.kind === 'firstChatOfStream' ? (
                <span className="text-sm leading-none font-medium">{conditionLabel(condition.kind)}</span>
              ) : (
                <Label htmlFor={`${idPrefix}-${condition.kind}`}>{conditionLabel(condition.kind)}</Label>
              )}
              {condition.kind === 'firstChatOfStream' && (
                <p className="text-xs text-muted-foreground">
                  配信中の発言だけが対象です。配信していないあいだの発言では動きません（テスト配信のたびに動かないようにするため）。
                </p>
              )}
              {condition.kind === 'reward' && (
                <Select
                  id={`${idPrefix}-reward`}
                  options={rewardOptions(rewards, condition.rewardId)}
                  value={condition.rewardId}
                  onChange={(rewardId) => onChange(index, { kind: 'reward', rewardId })}
                />
              )}
              {condition.kind === 'user' && (
                <Input
                  id={`${idPrefix}-user`}
                  type="text"
                  maxLength={MAX_LOGIN_LENGTH}
                  value={condition.login}
                  placeholder="tanenobu"
                  onChange={(event) => onChange(index, { kind: 'user', login: event.currentTarget.value })}
                />
              )}
              {/* 文面は発言に含まれていればよい（部分一致）。大文字小文字は区別しない */}
              {condition.kind === 'text' && (
                <Input
                  id={`${idPrefix}-text`}
                  type="text"
                  maxLength={MAX_CHAT_MESSAGE_LENGTH}
                  value={condition.contains}
                  placeholder="おはよう"
                  onChange={(event) => onChange(index, { kind: 'text', contains: event.currentTarget.value })}
                />
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`${conditionLabel(condition.kind)}の条件を外す`}
              className="text-destructive"
              onClick={() => onRemove(index)}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    )}
    {addable.length > 0 && (
      <div className="flex flex-wrap gap-2">
        {addable.map((option) => (
          <Button key={option.value} type="button" variant="outline" size="sm" onClick={() => onAdd(option.value)}>
            <Plus aria-hidden="true" />
            {option.label}の条件を足す
          </Button>
        ))}
      </div>
    )}
  </div>
)

interface TriggerRowProps {
  position: number
  draft: TriggerDraft
  media: readonly MediaItem[]
  rewards: readonly Reward[]
  /** 入力欄を開いているか。開くのは1件ずつなので、どれを開くかは一覧を持つページが決める */
  open: boolean
  onToggle(): void
  onChange(draft: TriggerDraft): void
  onRemove(): void
}

/**
 * トリガー1件ぶんの行。
 *
 * 項目が多いので、ふだんは要約だけを見出しに出して折りたたみ、見出しを押したときだけ入力欄を開く。
 * 見出しの読み上げでは要約だけでは何番目か分からないため、位置を見えない文字で添える。
 */
const TriggerRow = ({ position, draft, media, rewards, open, onToggle, onChange, onRemove }: TriggerRowProps) => {
  const id = useId()
  const update = (patch: Partial<TriggerDraft>): void => onChange({ ...draft, ...patch })
  const mediaOptions = media.map((item) => ({ value: item.id, label: `${item.name}（${kindLabels[item.kind]}）` }))

  return (
    <li aria-label={`${position}番目のトリガー`} className="rounded-lg border">
      <div className="flex items-center gap-1 p-2">
        <Button
          type="button"
          variant="ghost"
          className="min-w-0 flex-1 justify-start gap-2 font-normal"
          aria-expanded={open}
          aria-controls={`${id}-detail`}
          onClick={onToggle}
        >
          <ChevronDown aria-hidden="true" className={open ? 'rotate-180' : ''} />
          <span className="sr-only">{position}番目のトリガー:</span>
          <span className="truncate">{triggerSummary(draft, rewards)}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`${position}番目のトリガーを外す`}
          className="text-destructive"
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      {open && (
        <div id={`${id}-detail`} className="grid gap-4 border-t p-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-event`}>イベント</Label>
            {/* 選択肢はイベント種別だけなので isAlertEvent は必ず通る。型を絞るための確認 */}
            <Select
              id={`${id}-event`}
              options={eventOptions}
              value={draft.event}
              onChange={(event) => isAlertEvent(event) && onChange(changeEvent(draft, event))}
            />
          </div>

          {/* ここから下は、このトリガーが当てはまる条件。すべてを満たしたときだけ動く */}
          <ConditionFields
            idPrefix={`${id}-condition`}
            conditions={draft.conditions}
            rewards={rewards}
            addable={addableConditionKinds(draft)}
            onChange={(index, condition) => update({ conditions: draft.conditions.map((other, position) => (position === index ? condition : other)) })}
            onAdd={(kind) => update({ conditions: [...draft.conditions, createCondition(kind, rewards)] })}
            onRemove={(index) => update({ conditions: draft.conditions.filter((_, position) => position !== index) })}
          />

          {/* ここから下は、このイベントのときに行う動作。種類ごとに実行者が違う（アラートはオーバーレイ、チャットはWorker） */}
          <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-alert-enabled`}
                checked={draft.alertEnabled}
                // 素材が未選択のまま出すことにすると、選択欄には最初の素材が見えているのに保存時に拒まれる。
                // そこで、出すことにした時点で選択欄が見せているとおりの素材（先頭）を選んでおく
                onCheckedChange={(checked) =>
                  update(checked === true ? { alertEnabled: true, mediaId: draft.mediaId === '' ? (media[0]?.id ?? '') : draft.mediaId } : { alertEnabled: false })
                }
              />
              <Label htmlFor={`${id}-alert-enabled`}>アラートを出す</Label>
            </div>
            {draft.alertEnabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-media`}>素材</Label>
                  <Select id={`${id}-media`} options={mediaOptions} value={draft.mediaId} onChange={(mediaId) => update({ mediaId })} />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-duration`}>表示時間（1〜60秒）</Label>
                  <Input
                    id={`${id}-duration`}
                    type="number"
                    min={MIN_DURATION_SECONDS}
                    max={MAX_DURATION_SECONDS}
                    value={draft.durationSeconds}
                    onChange={(event) => update({ durationSeconds: event.currentTarget.value })}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <span id={`${id}-volume`} className="text-sm leading-none font-medium">
                    音量
                  </span>
                  <div className="flex h-8 items-center gap-3">
                    <Slider
                      aria-labelledby={`${id}-volume`}
                      min={0}
                      max={MAX_VOLUME_PERCENT}
                      value={[Number(draft.volumePercent)]}
                      onValueChange={(next) => update({ volumePercent: String(Array.isArray(next) ? next[0] : next) })}
                    />
                    <output className="w-12 text-right font-mono text-xs tabular-nums">{draft.volumePercent}%</output>
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:col-span-2">
                  <Label htmlFor={`${id}-message`}>文言（空欄なら出さない）</Label>
                  <Input
                    id={`${id}-message`}
                    type="text"
                    maxLength={MAX_MESSAGE_LENGTH}
                    value={draft.message}
                    placeholder={MESSAGE_PLACEHOLDERS[draft.event]}
                    onChange={(event) => update({ message: event.currentTarget.value })}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Checkbox id={`${id}-chat-enabled`} checked={draft.chatEnabled} onCheckedChange={(checked) => update({ chatEnabled: checked === true })} />
              <Label htmlFor={`${id}-chat-enabled`}>チャットに送る</Label>
            </div>
            {draft.chatEnabled && (
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-chat-message`}>チャットに送る文言</Label>
                <Input
                  id={`${id}-chat-message`}
                  type="text"
                  maxLength={MAX_CHAT_MESSAGE_LENGTH}
                  value={draft.chatMessage}
                  placeholder={MESSAGE_PLACEHOLDERS[draft.event]}
                  onChange={(event) => update({ chatMessage: event.currentTarget.value })}
                />
                {/* 送るのは接続しているbotアカウント。未接続だと何も送られないので、どこで接続するかを添える */}
                <p className="text-xs text-muted-foreground">接続しているbotアカウントが送ります（チャットボットのページで接続します）。</p>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-4 rounded-md border border-dashed p-3 sm:col-span-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-announce-enabled`}
                checked={draft.announceEnabled}
                onCheckedChange={(checked) => update({ announceEnabled: checked === true })}
              />
              <Label htmlFor={`${id}-announce-enabled`}>アナウンスを送る</Label>
            </div>
            {draft.announceEnabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2 sm:col-span-2">
                  <Label htmlFor={`${id}-announce-message`}>アナウンスの文言</Label>
                  <Input
                    id={`${id}-announce-message`}
                    type="text"
                    maxLength={MAX_CHAT_MESSAGE_LENGTH}
                    value={draft.announceMessage}
                    placeholder={MESSAGE_PLACEHOLDERS[draft.event]}
                    onChange={(event) => update({ announceMessage: event.currentTarget.value })}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={`${id}-announce-color`}>アナウンスの色</Label>
                  {/* 選択肢は色だけなので isAnnouncementColor は必ず通る。型を絞るための確認 */}
                  <Select
                    id={`${id}-announce-color`}
                    options={colorOptions}
                    value={draft.announceColor}
                    onChange={(color) => isAnnouncementColor(color) && update({ announceColor: color })}
                  />
                </div>
                {/* アナウンスは普通の発言と違い、botがモデレーターでないとTwitchに拒否される */}
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  接続しているbotアカウントが、モデレーターとして送ります（チャットボットのページで接続し、配信者がモデレーター権限を与えてください）。
                </p>
              </div>
            )}
          </div>

          {/* 選んだイベントに存在しない語は置き換わらないため、使える語をその場で知らせる（アラートとチャットで同じ語を使う） */}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            このイベントで使える差し込み語: {placeholdersFor(draft.event).join('・')}
          </p>
        </div>
      )}
    </li>
  )
}

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

/** botの接続状態の読み出し。loaded で bot が null なら未接続 */
type BotConnection = { status: 'checking' } | { status: 'loaded'; bot: BotStatus | null } | { status: 'failed'; message: string }

export interface TriggerPageProps {
  api: AdminApi
  /** botの接続状態の読み出し。未接続ならチャットとアナウンスの動作が動かないので、画面で知らせる */
  botApi: Pick<BotApi, 'status'>
  /** ログイン中の配信者のオーバーレイ用キー。発行されていなければ null */
  overlayKey: string | null
  /** キーを再発行した。アプリの枠が持つログイン情報を新しいキーに書き換えてもらう */
  onOverlayKeyChange(overlayKey: string): void
}

export const TriggerPage = ({ api, botApi, overlayKey, onOverlayKeyChange }: TriggerPageProps) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [media, setMedia] = useState<readonly MediaItem[]>([])
  const [rewards, setRewards] = useState<readonly Reward[]>([])
  const [drafts, setDrafts] = useState<readonly TriggerDraft[]>([])
  // 入力欄を開いているトリガーの位置（0始まり）。項目が多いので、開くのは1件ずつにする
  const [openPosition, setOpenPosition] = useState<number | null>(null)
  // 報酬の一覧を取得できなかった理由。操作の失敗（failure）と分けて持ち、ほかの操作が成功しても消さない
  const [rewardsFailure, setRewardsFailure] = useState('')
  // botの接続状態。取得できていないあいだと、取得に失敗したときは知らせを出さない（未接続と取り違えないため）
  const [bot, setBot] = useState<BotConnection>({ status: 'checking' })
  const actions = usePageActions(failureLines)
  // 保存を待つ間に入力欄が書き換えられたかを、保存の応答が届いた時点で確かめるために持つ
  const draftsRef = useRef(drafts)
  const urlFieldId = useId()

  const replaceDrafts = (next: readonly TriggerDraft[]): void => {
    draftsRef.current = next
    setDrafts(next)
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([api.media(), api.config()]).then(
      ([loadedMedia, triggers]) => {
        if (cancelled) return
        setMedia(loadedMedia)
        const loadedDrafts = triggers.map(toDraft)
        draftsRef.current = loadedDrafts
        setDrafts(loadedDrafts)
        setLoaded({ status: 'ready' })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    // 報酬の一覧はTwitchに問い合わせるので、素材や保存済みの設定より失敗しやすい（チャンネルポイントを使えないチャンネルなど）。
    // 失敗しても素材の管理は続けられるよう画面は出し、理由を表示する。報酬を選べない間も、報酬の条件を付けなければトリガーは作れる
    api.rewards().then(
      (loadedRewards) => {
        if (!cancelled) setRewards(loadedRewards)
      },
      (error: unknown) => {
        if (!cancelled) setRewardsFailure(`チャンネルポイント報酬の一覧を取得できませんでした: ${errorMessage(error)}`)
      },
    )
    // botの接続状態も、報酬と同じく取得できなくても操作盤は出す。
    // 取得できなかったときは未接続扱いにせず理由を出す（接続済みのbotを未接続に見せてしまわないため）
    botApi.status().then(
      (status) => {
        if (!cancelled) setBot({ status: 'loaded', bot: status })
      },
      (error: unknown) => {
        if (!cancelled) setBot({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, botApi])

  if (overlayKey === null) {
    return (
      <Alert variant="destructive">
        <AlertTitle>トリガーを表示できません</AlertTitle>
        <AlertDescription>オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください</AlertDescription>
      </Alert>
    )
  }
  if (loaded.status === 'loading') return <Skeleton className="h-64 w-full" aria-label="トリガーの設定を読み込んでいます" />
  if (loaded.status === 'failed') {
    return (
      <Alert variant="destructive">
        <AlertTitle>読み込みに失敗しました</AlertTitle>
        <AlertDescription>トリガーを表示できません: {loaded.message}</AlertDescription>
      </Alert>
    )
  }

  const url = overlayUrl(window.location.origin, overlayKey)

  const copyUrl = async (): Promise<string> => {
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    await navigator.clipboard.writeText(url)
    return 'OBS用のURLをコピーしました'
  }

  const rotateKey = async (): Promise<string> => {
    onOverlayKeyChange(await api.rotateOverlayKey())
    return 'キーを再発行しました。新しいURLをOBSに貼り替えてください'
  }

  const addTrigger = async (): Promise<string> => {
    const first = media[0]
    // 素材が1つもなければアラートは出せないので、チャットに送るだけのトリガーとして足す
    replaceDrafts([
      ...drafts,
      {
        event: REDEMPTION,
        conditions: [],
        alertEnabled: first !== undefined,
        mediaId: first?.id ?? '',
        durationSeconds: DEFAULT_DURATION_SECONDS,
        volumePercent: DEFAULT_VOLUME_PERCENT,
        message: '',
        chatEnabled: first === undefined,
        chatMessage: '',
        announceEnabled: false,
        announceMessage: '',
        announceColor: DEFAULT_ANNOUNCEMENT_COLOR,
      },
    ])
    setOpenPosition(drafts.length)
    return 'トリガーを足しました。保存するまで反映されません'
  }

  const saveTriggers = async (): Promise<string> => {
    const inputs = drafts.map((draft, index) => {
      try {
        return toTriggerInput(draft)
      } catch (error) {
        throw new Error(`${index + 1}番目のトリガー: ${errorMessage(error)}`, { cause: error })
      }
    })
    const submitted = drafts
    const saved = await api.saveConfig(inputs)
    // 保存を待つ間に入力欄が書き換えられていたら、その内容を応答で上書きしない（書き換えた分は次の保存で送られる）
    if (draftsRef.current !== submitted) return 'トリガーを保存しました。保存中に書き換えた内容はまだ保存されていません'
    replaceDrafts(saved.map(toDraft))
    return 'トリガーを保存しました。次の交換から反映されます'
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        チャンネルポイントの交換・フォロー・サブスク・レイド・チャットの発言が起きたときに、何をするかを決める。
      </p>

      {actions.feedback}
      {bot.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>botの接続状態が分かりません</AlertTitle>
          <AlertDescription>botの接続状態を取得できませんでした: {bot.message}</AlertDescription>
        </Alert>
      )}
      {bot.status === 'loaded' && bot.bot === null && (
        <Alert variant="destructive">
          <AlertTitle>botが接続されていません</AlertTitle>
          <AlertDescription>
            <span>
              「チャットに送る」「アナウンスを送る」の動作は、接続しているbotアカウントが送るので動きません。とくに「チャットの発言」のトリガーは、
              発言を受け取るのにbotのユーザーIDが要るため、Workerに発言そのものが届きません（アラートを出す動作はオーバーレイが受け取るので動きます）。
            </span>
            <span>
              <Link href="/bot/" className="underline underline-offset-4">
                チャットボット
              </Link>
              のページで接続してください。
            </span>
          </AlertDescription>
        </Alert>
      )}
      {rewardsFailure !== '' && (
        <Alert variant="destructive">
          <AlertTitle>報酬を選べません</AlertTitle>
          <AlertDescription>{rewardsFailure}（報酬の条件を付けなければトリガーは作れます）</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>OBS用のURL</CardTitle>
          <CardDescription>幅と高さは配信のキャンバスと同じ大きさ（1920×1080 など）にする。背景は透過で、素材は中央に表示される。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
          <div className="flex gap-2">
            {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
            <Input id={urlFieldId} type="password" readOnly autoComplete="off" value={url} />
            <Button type="button" disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
              URLをコピー
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            URLが他人に知られたら、キーを再発行してください。再発行すると今のURLは使えなくなり、OBSのURLを貼り替える必要があります（反映に最大1分かかります）。
          </p>
          <Button
            type="button"
            variant="outline"
            className="self-start text-destructive"
            disabled={actions.busy}
            onClick={() =>
              actions.ask({
                title: 'キーを再発行しますか？',
                description: 'キーを再発行すると、今のURLは使えなくなります。OBSのURLを貼り替える必要があります。',
                actionLabel: '再発行する',
                run: rotateKey,
              })
            }
          >
            キーを再発行する
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>トリガー</CardTitle>
          <CardDescription>
            イベントが起きたら、上から順に探して最初に当てはまったトリガーの素材を流す。条件を足すと、そのすべてを満たしたときだけ当てはまる。
            文言の <code>{'{user}'}</code> は相手の名前に置き換わる。ほかに使える差し込み語はイベントごとに違い、それぞれの文言欄の下に出る。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {media.length === 0 && (
            <p className="text-sm text-muted-foreground">
              素材が1つもないので、アラートを出す動作は選べません。
              <Link href="/media/" className="underline underline-offset-4">
                アップロード
              </Link>
              のページで素材を足してください。
            </p>
          )}
          {drafts.length === 0 ? (
            <p className="text-sm text-muted-foreground">トリガーはまだありません。</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {drafts.map((draft, index) => (
                <TriggerRow
                  // トリガーは順番でしか区別できないので、位置をキーにする
                  key={index}
                  position={index + 1}
                  draft={draft}
                  media={media}
                  rewards={rewards}
                  open={openPosition === index}
                  onToggle={() => setOpenPosition(openPosition === index ? null : index)}
                  onChange={(next) => replaceDrafts(drafts.map((other, position) => (position === index ? next : other)))}
                  onRemove={() => {
                    // 外した行より後ろは1つ前へ詰まるので、開いている位置もずらす（別のトリガーが開いて見えないようにする）
                    setOpenPosition(openPosition === null || openPosition === index ? null : openPosition > index ? openPosition - 1 : openPosition)
                    replaceDrafts(drafts.filter((_, position) => position !== index))
                  }}
                />
              ))}
            </ol>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="icon" aria-label="トリガーを足す" disabled={actions.busy} onClick={() => void actions.run(addTrigger)}>
              <Plus aria-hidden="true" />
            </Button>
            <Button type="button" disabled={actions.busy} onClick={() => void actions.run(saveTriggers)}>
              トリガーを保存
            </Button>
          </div>
        </CardContent>
      </Card>

    </div>
  )
}
