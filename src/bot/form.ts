/**
 * コマンド・自動モデレーションの入力欄の値の変換
 *
 * 入力欄の値はすべて文字列なので、保存の形（クールダウンや連投の回数は数値）との間で変換する。
 * 画面（bot-page.tsx）から分けてあるのは、変換の決まりだけを取り出してテストするため。
 *
 * 注意: ここで弾くのは「数値として読めない」場合だけにする。
 * 長さや範囲の検証はWorkerが行い、問題点をまとめて返す（画面とWorkerで決まりが二重にならないようにする）。
 */
import type { BotCommandItem, ModerationRuleItem, PunishmentItem } from './api'

/** 入力欄が持つ値。すべて文字列 */
export interface CommandDraft {
  name: string
  reply: string
  /** 空欄は0（毎回応答する）として扱う */
  cooldownSeconds: string
}

/** Workerが問題点の先頭に付ける位置（commands[0]. ・rules[0]. の形。番号は0始まり） */
const PROBLEM_POSITION = /^(commands|rules)\[(\d+)\]\./

/** 問題点の位置に出す、設定ごとの呼び名 */
const PROBLEM_SUBJECT: Record<string, string> = { commands: 'コマンド', rules: 'ルール' }

/** 連投の回数の既定値。ルールの種類を切り替えたときに、空欄にならないようにする */
const DEFAULT_REPEAT_COUNT = '3'
/** 連投を数える時間の既定値（秒） */
const DEFAULT_REPEAT_WINDOW_SECONDS = '30'
/** タイムアウトの長さの既定値（秒）。10分 */
const DEFAULT_TIMEOUT_SECONDS = '600'

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
  problem.replace(PROBLEM_POSITION, (_, subject: string, index: string) => `${Number(index) + 1}番目の${PROBLEM_SUBJECT[subject] ?? subject} `)

/**
 * 自動モデレーションのルールの入力欄が持つ値。すべて文字列。
 *
 * 種類（kind）や処分（punishmentType）を切り替えても入力中の値が消えないよう、
 * いま使わない欄の値も持ち続ける（送るときに、選んでいる種類の分だけを取り出す）。
 */
export interface ModerationRuleDraft {
  kind: ModerationRuleItem['kind']
  /** 禁止語（kind が word のときに使う） */
  word: string
  /** 連投とみなす回数（kind が repeat のときに使う） */
  count: string
  /** 連投を数える時間（秒。kind が repeat のときに使う） */
  windowSeconds: string
  punishmentType: PunishmentItem['type']
  /** タイムアウトの長さ（秒。punishmentType が timeout のときに使う） */
  durationSeconds: string
}

/** 新しく足すルールの初期値。URLを削除する、いちばん穏やかな組み合わせにする */
export const NEW_MODERATION_RULE: ModerationRuleDraft = {
  kind: 'url',
  word: '',
  count: DEFAULT_REPEAT_COUNT,
  windowSeconds: DEFAULT_REPEAT_WINDOW_SECONDS,
  punishmentType: 'delete',
  durationSeconds: DEFAULT_TIMEOUT_SECONDS,
}

/** 保存済みのルールを、入力欄の値にする */
export const toModerationRuleDraft = (rule: ModerationRuleItem): ModerationRuleDraft => ({
  ...NEW_MODERATION_RULE,
  kind: rule.kind,
  ...(rule.kind === 'word' ? { word: rule.word } : {}),
  ...(rule.kind === 'repeat' ? { count: String(rule.count), windowSeconds: String(rule.windowSeconds) } : {}),
  punishmentType: rule.punishment.type,
  ...(rule.punishment.type === 'timeout' ? { durationSeconds: String(rule.punishment.durationSeconds) } : {}),
})

/**
 * 入力欄の値を数値にする。
 *
 * @throws Error 数値として読めない（範囲の検証はWorkerが行う）
 */
const toNumber = (value: string, name: string): number => {
  const parsed = Number(value.trim())
  if (value.trim() === '' || !Number.isFinite(parsed)) throw new Error(`${name}は数値で入力してください`)
  return parsed
}

/**
 * 入力欄の値を、Workerへ送る形にする。
 *
 * 選んでいる種類・処分に関わる欄だけを取り出すので、使っていない欄の値は送らない。
 *
 * @throws Error 回数・秒数が数値として読めない
 */
export const toModerationRuleInput = (draft: ModerationRuleDraft): ModerationRuleItem => {
  const punishment: PunishmentItem =
    draft.punishmentType === 'timeout'
      ? { type: 'timeout', durationSeconds: toNumber(draft.durationSeconds, 'タイムアウトの長さ') }
      : { type: draft.punishmentType }

  if (draft.kind === 'word') return { kind: 'word', word: draft.word.trim(), punishment }
  if (draft.kind === 'repeat') {
    return {
      kind: 'repeat',
      count: toNumber(draft.count, '連投とみなす回数'),
      windowSeconds: toNumber(draft.windowSeconds, '連投を数える時間'),
      punishment,
    }
  }
  return { kind: 'url', punishment }
}
