/**
 * ツイスターのカード（トリガーのページ）
 *
 * ツイスター（issue #272）は配信者が決める設定を持たないので、このカードは試し再生のボタンだけを置く。
 * レイドを待たずに、試しの相手と配信者（自分のアイコン）の対戦を合成ページへ流させ、見栄えと置き場所を確かめられるようにする。
 * ボタンの横の入力欄にユーザー名を入れると、その配信者がレイドしてきたものとみなし、相手の顔にその人のアイコンを貼って流す。
 *
 * 試し再生の結果・失敗は、トリガーの保存と取り違えないよう、このカードの中に出す。
 */
import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AdminApi } from './api'
import { usePageActions } from './page-actions'

/** このカードが使う Worker の呼び出し */
export type TwisterApi = Pick<AdminApi, 'playTwisterDemo'>

interface TwisterCardProps {
  api: TwisterApi
}

export const TwisterCard = ({ api }: TwisterCardProps) => {
  const id = useId()
  const actions = usePageActions()
  /** 試し再生で相手とみなす配信者のログイン名。空なら試しの相手で流す。保存はしない */
  const [demoUserName, setDemoUserName] = useState('')

  const playDemo = async (): Promise<string> =>
    `「${await api.playTwisterDemo(demoUserName.trim())}」の対戦を送りました。オーバーレイに「ツイスター」の素材を置いていれば流れます`

  return (
    <Card>
      <CardHeader>
        <CardTitle>ツイスター</CardTitle>
        <CardDescription>
          レイドしてきた配信者と自分が、3Dの人形でツイスターゲームをする。人形の顔には2人の Twitch のアイコンが貼られる。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        <p className="text-sm text-muted-foreground">
          レイドを待たずに試しに流せる（指示と勝敗は毎回ランダム。オーバーレイに「ツイスター」の素材を置いておく）。
          ユーザー名を入れると、その配信者がレイドしてきたものとみなして、その人のアイコンで対戦する。空なら相手は「レイドした人（試し）」になる。
        </p>
        <div className="flex flex-col gap-2 sm:max-w-xs">
          <Label htmlFor={`${id}-demo-user`}>ツイスターの相手とみなすユーザー名（任意）</Label>
          <Input
            id={`${id}-demo-user`}
            value={demoUserName}
            placeholder="Twitch のログイン名"
            autoComplete="off"
            onChange={(event) => setDemoUserName(event.currentTarget.value)}
          />
        </div>
        <Button type="button" variant="outline" className="self-start" disabled={actions.busy} onClick={() => void actions.run(playDemo)}>
          ツイスターを試しに流す
        </Button>
      </CardContent>
    </Card>
  )
}
