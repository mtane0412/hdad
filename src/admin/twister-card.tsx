/**
 * ツイスターのカード（トリガーのページ）
 *
 * ツイスター（issue #272）は配信者が決める設定を持たないので、このカードは試し再生のボタンだけを置く。
 * レイドを待たずに、試しの相手と配信者（自分のアイコン）の対戦を合成ページへ流させ、見栄えと置き場所を確かめられるようにする。
 *
 * 試し再生の結果・失敗は、トリガーの保存と取り違えないよう、このカードの中に出す。
 */
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { AdminApi } from './api'
import { usePageActions } from './page-actions'

/** このカードが使う Worker の呼び出し */
export type TwisterApi = Pick<AdminApi, 'playTwisterDemo'>

interface TwisterCardProps {
  api: TwisterApi
}

export const TwisterCard = ({ api }: TwisterCardProps) => {
  const actions = usePageActions()

  const playDemo = async (): Promise<string> =>
    `「${await api.playTwisterDemo()}」の対戦を送りました。オーバーレイに「ツイスター」の素材を置いていれば流れます`

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
          レイドを待たずに試しに流せる（相手は「レイドした人（試し）」で、指示と勝敗は毎回ランダム。オーバーレイに「ツイスター」の素材を置いておく）。
        </p>
        <Button type="button" variant="outline" className="self-start" disabled={actions.busy} onClick={() => void actions.run(playDemo)}>
          ツイスターを試しに流す
        </Button>
      </CardContent>
    </Card>
  )
}
