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
}

/** プレビューで流す紹介（Worker が返す形と同じ。歴史は材料に無かったものとして空にしてある） */
export const demoTownTourIntro: TownTourIntro = {
  article: { title: '千代田区', url: 'https://ja.wikipedia.org/wiki/%E5%8D%83%E4%BB%A3%E7%94%B0%E5%8C%BA' },
  tour: {
    location: '東京都の中心部にあり、皇居を囲むように広がる区です。',
    nameOrigin: '江戸城の別名「千代田城」に由来します。',
    history: '',
    specialty: '神田神保町には、古書店が軒を連ねる街並みがあります。',
    surprise: '昼間は多くの人が働きに来ますが、住んでいる人は少ない区です。',
  },
}

/** 紹介が届くまでの待ち時間（ミリ秒）。Worker に作らせたときの実測（2.7〜5.1秒）に合わせる */
export const DEMO_INTRO_DELAY_MS = 3000

/** 次の1件を流しはじめるまでの間隔（ミリ秒）。1件を流し終える長さ（4項目でおよそ33秒）より長くする */
export const DEMO_TOWN_TOUR_INTERVAL_MS = 40000
