/**
 * 名誉町民の認定証の文面（issue #253）
 *
 * レイドで紹介した締めに、レイド元をその市町村の名誉町民に任命する認定証を出す。レイドした側がスクリーンショットで持ち帰れる
 * お土産にするためのもの。ここは呼び出し（名誉町民にする相手と市町村）と日付から文面を組み立てるだけを受け持つ
 * （描くのは view.ts、出す時刻は timeline.ts）。
 *
 * 注意: 文面はコードで組み立て、LLM に作らせない。ただし任命理由（reason）だけは、レイド元との共通点（issue #275）と一緒に LLM が書いたものを
 * そのまま添える（Worker が長さと結び方を確かめてから返す。worker/town-bond.ts）。町の公式なものと誤解されないよう、自治体の名義や町章は使わず、
 * 発行者はこの配信（ISSUER）にする。
 * 注意: 名誉町民にする相手を決めるのは Worker（worker/town-tour-call.ts。レイドはレイド元、キーワードは配信者本人、試し再生は入力した配信者か見本の名前）。
 */
import type { TownTourCall } from './tour'

/** 発行者。自治体の名義と誤解されないよう、この配信の企画であることを書く */
const ISSUER = 'HDAD 市町村紹介'

/** 日付を数える時間帯。和暦の認定証なので、配信画面を開いた環境に関わらず日本時間の日付にする */
const TIME_ZONE = 'Asia/Tokyo'

/** 和暦の日付（「令和8年10月5日」）にする書式 */
const japaneseDateFormat = new Intl.DateTimeFormat('ja-JP-u-ca-japanese', {
  timeZone: TIME_ZONE,
  era: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})

/** 認定証の文面 */
export interface Certificate {
  /** 表題（「名誉町民証」。市・村・区では名誉市民証・名誉村民証・名誉区民証） */
  readonly title: string
  /** 宛名（「山田花子 様」） */
  readonly holder: string
  /** 任命の文（「あなたを北海道石狩郡当別町の名誉町民に任命します」） */
  readonly appointment: string
  /** 任命の理由（「〜につき」）。レイド元との共通点を作れなかった回は null で、出さない */
  readonly reason: string | null
  /** 和暦の日付 */
  readonly date: string
  readonly issuer: string
}

/**
 * 呼び出しから認定証の文面を組み立てる。
 *
 * 「町民」の「町」は市町村の名前の最後の字（市・町・村・区）にする（tour.ts の「この町、実は…」と同じ考え方）。
 *
 * @param issuedAt 認定証の日付にする時刻（ミリ秒。Date.now() と同じ基準）
 * @param reason 任命の理由（紹介の bond.certificateReason）。共通点が無い回は null
 * @returns 名誉町民にする相手がいない呼び出しなら null
 */
export const certificateOf = (
  call: Pick<TownTourCall, 'prefecture' | 'county' | 'name' | 'honoraryCitizen'>,
  issuedAt: number,
  reason: string | null,
): Certificate | null => {
  if (call.honoraryCitizen === null) return null
  const honorary = `名誉${call.name.slice(-1)}民`
  return {
    title: `${honorary}証`,
    holder: `${call.honoraryCitizen} 様`,
    appointment: `あなたを${call.prefecture}${call.county}${call.name}の${honorary}に任命します`,
    reason,
    date: japaneseDateFormat.format(issuedAt),
    issuer: ISSUER,
  }
}
