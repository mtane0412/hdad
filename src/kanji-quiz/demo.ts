/**
 * デモ用のサンプル（?demo=true）
 *
 * ふだんの漢字クイズはチャンネルポイントの交換か、トリガー画面の試し再生で出題されたときだけ流れるので、それ以外のあいだは何も映らない。
 * それでは OBS での配置や見栄えを決められないため、管理画面のプレビューでは Worker に接続せず、決まった出題を順にくり返し流す
 * （ツイスターの src/twister/demo.ts と同じ考え方）。読みが1つの問題と複数の問題を並べ、答えの出し方の違いが分かるようにする。
 */
import type { KanjiQuizCall } from './call'
import { KANJI_QUIZ_TOTAL_MS } from './scene'

/** プレビューで流す出題 */
export const DEMO_KANJI_QUIZ_CALLS: readonly KanjiQuizCall[] = [
  {
    id: 'demo-keidai',
    problem: { word: '境内', readings: ['けいだい'], grade: '6', explanation: '神社や寺の敷地の中。' },
    requesterName: '視聴者',
  },
  {
    id: 'demo-ichiba',
    problem: { word: '市場', readings: ['いちば', 'しじょう'], grade: '9', explanation: '物を売り買いする場所は「いちば」。経済の取引の場は「しじょう」とも読む。' },
    requesterName: '視聴者',
  },
]

/** プレビューで次の出題を流す間隔（ミリ秒）。1回の出題を流しきってから、少し間を置く */
export const DEMO_KANJI_QUIZ_INTERVAL_MS = KANJI_QUIZ_TOTAL_MS + 2_000
