/**
 * チャンネルポイント報酬の入力の検証
 *
 * 管理画面（/rewards/）から送られてきた報酬の内容を、Twitchへ送る前に確かめる（issue #160）。
 * 検証は Worker だけが持ち、画面とWorkerで二重に持たない（.claude/rules/implementation.md）。
 * 作りは focus-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒む（管理画面で一度に直せるように）。
 *
 * 注意: 長さは見た目の文字数（コードポイント）で数える。報酬の名前には絵文字がよく使われ、UTF-16の単位のまま数えると
 * 上限内の名前まで拒んでしまうため（focus-config.ts と同じ数え方）。
 * 注意: 待機時間・上限回数の null は「制限なし」を表す（画面の空欄）。
 * 注意: 上限はTwitchの制約に合わせてある（待機時間の下限だけはTwitchの画面に出る60秒にしてある）。ここで先に拒むのは、Twitchの英語のエラーより先に
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
/** 上限回数の下限（Twitchの制約） */
const MIN_REWARD_LIMIT = 1
/**
 * 待機時間の下限（秒）。
 *
 * Helixは1秒から受け付けるが、60秒未満はTwitchの画面に出ず、視聴者から待機中だと分からないため、Twitchのダッシュボードと同じ1分からにする。
 */
const MIN_REWARD_COOLDOWN_SECONDS = 60
/** 待機時間の上限（秒。7日。Twitchの制約） */
const MAX_REWARD_COOLDOWN_SECONDS = 604_800
/** 背景色の形（#RRGGBB。Twitchが受け付ける16進数の形） */
const BACKGROUND_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 見た目の文字数（コードポイント）。絵文字などサロゲートペアの文字を2文字と数えないために使う */
const countCodePoints = (value: string): number => [...value].length

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
    if (title !== '' && countCodePoints(title) <= MAX_REWARD_TITLE_LENGTH) return title
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
    if (typeof value === 'string' && countCodePoints(value) <= MAX_REWARD_PROMPT_LENGTH) return value
    problems.push(`prompt: 説明は${MAX_REWARD_PROMPT_LENGTH}文字までの文字列で指定してください（空でもかまいません）`)
    return ''
  }

  const readFlag = (name: 'isEnabled' | 'isUserInputRequired' | 'shouldRedemptionsSkipRequestQueue'): boolean => {
    const value = input[name]
    if (typeof value === 'boolean') return value
    problems.push(`${name}: true か false で指定してください`)
    return false
  }

  const readBackgroundColor = (): string => {
    const value = input.backgroundColor
    if (typeof value === 'string' && BACKGROUND_COLOR_PATTERN.test(value)) return value
    problems.push('backgroundColor: 背景色は #9147FF のような #RRGGBB の形で指定してください')
    return ''
  }

  /** 制限（上限回数・待機時間）を読む。null は制限なし。範囲外は問題点に加える */
  const readLimit = (name: 'maxPerStream' | 'maxPerUserPerStream' | 'globalCooldownSeconds', min: number, max: number, message: string): number | null => {
    const value = input[name]
    if (value === null) return null
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) return value
    problems.push(`${name}: ${message}`)
    return null
  }

  // 呼ぶ順番が、問題点に並ぶ順番になる
  const title = readTitle()
  const cost = readCost()
  const prompt = readPrompt()
  const isEnabled = readFlag('isEnabled')
  const isUserInputRequired = readFlag('isUserInputRequired')
  const backgroundColor = readBackgroundColor()
  const shouldRedemptionsSkipRequestQueue = readFlag('shouldRedemptionsSkipRequestQueue')
  const limitMessage = `上限回数は${MIN_REWARD_LIMIT}以上の整数で指定してください（空欄なら制限なし）`
  const maxPerStream = readLimit('maxPerStream', MIN_REWARD_LIMIT, Number.MAX_SAFE_INTEGER, limitMessage)
  const maxPerUserPerStream = readLimit('maxPerUserPerStream', MIN_REWARD_LIMIT, Number.MAX_SAFE_INTEGER, limitMessage)
  const globalCooldownSeconds = readLimit(
    'globalCooldownSeconds',
    MIN_REWARD_COOLDOWN_SECONDS,
    MAX_REWARD_COOLDOWN_SECONDS,
    `待機時間は${MIN_REWARD_COOLDOWN_SECONDS}〜${MAX_REWARD_COOLDOWN_SECONDS}秒の整数で指定してください（空欄なら待機なし）`,
  )
  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { title, cost, prompt, isEnabled, isUserInputRequired, backgroundColor, shouldRedemptionsSkipRequestQueue, maxPerStream, maxPerUserPerStream, globalCooldownSeconds }
}
