/**
 * 市町村紹介の呼び出し（合成ページの素材「市町村紹介」へ押し出す中身）の組み立て（issue #229）
 *
 * レイドやキーワード（!darts など）のトリガー、管理画面の試し再生で、市町村を1つ引き、冒頭に出す一文を添えて押し出す。
 * 押し出すのは市町村と一文だけで、紹介そのものは素材が受け取ってから GET /api/overlay/town-tour?code= で作らせる
 * （Twitch の Webhook の中では LLM の待ち時間が収まらないため。.claude/rules/town-tour.md）。
 *
 * 演出で鳴らす音（issue #243）も一緒に押し出す。素材が受け取ったその場で始まりの音を鳴らせるよう、紹介とは別に先に渡す。
 *
 * 人口と面積（issue #250）も同梱した表（stats.json）から引いて押し出し、いま見ている人数と一緒に、素材が着地で大きさの文にする
 * （src/town-tour/scale.ts）。数字は LLM に作らせない。
 *
 * 冒頭の都道府県当てクイズ（issue #251）のために、出題の識別子と、都道府県を伏せた一文も一緒に押し出す。
 * 合成ページは出題の識別子で出題を開き（POST /api/overlay/town-tour/quiz）、チャットの正解者は同じ識別子で届く。
 *
 * 全国制覇マップ（issue #252）のために、紹介済みの市町村は除いて引き、これまでに紹介した市町村のコードと、
 * 流しきったら記録するきっかけと相手（試し再生は記録しないので null）も一緒に押し出す。記録するのは流しきった合成ページである
 * （POST /api/overlay/town-tour/visit）。
 *
 * 締めの名誉町民の認定証（issue #253）のために、名誉町民にする相手も一緒に押し出す。レイドはレイド元、キーワードは配信者本人、
 * 試し再生は入力したユーザー名の配信者（入力が無ければ見た目を確かめる見本の名前）にする。文面は合成ページが組み立てる（src/town-tour/certificate.ts）。
 *
 * 締めの共通点（issue #275）のために、レイド元とみなす配信者のログイン名と連れてきた人数も一緒に押し出す。Twitch の公開情報は
 * ここでは引かず、合成ページが紹介を頼んだときに Worker が引く（Webhook の中で Twitch を呼ばない約束。docs/decisions/town-tour.md）。
 * キーワードは配信者本人の動作確認用なので、本人をレイド元とみなし、制覇の記録には数えない。
 *
 * ナレーション（issue #255）のために、紹介を読み上げるかどうかも一緒に押し出す。読み上げるなら、合成ページは紹介が届いてから
 * 読み上げる文の合成を頼む（POST /api/overlay/town-tour/narration）。話者と速度は押し出さず、Worker が合成のときに設定から取る。
 *
 * 一覧（towns.json）と人口・面積の表（stats.json）は src/town-tour/ にあり、合成ページと同じものを読む（Worker から src/ を読み込む例外）。
 */
import stats from '../src/town-tour/stats.json'
import towns from '../src/town-tour/towns.json'
import type { TownTourAudience } from '../src/town-tour/scale'
import type { TownTourTrigger } from './alert-event'
import type { TownTourPlaybackSound } from './town-tour-sound'
import type { TownTourVisitOccasion } from './town-tour-visits'

/** コードから人口と面積を引く表。JSON のキーは文字列なので Map に移しておき、プロトタイプのキー（toString など）に当たらないようにする */
const statsByCode: ReadonlyMap<string, { population: number | null; area: number }> = new Map(Object.entries(stats))

/** 一覧の市町村（コードは全国地方公共団体コードの5桁。名前は一意でないので識別には使わない） */
export interface Town {
  code: string
  prefecture: string
  /** 郡（町村だけが持つ。市と区は空文字） */
  county: string
  name: string
}

/** 合成ページの素材「市町村紹介」へ押し出す中身 */
export interface TownTourCall extends Town {
  /** 冒頭に出す一文（「○○さんのレイドを記念して、本日は△△町をご紹介します」など） */
  headline: string
  /** 冒頭の都道府県当てクイズの出題の識別子。合成ページが出題を開くときと、正解者を受け取るときに使う */
  quizId: string
  /** クイズのあいだに出す一文。答えが分からないよう、都道府県と郡を伏せて市町村の名前だけにする */
  quizHeadline: string
  /** 演出の場面ごとに鳴らす音（音声のURL）と音量 */
  sound: TownTourPlaybackSound
  /** 住民基本台帳の人口。記録が無い村（北方領土の6村）は null */
  population: number | null
  /** 面積（km²） */
  area: number
  /** 人口と比べる、いま見ている人数。分からない（配信中でない）ときは null */
  audience: TownTourAudience | null
  /** これまでに紹介した市町村のコード（制覇マップに塗る） */
  visited: readonly string[]
  /** 流しきったら記録するきっかけと、冒頭で名前を出した相手。試し再生は記録しないので null */
  visit: { occasion: TownTourVisitOccasion; userName: string } | null
  /** 締めの認定証で名誉町民にする相手。認定証を出さないなら null */
  honoraryCitizen: string | null
  /**
   * 共通点（worker/town-bond.ts）を作らせるレイド元の配信者のログイン名と、連れてきた人数（レイドでなければ null）。
   * 共通点を作らせない（ユーザー名を入れない試し再生）なら null。合成ページは紹介を頼むときにこれを添える（issue #275）
   */
  raider: TownTourRaider | null
  /** 紹介をナレーションで読み上げるか（worker/town-tour-narration.ts の enabled） */
  narration: boolean
}

