/**
 * チャンネルポイント報酬のページ
 *
 * 配信者のチャンネルポイント報酬を一覧で出し、追加・編集・削除を受け持つ（issue #160）。
 * 報酬を交換されたときに何をするかはトリガーのページ（trigger-page.tsx）が決める。
 * ログインの確認とログアウトはアプリの枠（src/app/app.tsx）が受け持つので、ここではログイン済みを前提にする。
 * Workerの呼び出しは api.ts、入力欄の値の変換は reward-form.ts、操作の実行と結果の表示は page-actions.tsx に任せる。
 *
 * 注意: Twitchは、HDADが作った報酬以外の変更を拒む。Twitchのダッシュボードで作った報酬（manageable が false）は
 * 一覧に出すだけにして、編集欄も削除のボタンも出さない（押せるのに必ず失敗するボタンを置かない）。
 * 注意: 報酬の画像はTwitchのダッシュボードでしか登録・変更できない（Helixが画像を受け付けない）ので、表示だけを行い、
 * Twitchの報酬のページ（クリエイターダッシュボード）へのリンクを添える。
 * 注意: 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。一覧を取得できなければ操作盤を出さない。
 */
import { ExternalLink, Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { LoadFailure } from '@/components/load-failure'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Quantity, StatusDot } from '@/components/data/data-display'
import { DataTable, DataTableCell, DataTableRow } from '@/components/data/data-table'
import { SaveBar } from '@/components/save-bar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/core/api'
import { iconButtonName } from '@/core/icon-button'
import type { AdminApi, Reward } from './api'
import { errorMessage, usePageActions } from './page-actions'
import { EMPTY_REWARD_DRAFT, describeRewardProblem, sameRewardDraft, toRewardDraft, toRewardInput, type RewardDraft } from './reward-form'

/** 配信者のチャンネルポイント報酬を管理する、Twitchのクリエイターダッシュボードのページ */
const twitchRewardsUrl = (broadcasterLogin: string): string =>
  `https://dashboard.twitch.tv/u/${encodeURIComponent(broadcasterLogin)}/viewer-rewards/channel-points/rewards`

/** 失敗を画面に出す行にする。Workerが入力の問題点を返したら、欄の名前で1行ずつ並べる */
const toFailureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['報酬の内容に問題があります。直してからやり直してください', ...error.problems.map((problem) => `・${describeRewardProblem(problem)}`)]
    : [errorMessage(error)]

interface RewardFieldsProps {
  draft: RewardDraft
  disabled: boolean
  onChange(patch: Partial<RewardDraft>): void
}

/** 待機時間の入力欄の下限（秒）。検証はWorkerが持ち、ここでは入力欄の矢印の始まりにだけ使う */
const MIN_COOLDOWN_SECONDS = 60

interface LimitFieldProps {
  id: string
  label: string
  min: number
  value: string
  disabled: boolean
  onChange(value: string): void
}

/** 待機時間・上限回数の入力欄。空欄は制限なしを表す */
const LimitField = ({ id, label, min, value, disabled, onChange }: LimitFieldProps) => (
  <div className="flex flex-col gap-2">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type="number" min={min} step={1} placeholder="制限なし" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
  </div>
)

