/**
 * 市町村紹介の呼び出し（合成ページの素材「市町村紹介」へ押し出す中身）の組み立て（issue #229）
 *
 * レイドやキーワード（!darts など）のトリガー、管理画面の試し再生で、市町村を1つ引き、冒頭に出す一文を添えて押し出す。
 * 押し出すのは市町村と一文だけで、紹介そのものは素材が受け取ってから GET /api/overlay/town-tour?code= で作らせる
 * （Twitch の Webhook の中では LLM の待ち時間が収まらないため。.claude/rules/town-tour.md）。
 *
 * 一覧（towns.json）は src/town-tour/ にあり、合成ページと同じものを読む（Worker から src/ を読み込む例外）。
 */
import towns from '../src/town-tour/towns.json'
import type { TownTourOccasion } from './alert-event'

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
}

/** 冒頭の一文を決めるきっかけ。demo は管理画面の試し再生で、相手を持たない */
export type TownTourCaller = { occasion: TownTourOccasion; userName: string } | { occasion: 'demo' }

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

/** 市町村と、きっかけから決まる冒頭の一文を組み合わせて、押し出す中身にする */
export const townTourCallOf = (town: Town, caller: TownTourCaller): TownTourCall => {
  const place = `${town.prefecture}${town.county}${town.name}`
  const headline = ((): string => {
    switch (caller.occasion) {
      case 'raid':
        return `${caller.userName}さんのレイドを記念して、本日は${place}をご紹介します`
      case 'keyword':
        return `${caller.userName}さんのダーツが刺さったのは、${place}でした`
      case 'demo':
        return `試し再生: 本日は${place}をご紹介します`
    }
  })()
  return { ...town, headline }
}
