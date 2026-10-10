/**
 * 漢字クイズのカード（トリガーのページ）
 *
 * 漢字クイズ（issue #300）の試し再生を置く。チャンネルポイントの交換を待たずに、選んだ級の問題を1問合成ページへ流させ、
 * 見栄えと置き場所を確かめられるようにする。級はトリガーの行の設定とは別に、このカードの中だけで選ぶ（保存はしない）。
 *
 * 試し再生の結果・失敗は、トリガーの保存と取り違えないよう、このカードの中に出す。
 */
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { isKankenGrade, type KankenGrade } from '@/kanji-quiz/grade'
import type { AdminApi } from './api'
import { DEFAULT_KANJI_QUIZ_GRADE, KANJI_QUIZ_GRADE_OPTIONS } from './form'
import { usePageActions } from './page-actions'

/** このカードが使う Worker の呼び出し */
export type KanjiQuizApi = Pick<AdminApi, 'playKanjiQuizDemo'>

interface KanjiQuizCardProps {
  api: KanjiQuizApi
}

export const KanjiQuizCard = ({ api }: KanjiQuizCardProps) => {
  const id = useId()
  const actions = usePageActions()
  /** 試し再生で出題する級。保存はしない */
  const [grade, setGrade] = useState<KankenGrade>(DEFAULT_KANJI_QUIZ_GRADE)

  const playDemo = async (): Promise<string> =>
    `${await api.playKanjiQuizDemo(grade)} を出題しました。オーバーレイに「漢字クイズ」の素材を置いていれば流れます`

  return (
    <Card>
      <CardHeader>
        <CardTitle>漢字クイズ</CardTitle>
        <CardDescription>
          チャンネルポイントが交換されたら、熟語の読みを問う漢字クイズを流す。問題はリポジトリの問題集から、トリガーで選んだ級のものを1問選ぶ。
          制限時間が過ぎると正解の読みと解説を出す。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        <div className="flex flex-col gap-2 sm:max-w-xs">
          <Label htmlFor={`${id}-grade`}>試しに出題する級</Label>
          <NativeSelect
            id={`${id}-grade`}
            className="w-full"
            value={grade}
            onChange={(event) => {
              const { value } = event.currentTarget
              // 選択肢は級の一覧から作っているので、級でない値は来ない
              if (isKankenGrade(value)) setGrade(value)
            }}
          >
            {KANJI_QUIZ_GRADE_OPTIONS.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button type="button" variant="outline" className="self-start" disabled={actions.busy} onClick={() => void actions.run(playDemo)}>
          漢字クイズを試しに流す
        </Button>
      </CardContent>
    </Card>
  )
}
