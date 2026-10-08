/**
 * テキストの入力欄の値の変換（アプリのページ・下部バーとWorkerのあいだ）
 *
 * 検証は Worker（worker/text.ts）だけが持ち、画面は返ってきた問題点を読める文にして並べるだけにする
 * （src/overlay/form.ts の describeOverlayProblem と同じ分け方）。
 */
import { errorMessage } from '@/admin/page-actions'
import { ApiError } from '../core/api'

/** Workerが返す問題点の先頭に付く項目の名前を、画面の言い方にする */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: '名前',
  body: '本文',
}

/** Workerが問題点の先頭に付ける項目の名前（name: の形） */
const PROBLEM_FIELD = /^([a-z]+)(?=:)/

/**
 * 失敗を画面に出す行にする。検証の問題点は、項目の名前を画面の言い方にして1行ずつ並べる。
 */
export const textFailureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? [
        'テキストに問題があります。直してから保存し直してください',
        ...error.problems.map((problem) => `・${problem.replace(PROBLEM_FIELD, (field: string) => FIELD_LABELS[field] ?? field)}`),
      ]
    : [errorMessage(error)]