/** 報酬の入力欄（追加と編集で共通） */
const RewardFields = ({ draft, disabled, onChange }: RewardFieldsProps) => {
  const id = useId()
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-title`}>名前</Label>
          <Input id={`${id}-title`} value={draft.title} disabled={disabled} onChange={(event) => onChange({ title: event.target.value })} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-cost`}>必要ポイント</Label>
          <Input
            id={`${id}-cost`}
            type="number"
            min={1}
            step={1}
            value={draft.cost}
            disabled={disabled}
            onChange={(event) => onChange({ cost: event.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-prompt`}>説明</Label>
        <Textarea id={`${id}-prompt`} rows={2} value={draft.prompt} disabled={disabled} onChange={(event) => onChange({ prompt: event.target.value })} />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-enabled`}
            checked={draft.isEnabled}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ isEnabled: checked === true })}
          />
          <Label htmlFor={`${id}-enabled`}>交換できる</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-input`}
            checked={draft.isUserInputRequired}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ isUserInputRequired: checked === true })}
          />
          <Label htmlFor={`${id}-input`}>メッセージの入力を求める</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-skip-queue`}
            checked={draft.shouldRedemptionsSkipRequestQueue}
            disabled={disabled}
            onCheckedChange={(checked) => onChange({ shouldRedemptionsSkipRequestQueue: checked === true })}
          />
          <Label htmlFor={`${id}-skip-queue`}>交換したらすぐ完了にする（待ち行列に入れない）</Label>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_1fr]">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-color`}>背景色</Label>
          <Input
            id={`${id}-color`}
            type="color"
            className="w-16 p-1"
            value={draft.backgroundColor}
            disabled={disabled}
            onChange={(event) => onChange({ backgroundColor: event.target.value })}
          />
        </div>
        {/* 待機時間・上限回数は空欄なら制限なし（Workerへ null で送る） */}
        <LimitField id={`${id}-cooldown`} label="待機時間（秒）" min={MIN_COOLDOWN_SECONDS} value={draft.globalCooldownSeconds} disabled={disabled} onChange={(globalCooldownSeconds) => onChange({ globalCooldownSeconds })} />
        <LimitField id={`${id}-max-per-stream`} label="1配信あたりの上限回数" min={1} value={draft.maxPerStream} disabled={disabled} onChange={(maxPerStream) => onChange({ maxPerStream })} />
        <LimitField id={`${id}-max-per-user`} label="1人あたりの上限回数" min={1} value={draft.maxPerUserPerStream} disabled={disabled} onChange={(maxPerUserPerStream) => onChange({ maxPerUserPerStream })} />
      </div>
    </div>
  )
}

/** 下書きの一覧から、その報酬の下書きを外す */
const withoutDraft = (drafts: Record<string, RewardDraft>, id: string): Record<string, RewardDraft> =>
  Object.fromEntries(Object.entries(drafts).filter(([draftId]) => draftId !== id))

/**
 * 報酬の印。Twitchの画面と同じく、報酬の背景色の上に画像を載せる。
 *
 * 色は報酬の値そのものなので、印全体を「背景色 #RRGGBB」と読める画像にする。画像は飾りなので読み上げない（alt は空）。
 * 画像はTwitchのダッシュボードでしか登録・変更できないので、ここでは表示だけを行う。
 */
const RewardIcon = ({ reward }: { reward: Reward }) => (
  <span
    role="img"
    aria-label={`背景色 ${reward.backgroundColor}`}
    className="flex size-7 shrink-0 items-center justify-center rounded-md ring-1 ring-foreground/10 ring-inset"
    style={{ backgroundColor: reward.backgroundColor }}
  >
    <img src={reward.imageUrl} alt="" loading="lazy" className="size-5 object-contain" />
  </span>
)

/** 行の列（名前・ポイント・状態・制限）。見出しの行と報酬の行で同じ幅にし、上下で列をそろえる */
const REWARD_COLUMNS = 'minmax(0,1.6fr) 5rem 7rem minmax(0,1.4fr)'

const REWARD_HEADINGS = [{ label: '名前' }, { label: 'ポイント', align: 'end' }, { label: '状態' }, { label: '制限' }] as const

/** 制限（上限回数・待機時間）を数と単位で並べる。どれも無ければ「制限なし」を薄く出す（0 と取り違えないため） */
const RewardLimits = ({ reward }: { reward: Reward }) => {
  const limits = [
    { label: '配信あたり', value: reward.maxPerStream, unit: '回' },
    { label: '1人', value: reward.maxPerUserPerStream, unit: '回' },
    { label: '待機', value: reward.globalCooldownSeconds, unit: '秒' },
  ].filter((limit) => limit.value !== null)
  if (limits.length === 0) return <span className="text-muted-foreground">制限なし</span>
  return (
    <span className="flex flex-wrap gap-x-2 text-xs">
      {limits.map((limit) => (
        <span key={limit.label} className="whitespace-nowrap">
          {limit.label} <Quantity value={limit.value} unit={limit.unit} />
        </span>
      ))}
    </span>
  )
}

