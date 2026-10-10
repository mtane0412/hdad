/**
 * 漢検（日本漢字能力検定）の級
 *
 * 漢字クイズ（issue #300）は問題ごとに級を持ち、トリガーの動作で級ごとの出題の重みを決め、合成ページに「漢検○級」と出す。
 * 級は 10級〜1級（準2級・準1級を含む）の12段階で、やさしい順に並べる。
 * 出題の重みは12の級すべてに0〜100の整数を持ち、級が選ばれる確率は「その級の重み ÷ 重みの合計」になる（0の級は出さない）。
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

/** 級ごとの出題の重み。12の級すべてを持つ */
export type KankenGradeWeights = Readonly<Record<KankenGrade, number>>

/** 1つの級に付けられる重みの上限 */
export const MAX_KANKEN_GRADE_WEIGHT = 100

/** 12の級それぞれに値を求め、級をキーにした対応にする（重みの数と入力欄の文字列の行き来に使う） */
export const mapKankenGrades = <T>(valueOf: (grade: KankenGrade) => T): Record<KankenGrade, T> => ({
  '10': valueOf('10'),
  '9': valueOf('9'),
  '8': valueOf('8'),
  '7': valueOf('7'),
  '6': valueOf('6'),
  '5': valueOf('5'),
  '4': valueOf('4'),
  '3': valueOf('3'),
  pre2: valueOf('pre2'),
  '2': valueOf('2'),
  pre1: valueOf('pre1'),
  '1': valueOf('1'),
})

/** 指定した級だけを出す重み（その級を1、ほかを0）。試し再生と、級1つだけで保存されていた設定の読み出しに使う */
export const singleGradeWeights = (grade: KankenGrade): KankenGradeWeights => mapKankenGrades((each) => (each === grade ? 1 : 0))

/**
 * 値が級ごとの出題の重みか。12の級すべてに0〜上限の整数を持ち、ほかの項目を持たず、1つ以上の級が1以上であること。
 *
 * 注意: すべて0だと出せる級が無いので重みとみなさない（出題のときに初めて気づくのでは遅いため、保存の時点で拒む）。
 */
export const isKankenGradeWeights = (value: unknown): value is KankenGradeWeights => {
  if (typeof value !== 'object' || value === null) return false
  const entries = Object.entries(value)
  if (entries.length !== KANKEN_GRADES.length) return false
  const isWeight = (weight: unknown): weight is number =>
    typeof weight === 'number' && Number.isInteger(weight) && weight >= 0 && weight <= MAX_KANKEN_GRADE_WEIGHT
  // 項目の数が級の数と同じで、どれも既知の級なら、12の級がちょうど1つずつそろっている
  const valid = entries.every(([grade, weight]) => isKankenGrade(grade) && isWeight(weight))
  return valid && entries.some(([, weight]) => isWeight(weight) && weight > 0)
}
