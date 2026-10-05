/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんの紹介はトリガー（レイド・キーワード）か、トリガー画面の試し再生で呼び出されたときだけ流れるので、
 * それ以外のあいだは何も映らない。それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは
 * Worker に接続せず、決まった1件をくり返し流す（作業机の src/task-desk/demo.ts と同じ考え方）。
 *
 * 紹介は Worker に作らせず、ここに書いた文を、作らせたときと同じくらい待ってから届いたものとして扱う。
 */
import type { TownTourCall, TownTourIntro } from './tour'

/** プレビューで流す呼び出し（東京都千代田区。地図のコードは一覧と同じ 13101） */
export const demoTownTourCall: TownTourCall = {
  code: '13101',
  prefecture: '東京都',
  county: '',
  name: '千代田区',
  headline: 'プレビュー: 視聴者さんのレイドを記念して、本日は東京都千代田区をご紹介します',
  // プレビューは配信者の音声を読めない（オーバーレイ用キーを持たない）ので、どの枠も鳴らさない
  sound: {
    slots: { bgm: null, opening: null, zoom: null, landing: null, item: null, closing: null },
    bgmVolume: 0,
    effectVolume: 0,
  },
  // 千代田区の人口と面積（src/town-tour/stats.json と同じ値）。見ている人数は、配置を決めるときに挑む文まで見えるよう置いておく
  population: 69139,
  area: 11.66,
  audience: { kind: 'raid', count: 50 },
}

/** プレビューで流す紹介（Worker が返す形と同じ） */
export const demoTownTourIntro: TownTourIntro = {
  article: { title: '千代田区', url: 'https://ja.wikipedia.org/wiki/%E5%8D%83%E4%BB%A3%E7%94%B0%E5%8C%BA' },
  tour: {
    hook: '住む人より働きに来る人が多い区',
    points: [
      { label: '名前の由来', text: '江戸城の別名「千代田城」に由来します。' },
      { label: '本の街', text: '神田神保町には、古書店が軒を連ねる街並みがあります。' },
      { label: '昼と夜', text: '昼間は多くの人が働きに来ますが、住んでいる人は少ない区です。' },
    ],
    cue: '千代田区で働いたことはありますか？',
  },
}

/** 紹介が届くまでの待ち時間（ミリ秒）。Worker に作らせたときの実測（2.7〜5.1秒）に合わせる */
export const DEMO_INTRO_DELAY_MS = 3000

/** 次の1件を流しはじめるまでの間隔（ミリ秒）。1件を流し終える長さ（大見出しと3項目でおよそ37秒）より長くする */
export const DEMO_TOWN_TOUR_INTERVAL_MS = 40000
