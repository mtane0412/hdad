/**
 * 人形のページの入力欄の値の変換と、失敗の表示
 *
 * 入力欄の書きかけ（DollDraft）と、Worker へ送る形（DollSetInput）を行き来させ、Worker が返した問題点を画面の言い方にする。
 * 値の検証は Worker（worker/doll.ts）だけが持つので、ここでは確かめない（空欄もそのまま送り、返ってきた問題点を並べる）。
 */
import { errorMessage } from '@/admin/page-actions'
import { ApiError } from '@/core/api'
import type { DollSetInput } from './api'
import type { DollSet } from './doll'

/** 人形の組の入力欄の書きかけ。形は送る形と同じ */
export type DollDraft = DollSetInput

/** 何も書いていない入力欄 */
export const EMPTY_DOLL_DRAFT: DollDraft = { normal: { name: '', mediaId: '' }, super: { name: '', mediaId: '' } }

/** 保存済みの組を、入力欄の書きかけにする */
export const draftOf = (set: DollSet): DollDraft => ({ normal: set.normal, super: set.super })

export const sameDraft = (left: DollDraft, right: DollDraft): boolean =>
  left.normal.name === right.normal.name &&
  left.normal.mediaId === right.normal.mediaId &&
  left.super.name === right.super.name &&
  left.super.mediaId === right.super.mediaId

/** Worker が返す問題点の先頭に付く項目の名前を、画面の言い方にする */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  normal: 'ふつうの人形',
  'normal.name': 'ふつうの人形の名前',
  'normal.mediaId': 'ふつうの人形の画像',
  super: 'スーパー人形',
  'super.name': 'スーパー人形の名前',
  'super.mediaId': 'スーパー人形の画像',
}

/** Worker が問題点の先頭に付ける項目の名前（normal.name: の形） */
const PROBLEM_FIELD = /^([a-zA-Z.]+)(?=:)/

/** 失敗を画面に出す行にする。検証の問題点は、項目の名前を画面の言い方にして1行ずつ並べる */
export const dollFailureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? [
        '人形に問題があります。直してから保存し直してください',
        ...error.problems.map((problem) => `・${problem.replace(PROBLEM_FIELD, (field: string) => FIELD_LABELS[field] ?? field)}`),
      ]
    : [errorMessage(error)]