/** 報酬1件の要約（名前・ポイント・状態・制限の4列）。行を開くボタンの中と、Twitchで作った報酬の押せない行で共通に使う */
const RewardSummary = ({ reward, unsaved = false }: { reward: Reward; unsaved?: boolean }) => (
  <>
    <DataTableCell className="flex-nowrap gap-3">
      {/* アイコンは名前の左に見せるが、読み上げは名前から始める（行のボタンの名前を報酬の名前から始めるため） */}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium">{reward.title}</span>
          {/* 閉じた行でも、保存していない書きかけがあることを見落とさないようにする */}
          {unsaved && (
            <StatusDot tone="attention" className="shrink-0 text-xs font-normal">
              未保存
            </StatusDot>
          )}
          {reward.isUserInputRequired && <span className="shrink-0 text-xs font-normal text-muted-foreground">入力あり</span>}
          {/* 行ごとに長い注記を繰り返すと読みにくいので、見た目は短い札にし、理由は読み上げにだけ残す */}
          {!reward.manageable && (
            <span className="shrink-0 rounded-sm border px-1 text-xs font-normal text-muted-foreground">
              Twitch<span className="sr-only">で作った報酬なので、ここでは変更できません。</span>
            </span>
          )}
        </span>
        {reward.prompt !== '' && <span className="truncate text-xs font-normal text-muted-foreground">{reward.prompt}</span>}
      </span>
      <span className="order-first">
        <RewardIcon reward={reward} />
      </span>
    </DataTableCell>
    <DataTableCell align="end">
      <Quantity value={reward.cost} unit="pt" />
    </DataTableCell>
    <DataTableCell>
      <StatusDot tone={reward.isEnabled ? 'positive' : 'neutral'}>{reward.isEnabled ? '交換できる' : '止めている'}</StatusDot>
    </DataTableCell>
    <DataTableCell>
      <RewardLimits reward={reward} />
    </DataTableCell>
  </>
)

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

interface RewardPageProps {
  api: AdminApi
  /** ログイン中の配信者のログイン名（Twitchの報酬のページのURLに使う） */
  broadcasterLogin: string
}

