/**
 * テキストの入力欄の値の変換（アプリのページ・下部バーとWorkerのあいだ）
 *
 * 検証は Worker（worker/text.ts）だけが持ち、画面は返ってきた問題点を読める文にして並べるだけにする
 * （src/overlay/form.ts の describeOverlayProblem と同じ分け方）。
 *
 * 入力欄の中身（書きかけ）は手動／自動に関わらず本文を持ち、Worker へ送るときに自動なら本文を外す（toTextInput。issue #295）。
 * 自動のテキストの本文は LLM が書くので、画面が読み込んだときの古い本文で上書きしないためである。
 * 注意: 書きかけの本文を書き換えたら手動にする（editBody）。自動の最中に手で書き換えたら手動に切り替える約束（方針11）を、
 *   アプリのページと下部バーで同じ形にするためである。
 */
import { errorMessage } from '@/admin/page-actions'
import { ApiError } from '../core/api'
import type { TextInput } from './api'
import type { TextEntry, TextMode } from './entry'

/** テキスト1件の入力欄の中身。手動／自動に関わらず本文を持つ（自動でもいまの本文を見せ、書き換えたら手動にするため） */
export interface TextDraft {
  readonly name: string
  readonly mode: TextMode
  readonly body: string
  readonly instruction: string
}

/** 保存済みのテキストから、入力欄の中身を作る */
export const draftOf = ({ name, mode, body, instruction }: TextEntry): TextDraft => ({ name, mode, body, instruction })

/** 入力欄の中身を、Worker へ送る形にする。自動なら本文を送らない */
export const toTextInput = ({ name, mode, body, instruction }: TextDraft): TextInput =>
  mode === 'auto' ? { name, mode, instruction } : { name, mode, body, instruction }

/** 書きかけの本文を書き換える。自動の最中でも手動に切り替える（人が書いた文を機械に上書きさせないため） */
export const editBody = (draft: TextDraft, body: string): TextDraft => ({ ...draft, mode: 'manual', body })

/** Workerが返す問題点の先頭に付く項目の名前を、画面の言い方にする */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: '名前',
  body: '本文',
  mode: '書き方',
  instruction: '指示文',
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
