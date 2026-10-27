/**
 * チャットで推理の制限時間の選択欄（/chat-deduction/ のゲームのカード）
 *
 * ゲームを始めてから正解者が出ないまま何分たったら時間切れで終えるかを、なし・5/10/15/20/30分から選ぶ。
 * 選び直したら保存ボタンを待たずにその場で保存する（正解者に渡す人形の選択欄と同じ）。次に始めるゲームから使い、
 * 開催中のゲームの締め切りは変えない（始めたときに Worker が決めて控えているため）。
 *
 * 注意: 選択欄は保存できた値だけを出す。保存できなければ理由を出し、選択欄は保存済みの値のまま残す。
 * 注意: 読み込めなければ「なし」と見せず、理由を出す（Fail-Fast）。
 */
import { useEffect, useId, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { LoadFailure } from '@/components/load-failure'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import type { ChatDeductionApi } from './api'
import { CHAT_DEDUCTION_TIME_LIMIT_MINUTES } from './time-limit'

/** この欄が使う Worker の呼び出し */
export type ChatDeductionTimeLimitApi = Pick<ChatDeductionApi, 'timeLimit' | 'saveTimeLimit'>

/** 選択欄で「なし」を表す値（選択欄の値は文字列なので、null の代わりに空文字を使う） */
const NO_LIMIT_VALUE = ''

type Loaded = { status: 'loading' } | { status: 'ready'; minutes: number | null } | { status: 'failed'; message: string }

export const ChatDeductionTimeLimitField = ({ api }: { api: ChatDeductionTimeLimitApi }) => {
  const id = useId()
  const actions = usePageActions()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.timeLimit().then(
      (minutes) => {
        if (!cancelled) setLoaded({ status: 'ready', minutes })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  if (loaded.status === 'loading') return <Skeleton className="h-16 w-full sm:max-w-xs" aria-label="制限時間を読み込んでいます" />
  if (loaded.status === 'failed') return <LoadFailure title="制限時間を表示できません" message={loaded.message} />

  const save = async (minutes: number | null): Promise<string> => {
    setLoaded({ status: 'ready', minutes: await api.saveTimeLimit(minutes) })
    return '制限時間を保存しました'
  }

  return (
    <div className="flex flex-col gap-2">
      {actions.feedback}
      <div className="flex flex-col gap-2 sm:max-w-xs">
        <Label htmlFor={id}>制限時間</Label>
        <NativeSelect
          id={id}
          className="w-full"
          value={loaded.minutes === null ? NO_LIMIT_VALUE : String(loaded.minutes)}
          disabled={actions.busy}
          onChange={(event) => {
            // 選択肢は「なし」と分数の一覧から作っているので、それ以外の値は来ない
            const { value } = event.currentTarget
            void actions.run(() => save(value === NO_LIMIT_VALUE ? null : Number(value)))
          }}
        >
          <NativeSelectOption value={NO_LIMIT_VALUE}>なし</NativeSelectOption>
          {CHAT_DEDUCTION_TIME_LIMIT_MINUTES.map((minutes) => (
            <NativeSelectOption key={minutes} value={String(minutes)}>
              {minutes}分
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <p className="text-sm text-muted-foreground">
        始めてからこの時間のうちに誰も正解できなければ、ゲームを時間切れで終えて正解を出します。オーバーレイには残り時間を出します。変えた制限時間は次に始めるゲームから使います。
      </p>
    </div>
  )
}
