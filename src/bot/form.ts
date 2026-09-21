/**
 * コマンドの入力欄の値の変換
 *
 * 入力欄の値はすべて文字列なので、保存の形（クールダウンは数値）との間で変換する。
 * 画面（bot-page.tsx）から分けてあるのは、変換の決まりだけを取り出してテストするため。
 *
 * 注意: ここで弾くのは「数値として読めない」場合だけにする。
 * 長さや範囲の検証はWorkerが行い、問題点をまとめて返す（画面とWorkerで決まりが二重にならないようにする）。
 */
import type { BotCommandItem } from './api'

/** 入力欄が持つ値。すべて文字列 */
export interface CommandDraft {
  name: string
  reply: string
  /** 空欄は0（毎回応答する）として扱う */
  cooldownSeconds: string
}

/** Workerが問題点の先頭に付ける位置（commands[0]. の形。番号は0始まり） */
const PROBLEM_POSITION = /^commands\[(\d+)\]\./

/** 保存済みのコマンドを、入力欄の値にする */
export const toDraft = (command: BotCommandItem): CommandDraft => ({
  name: command.name,
  reply: command.reply,
  cooldownSeconds: String(command.cooldownSeconds),
})

/**
 * 入力欄の値を、Workerへ送る形にする。
 *
 * コマンド名の前後の空白と、先頭の `!` は取り除く（貼り付けや入力のときに紛れ込みやすいため）。
 *
 * @throws Error クールダウンが数値として読めない
 */
export const toCommandInput = (draft: CommandDraft): BotCommandItem => {
  const trimmed = draft.cooldownSeconds.trim()
  const cooldownSeconds = trimmed === '' ? 0 : Number(trimmed)
  if (!Number.isFinite(cooldownSeconds)) throw new Error('クールダウンは秒数で入力してください')

  return {
    name: draft.name.trim().replace(/^!+/, ''),
    reply: draft.reply,
    cooldownSeconds,
  }
}

/** Workerが返した問題点の位置を、画面に振ってある番号（1始まり）に読み替える */
export const describeProblem = (problem: string): string =>
  problem.replace(PROBLEM_POSITION, (_, index: string) => `${Number(index) + 1}番目のコマンド `)
