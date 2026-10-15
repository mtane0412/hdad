/**
 * 漢字クイズの画面に出す文言
 *
 * 級の見出し（「漢検○級」）・出題させた人（「○○さんからの出題」）・正解の読みの並べ方・最初の正解者（「○○さん 正解！」）・
 * 不正解の回答（「直前の回答：○○（○○さん）」）と、
 * 時間切れで配信を止めるまでの帯の文言（issue #302）と、誰も正解しなければ配信が終わることを出題の前から告げる一文を決める。
 * 描くのは view.ts で、ここは文言だけを受け持つ（テストできるよう canvas を持ち込まない）。
 */
import { kankenGradeLabel, type KankenGrade } from './grade'
import { ANSWER_LIMIT_MS, type KanjiQuizStopBanner } from './scene'

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

/** 合成ページが出す不正解の回答（直前の回答）の一文。答えた人の名前を添える */
export const wrongAnswerLineOf = ({ userName, answer }: { readonly userName: string; readonly answer: string }): string =>
  `直前の回答：${answer}（${userName}さん）`

const MS_PER_SECOND = 1_000

/**
 * 誰も正解しなければ配信が終わることを告げる一文。級の場面と出題の場面に出し、視聴者に賭けているものを知らせる。
 * 停止の予告（猶予の残り秒数・「終了します」）とは別で、猶予のあいだには出さない（docs/decisions/kanji-quiz.md）
 */
export const stakesLineOf = (): string => `${ANSWER_LIMIT_MS / MS_PER_SECOND}秒以内に誰も正解できなければ配信終了`

/** 配信を止める時刻の帯の文言（issue #302）。本番は予告せずに止めるので、出すのは試し再生で止めないことだけ */
export const stopBannerLineOf = (banner: KanjiQuizStopBanner): string => {
  switch (banner.kind) {
    case 'rehearsal':
      return '試し再生なので配信は止めません'
  }
}
