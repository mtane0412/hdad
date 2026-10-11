/**
 * ペロペロのカード（トリガーのページ）
 *
 * ペロペロ（issue #338）を、トリガーを待たずに試しに流すボタンを置く。ボタンの横の入力欄に Twitch のログイン名を入れると、
 * その人のアイコンを舐める。空ならアイコンの無い試しの相手を舐める。見栄えと置き場所を OBS で確かめるためのもの。
 *
 * 試し再生の結果・失敗は、トリガーの保存と取り違えないよう、このカードの中に出す。
 */
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AdminApi } from './api'
import { errorMessage, usePageActions } from './page-actions'

/** このカードが使う Worker の呼び出し */
export type LickApi = Pick<AdminApi, 'playLickDemo'>

const failureLines = (error: unknown): string[] => [errorMessage(error)]

interface LickCardProps {
  api: LickApi
}

export const LickCard = ({ api }: LickCardProps) => {
  const id = useId()
  const actions = usePageActions(failureLines)
  /** 試し再生で相手とみなす人のログイン名。空なら試しの相手を舐める。保存はしない */
  const [demoUserName, setDemoUserName] = useState('')

  const playDemo = async (): Promise<string> =>
    `「${await api.playLickDemo(demoUserName.trim())}」をペロペロしました。オーバーレイに「ペロペロ」の素材を置いていれば流れます`

  return (
    <Card>
      <CardHeader>
        <CardTitle>ペロペロ</CardTitle>
        <CardDescription>
          チャンネルポイントの交換や、決まった人のその配信で最初の発言で、相手の Twitch のアイコンを3Dの舌が舐め上げる。トリガーの項目で「ペロペロする」を選ぶ。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        <p className="text-sm text-muted-foreground">
          トリガーを待たずに試しに流せる（舐め方は毎回ランダム。オーバーレイに「ペロペロ」の素材を置いておく）。ユーザー名を入れると、その人のアイコンを舐める。空なら「視聴者（試し）」を舐める。
        </p>
        <div className="flex flex-col gap-2 sm:max-w-xs">
          <Label htmlFor={`${id}-demo-user`}>ペロペロの相手とみなすユーザー名（任意）</Label>
          <Input
            id={`${id}-demo-user`}
            value={demoUserName}
            placeholder="Twitch のログイン名"
            autoComplete="off"
            onChange={(event) => setDemoUserName(event.currentTarget.value)}
          />
        </div>
        <Button type="button" variant="outline" className="self-start" disabled={actions.busy} onClick={() => void actions.run(playDemo)}>
          ペロペロを試しに流す
        </Button>
      </CardContent>
    </Card>
  )
}