export const RewardPage = ({ api, broadcasterLogin }: RewardPageProps) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [rewards, setRewards] = useState<readonly Reward[]>([])
  /** 追加する報酬の下書き */
  const [newDraft, setNewDraft] = useState<RewardDraft>(EMPTY_REWARD_DRAFT)
  /** 編集中の下書き（保存するまでの入力。報酬IDごとに持つ） */
  const [drafts, setDrafts] = useState<Record<string, RewardDraft>>({})
  /** 編集欄を開いている報酬のID。一覧を見渡せるよう、開くのは1件ずつにする */
  const [openId, setOpenId] = useState<string | null>(null)
  const actions = usePageActions(toFailureLines)

  useEffect(() => {
    let cancelled = false
    api.rewards().then(
      (loadedRewards) => {
        if (cancelled) return
        setRewards(loadedRewards)
        setLoaded({ status: 'ready' })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  if (loaded.status === 'loading') return <Skeleton className="h-64 w-full" aria-label="チャンネルポイント報酬を読み込んでいます" />
  if (loaded.status === 'failed') {
    return (
      <LoadFailure title="チャンネルポイント報酬を表示できません" message={loaded.message} />
    )
  }

  const draftOf = (reward: Reward): RewardDraft => drafts[reward.id] ?? toRewardDraft(reward)

  const createReward = async (): Promise<string> => {
    const created = await api.createReward(toRewardInput(newDraft))
    setRewards((current) => [...current, created])
    setNewDraft(EMPTY_REWARD_DRAFT)
    return `${created.title} を追加しました`
  }

  const saveReward = async (reward: Reward): Promise<string> => {
    const saved = await api.updateReward(reward.id, toRewardInput(draftOf(reward)))
    setRewards((current) => current.map((other) => (other.id === reward.id ? saved : other)))
    // 保存したものが正になるので、下書きは捨てる
    setDrafts((current) => withoutDraft(current, reward.id))
    return `${saved.title} を保存しました`
  }

  const removeReward = async (reward: Reward): Promise<string> => {
    await api.removeReward(reward.id)
    setRewards((current) => current.filter((other) => other.id !== reward.id))
    setDrafts((current) => withoutDraft(current, reward.id))
    return `${reward.title} を削除しました`
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>報酬を追加する</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            aria-label="報酬を追加する"
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void actions.run(createReward)
            }}
          >
            <RewardFields draft={newDraft} disabled={actions.busy} onChange={(patch) => setNewDraft((current) => ({ ...current, ...patch }))} />
            <div>
              <Button type="submit" size="icon" {...iconButtonName('報酬を追加する')} disabled={actions.busy}>
                <Plus aria-hidden="true" />
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>チャンネルポイント報酬</CardTitle>
          <CardDescription>Twitchのダッシュボードで作った報酬は、ここでは変更できません。画像はTwitchで設定してください。</CardDescription>
          <CardAction>
            <a href={twitchRewardsUrl(broadcasterLogin)} target="_blank" rel="noreferrer" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <ExternalLink aria-hidden="true" />
              Twitchで報酬を開く
            </a>
          </CardAction>
        </CardHeader>
        <CardContent>
          {rewards.length === 0 ? (
            <p className="text-sm text-muted-foreground">報酬はまだありません。</p>
          ) : (
            <DataTable label="報酬の一覧" columns={REWARD_COLUMNS} headings={REWARD_HEADINGS}>
              {rewards.map((reward) =>
                // Twitchで作った報酬はHDADから変更できないので、押せない行にする（押せるのに必ず失敗する操作を置かない）
                !reward.manageable ? (
                  <DataTableRow key={reward.id} label={reward.title}>
                    <RewardSummary reward={reward} />
                  </DataTableRow>
                ) : (
                  // HDADが作った報酬は、行を押すとその場で下に編集欄が開く（もう一度押すと閉じる）
                  <DataTableRow
                    key={reward.id}
                    label={reward.title}
                    expand={{
                      open: openId === reward.id,
                      onToggle: () => setOpenId(openId === reward.id ? null : reward.id),
                      detail: (
                        <>
                          <RewardFields
                            draft={draftOf(reward)}
                            disabled={actions.busy}
                            onChange={(patch) => setDrafts((current) => ({ ...current, [reward.id]: { ...draftOf(reward), ...patch } }))}
                          />
                          <SaveBar
                            label="保存する"
                            name={`${reward.title} を保存する`}
                            busy={actions.busy}
                            unsaved={!sameRewardDraft(draftOf(reward), toRewardDraft(reward))}
                            onSave={() => void actions.run(() => saveReward(reward))}>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="text-destructive"
                              {...iconButtonName(`${reward.title} を削除`)}
                              disabled={actions.busy}
                              onClick={() =>
                                actions.ask({
                                  title: `${reward.title} を削除しますか？`,
                                  description: 'Twitchから報酬が消え、元に戻せません。交換を待っているものも消えます。',
                                  actionLabel: '削除する',
                                  run: () => removeReward(reward),
                                })
                              }
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </SaveBar>
                        </>
                      ),
                    }}
                  >
                    <RewardSummary reward={reward} unsaved={!sameRewardDraft(draftOf(reward), toRewardDraft(reward))} />
                  </DataTableRow>
                ),
              )}
            </DataTable>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
