/**
 * チャットで推理のページ（/chat-deduction/）
 *
 * 視聴者がチャンネルポイントの「質問」で答えを絞り込み、「解答」で当てるゲーム（issue #375）を、配信者が操作する画面である。
 * - 「質問」「解答」の2つの報酬を作る（Twitch が交換できるかどうかの切り替えを許すのは HDAD が作った報酬だけなので、既存の報酬は選ばせない）
 * - 問題集を選んでゲームを始める（どの問題を出すかは Worker が決める。2つの報酬を交換できるようにする）
 * - 開催中のゲームを、確かめてから終える（2つの報酬を交換できないようにする）。終えたら正解を知らせる
 * - 場面ごとに合成ページで鳴らす音を選ぶ（sound-card.tsx）
 *
 * 問題集は引数で受け取る（テストで決まった問題を渡すため。アプリでは src/chat-deduction/problem-set.ts を渡す）。
 * 素材の一覧の読み出し（音の選択肢）も引数で受け取る（アプリでは AdminApi の media を渡す）。
 *
 * 注意: 開催中は問題集の名前と区分だけを出し、正解は出さない（配信者も視聴者と一緒に推理するため）。
 * 正解はゲームを終えたときの知らせにだけ出す。
 */
import { useEffect, useId, useState } from 'react'
import type { MediaItem } from '@/admin/api'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Link } from '@/app/router'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import type { ChatDeductionApi, ChatDeductionState } from './api'
import { categoryLabelOf } from './category'
import type { ChatDeductionProblemSet } from './problems'
import { ChatDeductionSoundCard } from './sound-card'

/** 問題集を選ぶ欄の言い方（例: 古代史の人物（12問）） */
const problemSetLabelOf = (set: ChatDeductionProblemSet): string => `${set.name}（${set.problems.length}問）`

interface ChatDeductionPageProps {
  api: ChatDeductionApi
  problemSets: readonly ChatDeductionProblemSet[]
  /** アップロード済みの素材を読む（音のカードの選択肢）。読み直しを繰り返さないよう、描き直しても同じ関数を渡す */
  loadMedia: () => Promise<MediaItem[]>
}

export const ChatDeductionPage = ({ api, problemSets, loadMedia }: ChatDeductionPageProps) => {
  /** 最後に読んだ状態。読み込むまでは undefined */
  const [state, setState] = useState<ChatDeductionState>()
  const [loadError, setLoadError] = useState<string>()
  /** 選んでいる問題集のID（問題集が1つも無ければ空文字） */
  const [setId, setSetId] = useState(problemSets[0]?.id ?? '')
  const actions = usePageActions()
  const setSelectId = useId()

  useEffect(() => {
    let cancelled = false
    api.read().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  if (loadError !== undefined) return <LoadFailure title="チャットで推理を読み込めませんでした" message={loadError} />
  if (state === undefined) return <Skeleton className="h-48 w-full" />

  /** 開催中のゲーム。開催中でなければ null */
  const openGame = state.game !== null && state.game.endedAt === null ? state.game : null
  /** 開催中の問題の、正解を伏せた言い方（例: 【人物】古代史の人物） */
  const hiddenProblemOf = (problemId: string): string => {
    const set = problemSets.find((candidate) => candidate.problems.some((problem) => problem.id === problemId))
    const problem = set?.problems.find((candidate) => candidate.id === problemId)
    return set === undefined || problem === undefined ? `問題集に無い問題（${problemId}）` : `【${categoryLabelOf(problem.category)}】${set.name}`
  }
  /** 終えたゲームの正解の表記（問題集から消した問題なら ID のまま） */
  const answerOf = (problemId: string): string =>
    problemSets.flatMap((set) => set.problems).find((problem) => problem.id === problemId)?.answer ?? `問題集に無い問題（${problemId}）`

  const createRewards = (): Promise<void> =>
    actions.run(async () => {
      const created = await api.createRewards()
      setState((previous) => (previous === undefined ? previous : { ...previous, rewards: created }))
      return '「質問」「解答」の報酬を作りました'
    })

  const start = (): Promise<void> =>
    actions.run(async () => {
      const game = await api.startGame(setId)
      setState((previous) => (previous === undefined ? previous : { ...previous, game }))
      return `ゲームを始めました（${hiddenProblemOf(game.problemId)}）`
    })

  const askEnd = (id: number): void =>
    actions.ask({
      title: 'ゲームを終えますか？',
      description: '終えると「質問」「解答」の報酬を交換できないようにします。',
      actionLabel: 'ゲームを終える',
      run: async () => {
        const game = await api.endGame(id)
        setState((previous) => (previous === undefined ? previous : { ...previous, game }))
        return `ゲームを終えました（正解は${answerOf(game.problemId)}でした）`
      },
    })

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}
      <Card>
        <CardHeader>
          <CardTitle>報酬</CardTitle>
          <CardDescription>視聴者はチャンネルポイントの「質問」と「解答」でゲームに参加します。2つの報酬はゲームのあいだだけ交換できるようにします。</CardDescription>
        </CardHeader>
        <CardContent>
          {state.rewards === null ? (
            <Button type="button" disabled={actions.busy} onClick={() => void createRewards()}>
              報酬を作る
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              「チャットで推理: 質問」「チャットで推理: 解答」を作ってあります。必要ポイントや説明は
              <Link href="/rewards/" className="underline underline-offset-4">
                チャンネルポイント報酬
              </Link>
              のページで変えられます。
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>ゲーム</CardTitle>
          <CardDescription>問題集を選んで始めます。問題は問題集の中から HDAD が決め、正解はゲームを終えるまでこのページにも出しません。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {openGame !== null ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg font-semibold">{hiddenProblemOf(openGame.problemId)}</span>
              <Button type="button" variant="outline" disabled={actions.busy} onClick={() => askEnd(openGame.id)}>
                終える
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor={setSelectId}>問題集</Label>
                <NativeSelect id={setSelectId} className="w-full" value={setId} onChange={(event) => setSetId(event.currentTarget.value)}>
                  {problemSets.map((set) => (
                    <NativeSelectOption key={set.id} value={set.id}>
                      {problemSetLabelOf(set)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div>
                <Button type="button" disabled={actions.busy || state.rewards === null || setId === ''} onClick={() => void start()}>
                  ゲームを始める
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <ChatDeductionSoundCard api={api} loadMedia={loadMedia} />
    </div>
  )
}
