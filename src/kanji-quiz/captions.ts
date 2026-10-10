/**
 * 漢字クイズの画面に出す文言
 *
 * 級の見出し（「漢検○級」）・出題させた人（「○○さんからの出題」）・正解の読みの並べ方・最初の正解者（「○○さん 正解！」）と、
 * 時間切れで配信を止めるまでの帯の文言（issue #302）を決める。
 * 描くのは view.ts で、ここは文言だけを受け持つ（テストできるよう canvas を持ち込まない）。
 */
import { kankenGradeLabel, type KankenGrade } from './grade'
import type { KanjiQuizStopBanner } from './scene'

/** 正解の読みが複数あるときの区切り */
const READING_SEPARATOR = '／'

/** 級の見出し（「漢検準2級」など） */
export const gradeHeadlineOf = (grade: KankenGrade): string => `漢検${kankenGradeLabel(grade)}`

/** 出題させた人の一文。試し再生（交換した人がいない）なら null */
export const requesterLineOf = (requesterName: string | null): string | null => (requesterName === null ? null : `${requesterName}さんからの出題`)

/** 正解の読みを1行に並べる */
export const answerLineOf = (readings: readonly string[]): string => readings.join(READING_SEPARATOR)

/** 最初の正解者の一文（issue #301） */
export const winnerLineOf = (userName: string): string => `${userName}さん 正解！`

/** 配信を止めるまでの帯の文言（issue #302） */
export const stopBannerLineOf = (banner: KanjiQuizStopBanner): string => {
  switch (banner.kind) {
    case 'countdown':
      return `配信終了まで ${banner.remainingSeconds}秒`
    case 'stopping':
      return '配信を終了します'
    case 'rehearsal':
      return '試し再生なので配信は止めません'
    case 'cancelled':
      return '配信の停止は取り消されました'
  }
}
