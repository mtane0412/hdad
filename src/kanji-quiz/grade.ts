/**
 * 漢検（日本漢字能力検定）の級
 *
 * 漢字クイズ（issue #300）は問題ごとに級を持ち、トリガーの動作で出題する級を選び、合成ページに「漢検○級」と出す。
 * 級は 10級〜1級（準2級・準1級を含む）の12段階で、やさしい順に並べる。
 *
 * 注意: 合成ページ・管理画面・Worker（動作の設定の検証と出題）が同じ一覧を使う。Worker から src/ を読み込む例外の1つで、
 * 級の一覧を2か所に書き分けないためである（.claude/rules/kanji-quiz.md）。
 * 注意: 値は保存される設定に入るので、画面の言い方（「準2級」）ではなく変わらない識別子（pre2）にする。
 */

/** 級の識別子。やさしい順 */
export const KANKEN_GRADES = ['10', '9', '8', '7', '6', '5', '4', '3', 'pre2', '2', 'pre1', '1'] as const

export type KankenGrade = (typeof KANKEN_GRADES)[number]

/** 準のつく級の識別子の頭 */
const PRE_PREFIX = 'pre'

/** 値が級の識別子か */
export const isKankenGrade = (value: unknown): value is KankenGrade => typeof value === 'string' && (KANKEN_GRADES as readonly string[]).includes(value)

/** 級を画面の言い方（「準2級」「10級」）にする */
export const kankenGradeLabel = (grade: KankenGrade): string =>
  grade.startsWith(PRE_PREFIX) ? `準${grade.slice(PRE_PREFIX.length)}級` : `${grade}級`
