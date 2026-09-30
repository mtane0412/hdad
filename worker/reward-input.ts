/**
 * チャンネルポイント報酬の入力の検証
 *
 * 管理画面（/rewards/）から送られてきた報酬の内容を、Twitchへ送る前に確かめる（issue #160）。
 * 検証は Worker だけが持ち、画面とWorkerで二重に持たない（.claude/rules/implementation.md）。
 * 作りは focus-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒む（管理画面で一度に直せるように）。
 *
 * 注意: 上限はTwitchの制約に合わせてある。ここで先に拒むのは、Twitchの英語のエラーより先に
 * どの欄をどう直せばよいかを日本語で示すためである。同じ名前の報酬があるかどうかはTwitchにしか分からないので、ここでは見ない。
 */
import { ConfigError } from './alert-config'
import type { CustomRewardInput } from './twitch'

/** 問題点のメッセージに出す、何の入力かの名前 */
const SUBJECT = 'チャンネルポイント報酬'

/** 名前の長さの上限（Twitchの制約） */
export const MAX_REWARD_TITLE_LENGTH = 45
/** 説明の長さの上限（Twitchの制約） */
export const MAX_REWARD_PROMPT_LENGTH = 200
/** 必要ポイントの下限（Twitchの制約） */
const MIN_REWARD_COST = 1

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた内容を検証し、Twitchへ送る項目だけの形にする。
 *
 * 名前は前後の空白を取り除いてから数える（見た目で見分けのつかない名前を作らないため）。
 * 知らない項目は送られてきても捨てる。
 *
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseRewardInput = (input: unknown): CustomRewardInput => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['報酬の内容はオブジェクトで指定してください'])

  const problems: string[] = []

  const readTitle = (): string => {
    const value = input.title
    const title = typeof value === 'string' ? value.trim() : ''
    if (title !== '' && title.length <= MAX_REWARD_TITLE_LENGTH) return title
    problems.push(`title: 名前は空でない${MAX_REWARD_TITLE_LENGTH}文字までの文字列で指定してください`)
    return ''
  }

  const readCost = (): number => {
    const value = input.cost
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_REWARD_COST) return value
    problems.push(`cost: 必要ポイントは${MIN_REWARD_COST}以上の整数で指定してください`)
    return MIN_REWARD_COST
  }

  const readPrompt = (): string => {
    const value = input.prompt
    if (typeof value === 'string' && value.length <= MAX_REWARD_PROMPT_LENGTH) return value
    problems.push(`prompt: 説明は${MAX_REWARD_PROMPT_LENGTH}文字までの文字列で指定してください（空でもかまいません）`)
    return ''
  }

  const readFlag = (name: 'isEnabled' | 'isUserInputRequired'): boolean => {
    const value = input[name]
    if (typeof value === 'boolean') return value
    problems.push(`${name}: true か false で指定してください`)
    return false
  }

  // 呼ぶ順番が、問題点に並ぶ順番になる
  const title = readTitle()
  const cost = readCost()
  const prompt = readPrompt()
  const isEnabled = readFlag('isEnabled')
  const isUserInputRequired = readFlag('isUserInputRequired')
  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { title, cost, prompt, isEnabled, isUserInputRequired }
}
