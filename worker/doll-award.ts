/**
 * 人形を渡し、渡せたら合成ページの素材「人形の獲得」へ押し出す
 *
 * 人形を自動で渡す経路（トリガーの動作「人形を渡す」の worker/alert-actions.ts と、ゲームの正解者の worker/doll-prize.ts）は、
 * どちらもこの grantDolls を通す。台帳への書き込みは worker/doll-store.ts の changeDolls が行い、ここは書けたときに
 * 「誰が・どの人形を・いくつ」を押し出す。配信者が管理画面から手で増減させたもの（訂正を含む）は演出にしないので、ここを通さない。
 *
 * 呼び出し（DollAwardCall）は、視聴者の名前と、いまの人形のうち渡した種類の名前と画像の URL（オーバーレイ用キーつき）を持つ。
 * 形は合成ページの読み取り（src/doll-award/call.ts の parseDollAwardCall）と合わせる。worker/ から src/ の型は読み込まない約束なので、ここで持ち直す。
 *
 * 注意: 渡せなかったとき（いまの人形が無いなど）は押し出さずに投げる。記録は呼び出し側が行う（経路ごとに文面が違うため）。
 * 注意: 渡せたあとの押し出しの失敗（オーバーレイ用キーが無い・配送先の失敗）は投げずに `doll-award-failed` として記録する（記録にも失敗したら Worker のログに残す）。
 *   渡したこと（台帳）は取り消さない。演出が出なくても、所持は管理画面で確かめられるため。
 * 注意: 同じきっかけの ID の再送（changeDolls が duplicate を返す）では押し出さない（演出を2度出さない）。
 */
import { mediaPath } from './alert-config'
import { pushDollAward, type AlertChannelNamespace } from './alert-channel'
import type { DollKind } from './doll'
import { changeDolls, readDollSets, type DollChange } from './doll-store'
import type { Env } from './http'
import { loadOverlayKey } from './overlay-key'
import { recordFailure } from './stats-store'

/** 1回の人形の獲得 */
export interface DollAwardCall {
  /** 獲得ごとの識別子（台帳のきっかけの ID） */
  readonly id: string
  /** 渡した視聴者の表示名 */
  readonly userName: string
  readonly kind: DollKind
  /** 渡した個数（1 以上） */
  readonly count: number
  /** 渡した人形の名前と、画像を読む URL（/api/media/<ID>?key=<オーバーレイ用キー>） */
  readonly doll: { readonly name: string; readonly imageUrl: string }
}

/** 押し出しに要るもの */
type DollAwardEnv = Pick<Env, 'DB' | 'STORE'> & { readonly ALERTS: AlertChannelNamespace }

/** 渡せた1件を、合成ページへ押し出す呼び出しにする。人形の名前と画像は、渡した組（いまの人形）から引く */
const dollAwardCallOf = async (env: DollAwardEnv, change: DollChange, userName: string, setId: number): Promise<DollAwardCall> => {
  const overlayKey = await loadOverlayKey(env.STORE)
  if (overlayKey === null) throw new Error('オーバーレイ用キーが未発行のため、人形の画像を合成ページで読めません')
  const set = (await readDollSets(env.DB)).find(({ id }) => id === setId)
  // 渡した直後に組を消すことはできない（台帳に記録のある組は消させない）ので、見つからないのは想定外
  if (set === undefined) throw new Error(`渡した人形の組（${String(setId)}）が見つかりません`)
  const figure = set[change.kind]
  return {
    id: change.sourceId,
    userName,
    kind: change.kind,
    count: change.delta,
    doll: { name: figure.name, imageUrl: mediaPath(figure.mediaId, overlayKey) },
  }
}

/**
 * 視聴者にいまの人形を渡し、渡せたら合成ページの素材「人形の獲得」へ押し出す。
 *
 * @param change 渡す1件（delta は正の数）
 * @param userName 演出と失敗のメッセージに出す、渡す相手の表示名
 * @throws DollChangeError いまの人形が選ばれていないなど、渡せなかった場合（押し出さない）
 */
export const grantDolls = async (env: DollAwardEnv, now: number, change: DollChange, userName: string): Promise<void> => {
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
