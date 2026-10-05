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
 * 一覧（towns.json）と人口・面積の表（stats.json）は src/town-tour/ にあり、合成ページと同じものを読む（Worker から src/ を読み込む例外）。
 */
import stats from '../src/town-tour/stats.json'
import towns from '../src/town-tour/towns.json'
import type { TownTourAudience } from '../src/town-tour/scale'
import type { TownTourTrigger } from './alert-event'
import type { TownTourPlaybackSound } from './town-tour-sound'

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
}

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

/** 冒頭の一文を決めるきっかけ。demo は管理画面の試し再生で、相手を持たない */
export type TownTourCaller = TownTourTrigger | { occasion: 'demo' }

/**
 * 一覧から市町村を1つ引く。
 *
 * @param random 0以上1未満の乱数を返す関数（Math.random。テストで差し替えられるよう受け取る）
 */
export const pickTown = (random: () => number): Town => {
  const town = towns[Math.floor(random() * towns.length)]
  if (town === undefined) throw new Error('市町村の一覧が空です')
  return town
}

/**
 * 市町村と、きっかけから決まる冒頭の一文と、鳴らす音と、人口・面積・いま見ている人数を組み合わせて、押し出す中身にする
 *
 * いま見ている人数は、レイドなら最後に記録した同接にレイドの人数を足した数（同接の記録が無ければレイドの人数だけ）、
 * キーワードと試し再生なら最後に記録した同接（配信中でなければ null）にする。
 *
 * @param liveViewers 配信中の配信で最後に記録した同接（worker/stats-store.ts の latestViewerCount）。配信中でなければ null
 * @param quizId 冒頭のクイズの出題の識別子（crypto.randomUUID。テストで決まった値を渡せるよう受け取る）
 * @throws 人口と面積の表に無いコードの市町村のとき（一覧と表の1対1は src/town-tour/towns.test.ts が検証する）
 */
export const townTourCallOf = (
  town: Town,
  caller: TownTourCaller,
  sound: TownTourPlaybackSound,
  liveViewers: number | null,
  quizId: string,
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
  }
}
