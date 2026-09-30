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
 * 注意: 失敗は黙って無視せず、画面の上部に理由を出す（Fail-Fast）。一覧を取得できなければ操作盤を出さない。
 */
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { ApiError } from '@/core/api'
import { iconButtonName } from '@/core/icon-button'
import type { AdminApi, Reward } from './api'
import { errorMessage, usePageActions } from './page-actions'
import { EMPTY_REWARD_DRAFT, describeRewardProblem, toRewardDraft, toRewardInput, type RewardDraft } from './reward-form'

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
      </div>
    </div>
  )
}

/** 下書きの一覧から、その報酬の下書きを外す */
const withoutDraft = (drafts: Record<string, RewardDraft>, id: string): Record<string, RewardDraft> =>
  Object.fromEntries(Object.entries(drafts).filter(([draftId]) => draftId !== id))

type Loaded = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

export const RewardPage = ({ api }: { api: AdminApi }) => {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [rewards, setRewards] = useState<readonly Reward[]>([])
  /** 追加する報酬の下書き */
  const [newDraft, setNewDraft] = useState<RewardDraft>(EMPTY_REWARD_DRAFT)
  /** 編集中の下書き（保存するまでの入力。報酬IDごとに持つ） */
  const [drafts, setDrafts] = useState<Record<string, RewardDraft>>({})
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
      <Alert variant="destructive">
        <AlertTitle>読み込みに失敗しました</AlertTitle>
        <AlertDescription>チャンネルポイント報酬を表示できません: {loaded.message}</AlertDescription>
      </Alert>
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
    <div className="flex max-w-3xl flex-col gap-6">
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
          <CardDescription>Twitchのダッシュボードで作った報酬は、ここでは変更できません。</CardDescription>
        </CardHeader>
        <CardContent>
          {rewards.length === 0 ? (
            <p className="text-sm text-muted-foreground">報酬はまだありません。</p>
          ) : (
            <ul aria-label="報酬の一覧" className="flex flex-col gap-3">
              {rewards.map((reward) =>
                reward.manageable ? (
                  <li key={reward.id} className="flex flex-col gap-3 rounded-lg border p-3">
                    <RewardFields
                      draft={draftOf(reward)}
                      disabled={actions.busy}
                      onChange={(patch) => setDrafts((current) => ({ ...current, [reward.id]: { ...draftOf(reward), ...patch } }))}
                    />
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        aria-label={`${reward.title} を保存`}
                        disabled={actions.busy}
                        onClick={() => void actions.run(() => saveReward(reward))}
                      >
                        保存する
                      </Button>
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
                    </div>
                  </li>
                ) : (
                  <li key={reward.id} className="flex flex-col gap-1 rounded-lg border p-3">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <strong className="text-sm font-medium">{reward.title}</strong>
                      <span className="text-xs text-muted-foreground">{`${reward.cost}ポイント`}</span>
                      {!reward.isEnabled && <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">交換できない</span>}
                    </div>
                    {reward.prompt !== '' && <p className="text-xs text-muted-foreground">{reward.prompt}</p>}
                    <p className="text-xs text-muted-foreground">Twitchで作った報酬なので、ここでは変更できません。</p>
                  </li>
                ),
              )}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
