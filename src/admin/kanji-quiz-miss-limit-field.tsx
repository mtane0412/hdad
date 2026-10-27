/**
 * 漢字クイズで配信を止めるまでの時間切れの回数の選択欄（トリガーのページの漢字クイズのカード）
 *
 * 1配信のうちに時間切れ（誰も正解できないまま制限時間が尽きた出題）が何回になったら配信を止めるかを、1〜10回から選ぶ。
 * 選び直したら保存ボタンを待たずにその場で保存する（正解者に渡す人形の選択欄と同じ。カードの音の保存ボタンと混ぜると、
 * 音の設定の未保存の印と食い違うため）。
 *
 * 注意: 選択欄は保存できた値だけを出す。保存できなければ理由を出し、選択欄は保存済みの値のまま残す。
 * 注意: 読み込めなければ1回と見せず、理由を出す（Fail-Fast）。
 */
import { useEffect, useId, useState } from 'react'
import { LoadFailure } from '@/components/load-failure'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { KANJI_QUIZ_MISS_LIMITS } from '@/kanji-quiz/miss-limit'
import type { AdminApi } from './api'
import { errorMessage, usePageActions } from './page-actions'

/** この欄が使う Worker の呼び出し */
export type KanjiQuizMissLimitApi = Pick<AdminApi, 'kanjiQuizMissLimit' | 'saveKanjiQuizMissLimit'>

type Loaded = { status: 'loading' } | { status: 'ready'; missLimit: number } | { status: 'failed'; message: string }

export const KanjiQuizMissLimitField = ({ api }: { api: KanjiQuizMissLimitApi }) => {
  const id = useId()
  const actions = usePageActions()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.kanjiQuizMissLimit().then(
      (missLimit) => {
        if (!cancelled) setLoaded({ status: 'ready', missLimit })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  if (loaded.status === 'loading') return <Skeleton className="h-16 w-full sm:max-w-xs" aria-label="配信を終える時間切れの回数を読み込んでいます" />
  if (loaded.status === 'failed') return <LoadFailure title="配信を終える時間切れの回数を表示できません" message={loaded.message} />

  const save = async (missLimit: number): Promise<string> => {
    setLoaded({ status: 'ready', missLimit: await api.saveKanjiQuizMissLimit(missLimit) })
    return '配信を終える時間切れの回数を保存しました'
  }

  return (
    <div className="flex flex-col gap-2">
      {actions.feedback}
      <div className="flex flex-col gap-2 sm:max-w-xs">
        <Label htmlFor={id}>配信を終える時間切れの回数（1配信あたり）</Label>
        <NativeSelect
          id={id}
          className="w-full"
          value={String(loaded.missLimit)}
          disabled={actions.busy}
          onChange={(event) => {
            // 選択肢は回数の一覧から作っているので、数として読めない値は来ない
            void actions.run(() => save(Number(event.currentTarget.value)))
          }}
        >
          {KANJI_QUIZ_MISS_LIMITS.map((missLimit) => (
            <NativeSelectOption key={missLimit} value={String(missLimit)}>
              {missLimit}回
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <p className="text-sm text-muted-foreground">
        同じ配信で誰も正解できない時間切れがこの回数になったら配信を止めます。それより前の時間切れでは止めず、オーバーレイにあと何回で終わるかを出します。
      </p>
    </div>
  )
}
