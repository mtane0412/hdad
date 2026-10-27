/**
 * チャットで推理のページ（/chat-deduction/）
 *
 * 視聴者がチャンネルポイントの「質問」で答えを絞り込み、「解答」で当てるゲーム（issue #375）を、配信者が操作する画面である。
 * - 「質問」「解答」の2つの報酬を作る（Twitch が交換できるかどうかの切り替えを許すのは HDAD が作った報酬だけなので、既存の報酬は選ばせない）
 * - 問題集を選んでゲームを始める（どの問題を出すかは Worker が決める。2つの報酬を交換できるようにする）
 * - 開催中のゲームを、確かめてから終える（2つの報酬を交換できないようにする）
 * - 最後のゲームを終えていれば、その正解を出す（配信者が打ち切ったときも、視聴者が正解したときも、制限時間が尽きたときも）
 * - 場面ごとに合成ページで鳴らす音を選ぶ（sound-card.tsx）
 * - 正解者に渡す人形を選ぶ（src/dolls/doll-prize-field.tsx。issue #420）
 * - 制限時間を選ぶ（time-limit-field.tsx。次に始めるゲームから使い、尽きたら Worker が時間切れで終える）
 *
 * 問題集は引数で受け取る（テストで決まった問題を渡すため。アプリでは src/chat-deduction/problem-set.ts を渡す）。
 * 素材の一覧の読み出し（音の選択肢）も引数で受け取る（アプリでは AdminApi の media を渡す）。
 *
 * 注意: 開催中は問題集の名前と区分だけを出し、正解は出さない（配信者も視聴者と一緒に推理するため）。
 * 正解は最後のゲームを終えたあとにだけ出す。
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
import type { DollApi } from '@/dolls/api'
import { DollPrizeField } from '@/dolls/doll-prize-field'
import type { ChatDeductionApi, ChatDeductionEndReason, ChatDeductionState } from './api'
import { categoryLabelOf } from './category'
import type { ChatDeductionProblemSet } from './problems'
import { ChatDeductionSoundCard } from './sound-card'
import { ChatDeductionTimeLimitField } from './time-limit-field'

/** 問題集を選ぶ欄の言い方（例: 古代史の人物（12問）） */
const problemSetLabelOf = (set: ChatDeductionProblemSet): string => `${set.name}（${set.problems.length}問）`

/** 終わり方の画面の言い方 */
const END_REASON_LABELS: Record<ChatDeductionEndReason, string> = {
  stopped: '配信者が打ち切りました',
  solved: '視聴者が正解しました',
  timeout: '制限時間が尽きました',
}

interface ChatDeductionPageProps {
  api: ChatDeductionApi
  problemSets: readonly ChatDeductionProblemSet[]
  /** 正解者に渡す人形の読み書き */
  prizeApi: Pick<DollApi, 'prize' | 'savePrize'>
  /** アップロード済みの素材を読む（音のカードの選択肢）。読み直しを繰り返さないよう、描き直しても同じ関数を渡す */
  loadMedia: () => Promise<MediaItem[]>
}

export const ChatDeductionPage = ({ api, problemSets, prizeApi, loadMedia }: ChatDeductionPageProps) => {
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
              {state.game !== null && state.game.endReason !== null && (
                <p className="text-sm">
                  前回の正解: {answerOf(state.game.problemId)}（{END_REASON_LABELS[state.game.endReason]}）
                </p>
              )}
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
          <ChatDeductionTimeLimitField api={api} />
          <DollPrizeField api={prizeApi} game="chatDeduction" />
        </CardContent>
      </Card>
      <ChatDeductionSoundCard api={api} loadMedia={loadMedia} />
    </div>
  )
}
