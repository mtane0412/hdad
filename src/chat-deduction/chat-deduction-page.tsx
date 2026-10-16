/**
 * チャットで推理のページ（/chat-deduction/）
 *
 * 視聴者がチャンネルポイントの「質問」で答えを絞り込み、「解答」で当てるゲーム（issue #375）を、配信者が操作する画面である。
 * - 「質問」「解答」の2つの報酬を作る（Twitch が交換できるかどうかの切り替えを許すのは HDAD が作った報酬だけなので、既存の報酬は選ばせない）
 * - 問題集から問題を選んでゲームを始める（2つの報酬を交換できるようにする）
 * - 開催中のゲームを、確かめてから終える（2つの報酬を交換できないようにする）
 * - 場面ごとに合成ページで鳴らす音を選ぶ（sound-card.tsx）
 *
 * 問題集は引数で受け取る（テストで決まった問題を渡すため。アプリでは src/chat-deduction/problem-set.ts を渡す）。
 * 素材の一覧の読み出し（音の選択肢）も引数で受け取る（アプリでは AdminApi の media を渡す）。
 *
 * 注意: 問題を選ぶ欄と開催中の問題には正解をそのまま出す（配信者が選ぶため）。このページを配信に映さないこと。
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
import type { ChatDeductionProblem } from './problems'
import { ChatDeductionSoundCard } from './sound-card'

/** 問題の画面の言い方（例: 【場所】富士山） */
const problemLabelOf = (problem: ChatDeductionProblem): string => `【${categoryLabelOf(problem.category)}】${problem.answer}`

interface ChatDeductionPageProps {
  api: ChatDeductionApi
  problems: readonly ChatDeductionProblem[]
  /** アップロード済みの素材を読む（音のカードの選択肢）。読み直しを繰り返さないよう、描き直しても同じ関数を渡す */
  loadMedia: () => Promise<MediaItem[]>
}

export const ChatDeductionPage = ({ api, problems, loadMedia }: ChatDeductionPageProps) => {
  /** 最後に読んだ状態。読み込むまでは undefined */
  const [state, setState] = useState<ChatDeductionState>()
  const [loadError, setLoadError] = useState<string>()
  /** 選んでいる問題のID（問題集が空なら空文字） */
  const [problemId, setProblemId] = useState(problems[0]?.id ?? '')
  const actions = usePageActions()
  const problemSelectId = useId()

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
  const problemOf = (id: string): string => {
    const problem = problems.find((candidate) => candidate.id === id)
    return problem === undefined ? `問題集に無い問題（${id}）` : problemLabelOf(problem)
  }

  const createRewards = (): Promise<void> =>
    actions.run(async () => {
      const created = await api.createRewards()
      setState((previous) => (previous === undefined ? previous : { ...previous, rewards: created }))
      return '「質問」「解答」の報酬を作りました'
    })

  const start = (): Promise<void> =>
    actions.run(async () => {
      const game = await api.startGame(problemId)
      setState((previous) => (previous === undefined ? previous : { ...previous, game }))
      return `ゲームを始めました（${problemOf(game.problemId)}）`
    })

  const askEnd = (id: number): void =>
    actions.ask({
      title: 'ゲームを終えますか？',
      description: '終えると「質問」「解答」の報酬を交換できないようにします。',
      actionLabel: 'ゲームを終える',
      run: async () => {
        const game = await api.endGame(id)
        setState((previous) => (previous === undefined ? previous : { ...previous, game }))
        return 'ゲームを終えました'
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
          <CardDescription>問題を選んで始めます。問題を選ぶ欄には正解が出るので、このページは配信に映さないでください。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {openGame !== null ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg font-semibold">{problemOf(openGame.problemId)}</span>
              <Button type="button" variant="outline" disabled={actions.busy} onClick={() => askEnd(openGame.id)}>
                終える
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor={problemSelectId}>問題</Label>
                <NativeSelect id={problemSelectId} className="w-full" value={problemId} onChange={(event) => setProblemId(event.currentTarget.value)}>
                  {problems.map((problem) => (
                    <NativeSelectOption key={problem.id} value={problem.id}>
                      {problemLabelOf(problem)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div>
                <Button type="button" disabled={actions.busy || state.rewards === null || problemId === ''} onClick={() => void start()}>
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
