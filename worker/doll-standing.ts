/**
 * 人形の所持数とランキングを、合成ページの素材「人形の獲得」へ出す
 *
 * 獲得の演出（worker/doll-award.ts の grantDolls）と同じ素材・同じ配送先（AlertChannel の目印 dollAward）に、
 * 1人ぶんのいまの人形の所持数（DollStandingCall）と、いまの人形の点数のランキング（DollRankingCall）を押し出す。
 * 呼ぶのは、チャットの組み込みのコマンド（worker/doll-command.ts の !人形・!人形ランキング）と、
 * 管理画面の経路（worker/doll-routes.ts の POST /api/admin/viewers/:userId/dolls/show・POST /api/admin/doll-ranking/show）。
 *
 * 注意: 出せなかったとき（いまの人形が無い・オーバーレイ用キーが無い・配送先の失敗）は黙らずに投げる。
 *   記録するか応答で返すかは呼び出し側が決める（チャットは失敗の記録、管理画面はエラーの応答）。
 */
import { pushDollAward } from './alert-channel'
import { DOLL_RANKING_LIMIT } from './doll'
import { dollFigureViewOf, loadDollOverlayKey, type DollAwardEnv } from './doll-award'
import { readDollRanking, readDollStanding } from './doll-store'

/**
 * その人のいまの人形の所持数を、合成ページへ押し出す。持っていなければ 0 つとして出す。
 *
 * @param userName 合成ページに出す、その人の表示名
 * @throws DollChangeError いまの人形が選ばれていない場合
 * @throws Error オーバーレイ用キーが無い・配送先が失敗した場合
 */
export const showDollStanding = async (env: DollAwardEnv, userId: string, userName: string): Promise<void> => {
  const standing = await readDollStanding(env.DB, userId)
  const overlayKey = await loadDollOverlayKey(env)
  await pushDollAward(env.ALERTS, {
    type: 'standing',
    id: crypto.randomUUID(),
    userName,
    normal: { ...dollFigureViewOf(standing.set.normal, overlayKey), count: standing.normal },
    super: { ...dollFigureViewOf(standing.set.super, overlayKey), count: standing.super },
  })
}

/**
 * いまの人形の点数のランキング（上位 DOLL_RANKING_LIMIT 人）を、合成ページへ押し出す。
 *
 * @throws DollChangeError いまの人形が選ばれていない場合
 * @throws Error 名前の分からない人がいる・オーバーレイ用キーが無い・配送先が失敗した場合
 */
export const showDollRanking = async (env: DollAwardEnv): Promise<void> => {
  const ranking = await readDollRanking(env.DB, DOLL_RANKING_LIMIT)
  const overlayKey = await loadDollOverlayKey(env)
  await pushDollAward(env.ALERTS, {
    type: 'ranking',
    id: crypto.randomUUID(),
    normal: dollFigureViewOf(ranking.set.normal, overlayKey),
    super: dollFigureViewOf(ranking.set.super, overlayKey),
    entries: ranking.entries.map(({ rank, userName, normal, super: superCount, points }) => ({ rank, userName, normal, super: superCount, points })),
  })
}
