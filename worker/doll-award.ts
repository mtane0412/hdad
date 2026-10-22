/**
 * 人形を渡し、渡せたら合成ページの素材「人形の獲得」へ押し出す
 *
 * 人形を自動で渡す経路（トリガーの動作「人形を渡す」の worker/alert-actions.ts と、ゲームの正解者の worker/doll-prize.ts）は、
 * どちらもこの grantDolls を通す。台帳への書き込みは worker/doll-store.ts の changeDolls が行い、ここは書けたときに
 * 「誰が・どの人形を・いくつ」を押し出す。配信者が管理画面から手で増減させたもの（訂正を含む）は演出にしないので、ここを通さない。
 *
 * 呼び出し（DollAwardCall）は、視聴者の名前と、いまの人形のうち渡した種類の名前と画像の URL（オーバーレイ用キーつき）を持つ。
 * 同じ素材には、1人ぶんの所持数（DollStandingCall）とランキング（DollRankingCall）も押し出す（worker/doll-standing.ts）。
 * 3つを type で見分ける DollAwardMessage の形は、合成ページの読み取り（src/doll-award/call.ts の parseDollAwardMessage）と合わせる。
 * worker/ から src/ の型は読み込まない約束なので、ここで持ち直す。
 *
 * 注意: 渡せなかったとき（いまの人形が無いなど）は押し出さずに投げる。記録は呼び出し側が行う（経路ごとに文面が違うため）。
 * 注意: 渡せたあとの押し出しの失敗（オーバーレイ用キーが無い・配送先の失敗）は投げずに `doll-award-failed` として記録する（記録にも失敗したら Worker のログに残す）。
 *   渡したこと（台帳）は取り消さない。演出が出なくても、所持は管理画面で確かめられるため。
 * 注意: 同じきっかけの ID の再送（changeDolls が duplicate を返す）では押し出さない（演出を2度出さない）。
 */
import { mediaPath } from './alert-config'
import { pushDollAward, type AlertChannelNamespace } from './alert-channel'
import type { DollFigure, DollKind } from './doll'
import { changeDolls, readDollSets, type DollChange } from './doll-store'
import type { Env } from './http'
import { loadOverlayKey } from './overlay-key'
import { recordFailure } from './stats-store'

/** 人形1種類ぶんの名前と、画像を読む URL（/api/media/<ID>?key=<オーバーレイ用キー>） */
export interface DollFigureView {
  readonly name: string
  readonly imageUrl: string
}

/** 1回の人形の獲得 */
export interface DollAwardCall {
  readonly type: 'award'
  /** 獲得ごとの識別子（台帳のきっかけの ID） */
  readonly id: string
  /** 渡した視聴者の表示名 */
  readonly userName: string
  readonly kind: DollKind
  /** 渡した個数（1 以上） */
  readonly count: number
  /** 渡した人形の名前と画像 */
  readonly doll: DollFigureView
}

/** 1人ぶんの、いまの人形の所持数（チャットの !人形 と /viewers/ から出す） */
export interface DollStandingCall {
  readonly type: 'standing'
  /** 表示ごとの識別子 */
  readonly id: string
  /** 視聴者の表示名 */
  readonly userName: string
  /** いまの人形の種類ごとの名前・画像と、持っている数（0 以上） */
  readonly normal: DollFigureView & { readonly count: number }
  readonly super: DollFigureView & { readonly count: number }
}

/** ランキングの1人ぶん（ユーザーID は配信画面に要らないので渡さない） */
export interface DollRankingCallEntry {
  readonly rank: number
  readonly userName: string
  readonly normal: number
  readonly super: number
  readonly points: number
}

/** いまの人形の所持数のランキング（チャットの !人形ランキング と /dolls/ から出す） */
export interface DollRankingCall {
  readonly type: 'ranking'
  /** 表示ごとの識別子 */
  readonly id: string
  /** いまの人形の種類ごとの名前と画像 */
  readonly normal: DollFigureView
  readonly super: DollFigureView
  /** 点数の高い順。0 人のこともある */
  readonly entries: readonly DollRankingCallEntry[]
}

/** 合成ページの素材「人形の獲得」へ押し出すもの */
export type DollAwardMessage = DollAwardCall | DollStandingCall | DollRankingCall

/** 押し出しに要るもの */
export type DollAwardEnv = Pick<Env, 'DB' | 'STORE'> & { readonly ALERTS: AlertChannelNamespace }

/**
 * 合成ページで人形の画像を読むためのオーバーレイ用キーを読む。
 *
 * @throws Error 未発行の場合（画像の URL を作れないので、押し出しても画像が出ない）
 */
export const loadDollOverlayKey = async (env: Pick<DollAwardEnv, 'STORE'>): Promise<string> => {
  const overlayKey = await loadOverlayKey(env.STORE)
  if (overlayKey === null) throw new Error('オーバーレイ用キーが未発行のため、人形の画像を合成ページで読めません')
  return overlayKey
}

/** 人形1種類を、合成ページで名前と画像を出せる形にする */
export const dollFigureViewOf = (figure: DollFigure, overlayKey: string): DollFigureView => ({
  name: figure.name,
  imageUrl: mediaPath(figure.mediaId, overlayKey),
})

/** 渡せた1件を、合成ページへ押し出す呼び出しにする。人形の名前と画像は、渡した組（いまの人形）から引く */
const dollAwardCallOf = async (env: DollAwardEnv, change: DollChange, userName: string, setId: number): Promise<DollAwardCall> => {
  const overlayKey = await loadDollOverlayKey(env)
  const set = (await readDollSets(env.DB)).find(({ id }) => id === setId)
  // 渡した直後に組を消すことはできない（台帳に記録のある組は消させない）ので、見つからないのは想定外
  if (set === undefined) throw new Error(`渡した人形の組（${String(setId)}）が見つかりません`)
  return {
    type: 'award',
    id: change.sourceId,
    userName,
    kind: change.kind,
    count: change.delta,
    doll: dollFigureViewOf(set[change.kind], overlayKey),
  }
}

/**
 * 視聴者にいまの人形を渡し、渡せたら合成ページの素材「人形の獲得」へ押し出す。
 *
 * @param change 渡す1件（delta は正の数。userName は演出と失敗のメッセージにも出す）
 * @throws DollChangeError いまの人形が選ばれていないなど、渡せなかった場合（押し出さない）
 */
export const grantDolls = async (env: DollAwardEnv, now: number, change: DollChange): Promise<void> => {
  const { userName } = change
  const result = await changeDolls(env.DB, change, now)
  if (result.status === 'duplicate') return
  try {
    await pushDollAward(env.ALERTS, await dollAwardCallOf(env, change, userName, result.holding.setId))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try {
      await recordFailure(env.DB, 'doll-award-failed', `${userName}さんに人形を渡しましたが、獲得の演出を出せませんでした: ${reason}`, now)
    } catch (failure) {
      // 記録にも失敗した（D1 の不調）。ここで投げると、渡せたのに呼び出し側が「渡せなかった」と記録してしまうので、
      // Worker のログに残して続ける（worker/doll-prize.ts の grantDollPrize と同じ扱い）
      console.error(failure)
    }
  }
}