/** 共通点を作らせるレイド元の配信者 */
export interface TownTourRaider {
  /** ログイン名（Twitch の公開情報を引くのに使う） */
  login: string
  /** 連れてきた人数。レイドでなければ null */
  viewers: number | null
}

/** 試し再生の認定証で、名誉町民にする見本の名前 */
const DEMO_HONORARY_CITIZEN = 'レイド元の配信者'

/**
 * 都道府県当てクイズの最初の正解者の知らせ。呼び出しと同じ接続へ押し出すので、type で呼び出しと見分ける
 * （呼び出しは type を持たない）
 */
export interface TownTourAnswerMessage {
  type: 'answer'
  /** 正解者が決まった出題の識別子（呼び出しの quizId） */
  quizId: string
  /** 正解者の表示名 */
  userName: string
}

/**
 * 冒頭の一文を決めるきっかけ。demo は管理画面の試し再生で、ユーザー名が入っていればその配信者をレイド元とみなす（issue #275）。
 * レイドの人数も入っていれば、連れてきた人数として共通点の材料にする
 */
export type TownTourCaller =
  | TownTourTrigger
  | { occasion: 'demo'; raider: { userName: string; userLogin: string; viewers: number | null } | null }

/**
 * 一覧から、紹介済みの市町村を除いて1つ引く。すべて紹介済み（全国制覇の後）なら、一覧の全体から引く。
 *
 * @param random 0以上1未満の乱数を返す関数（Math.random。テストで差し替えられるよう受け取る）
 * @param visited これまでに紹介した市町村のコード（worker/town-tour-visits.ts の listTownTourVisits）
 */
export const pickTown = (random: () => number, visited: ReadonlySet<string>): Town => {
  const unvisited = towns.filter(({ code }) => !visited.has(code))
  const candidates = unvisited.length === 0 ? towns : unvisited
  const town = candidates[Math.floor(random() * candidates.length)]
  if (town === undefined) throw new Error('市町村の一覧が空です')
  return town
}

/**
 * 締めの認定証で名誉町民にする相手。レイドはレイド元、キーワードは配信者本人（レイド元とみなす。issue #275）、
 * 試し再生は入力したユーザー名の配信者で、入力が無ければ見本の名前
 */
const honoraryCitizenOf = (caller: TownTourCaller): string => {
  if (caller.occasion !== 'demo') return caller.userName
  return caller.raider?.userName ?? DEMO_HONORARY_CITIZEN
}

/** 共通点を作らせるレイド元。連れてきた人数はレイドだけが持つ */
const raiderOf = (caller: TownTourCaller): TownTourRaider | null => {
  switch (caller.occasion) {
    case 'raid':
      return { login: caller.userLogin, viewers: caller.viewers }
    case 'keyword':
      return { login: caller.userLogin, viewers: null }
    case 'demo':
      return caller.raider === null ? null : { login: caller.raider.userLogin, viewers: caller.raider.viewers }
  }
}

/**
 * 市町村と、きっかけから決まる冒頭の一文と、鳴らす音と、人口・面積・いま見ている人数を組み合わせて、押し出す中身にする
 *
 * いま見ている人数は、レイドなら最後に記録した同接にレイドの人数を足した数（同接の記録が無ければレイドの人数だけ）、
 * キーワードと試し再生なら最後に記録した同接（配信中でなければ null）にする。
 *
 * @param liveViewers 配信中の配信で最後に記録した同接（worker/stats-store.ts の latestViewerCount）。配信中でなければ null
 * @param quizId 冒頭のクイズの出題の識別子（crypto.randomUUID。テストで決まった値を渡せるよう受け取る）
 * @param visited これまでに紹介した市町村のコード（制覇マップに塗る）
 * @param narration 紹介をナレーションで読み上げるか
 * @throws 人口と面積の表に無いコードの市町村のとき（一覧と表の1対1は src/town-tour/towns.test.ts が検証する）
 */
export const townTourCallOf = (
  town: Town,
  caller: TownTourCaller,
  sound: TownTourPlaybackSound,
  liveViewers: number | null,
  quizId: string,
  visited: readonly string[],
  narration: boolean,
): TownTourCall => {
  const townStats = statsByCode.get(town.code)
  if (townStats === undefined) throw new Error(`人口と面積の表に無い市町村です: ${town.code}`)
  /** 冒頭の一文。place は市町村の呼び方（クイズのあいだは都道府県と郡を伏せる） */
  const headlineOf = (place: string): string => {
    switch (caller.occasion) {
      case 'raid':
        return `${caller.userName}さんのレイドを記念して、本日は${place}をご紹介します`
      case 'keyword':
        return `${caller.userName}さんのダーツが刺さったのは、${place}でした`
      case 'demo':
        return `試し再生: 本日は${place}をご紹介します`
    }
  }
  const audience = ((): TownTourAudience | null => {
    if (caller.occasion === 'raid') return { kind: 'raid', count: (liveViewers ?? 0) + caller.viewers }
    return liveViewers === null ? null : { kind: 'live', count: liveViewers }
  })()
  return {
    ...town,
    headline: headlineOf(`${town.prefecture}${town.county}${town.name}`),
    quizId,
    quizHeadline: headlineOf(town.name),
    sound,
    population: townStats.population,
    area: townStats.area,
    audience,
    visited,
    // 試し再生と、配信者本人の動作確認用のキーワードは制覇の記録に数えない（issue #275）
    visit: caller.occasion === 'raid' ? { occasion: caller.occasion, userName: caller.userName } : null,
    honoraryCitizen: honoraryCitizenOf(caller),
    raider: raiderOf(caller),
    narration,
  }
}
