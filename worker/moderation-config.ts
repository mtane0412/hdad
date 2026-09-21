/**
 * チャットの自動モデレーションの設定
 *
 * 「どんな発言に、どの処分を与えるか」を管理画面から受け取って検証し、ストア（KV）に保存する。
 * 判定そのものは chat-moderation.ts、処分の実行は bot-moderation.ts が受け持ち、ここは設定の形と保存先だけを扱う。
 * 作りは bot-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒否する。
 *
 * 注意: 未保存のときの既定は「無効・除外はすべて有効」にする。誤って視聴者を処分すると取り返しがつかないため、
 * 画面から明示的に有効にしてもらう。
 * 注意: 正規表現のルールは置かない。任意の正規表現を設定に持ち込むと、検証と暴走（ReDoS）の対策が要るため、
 * URLの判定は chat-moderation.ts が固定で持つ。
 */
import { ConfigError } from './alert-config'
import type { ModerationConfig, ModerationRule, Punishment } from './chat-moderation'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'bot-moderation'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = '自動モデレーションの設定'

const MAX_RULES = 50
const MAX_WORD_LENGTH = 100
/** Twitchが受け付けるタイムアウトの長さ（秒）。上限は7日 */
const MIN_TIMEOUT_SECONDS = 1
const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60
/** 連投とみなす回数の範囲 */
const MIN_REPEAT_COUNT = 2
const MAX_REPEAT_COUNT = 10
/** 連投を数える時間の範囲（秒） */
const MIN_REPEAT_WINDOW_SECONDS = 10
const MAX_REPEAT_WINDOW_SECONDS = 600

/** 未保存のときに使う設定。無効で、除外はすべて有効 */
export const DEFAULT_MODERATION_CONFIG: ModerationConfig = {
  enabled: false,
  exemptBroadcaster: true,
  exemptVip: true,
  exemptSubscriber: true,
  rules: [],
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max

/**
 * 処分の指定を読む。読めなければ null（呼び出し側が問題点として記録する）。
 */
const readPunishment = (value: unknown): Punishment | null => {
  if (!isRecord(value)) return null
  if (value.type === 'delete') return { type: 'delete' }
  if (value.type === 'ban') return { type: 'ban' }
  if (value.type === 'timeout' && isInteger(value.durationSeconds, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)) {
    return { type: 'timeout', durationSeconds: value.durationSeconds }
  }
  return null
}

/** 処分についての問題点。`punishment` の位置に付ける文言を組み立てる */
const punishmentProblem = (at: string, value: unknown): string => {
  const type = isRecord(value) ? value.type : undefined
  if (type === 'timeout') {
    return `${at}.punishment.durationSeconds: ${MIN_TIMEOUT_SECONDS}〜${MAX_TIMEOUT_SECONDS} の整数（秒）で指定してください`
  }
  return `${at}.punishment: delete・timeout・ban のいずれかで指定してください`
}

/**
 * ルール1件を読む。問題があれば problems に積み、そのルールは捨てる。
 *
 * @param at 問題点の先頭に付ける位置（rules[0] の形）
 */
const readRule = (candidate: unknown, at: string, problems: string[]): ModerationRule[] => {
  if (!isRecord(candidate)) {
    problems.push(`${at}: オブジェクトで指定してください`)
    return []
  }

  const punishment = readPunishment(candidate.punishment)
  if (punishment === null) problems.push(punishmentProblem(at, candidate.punishment))

  const { kind } = candidate
  if (kind === 'url') return punishment === null ? [] : [{ kind: 'url', punishment }]

  if (kind === 'word') {
    const { word } = candidate
    const wordOk = typeof word === 'string' && word.trim() !== '' && word.length <= MAX_WORD_LENGTH
    if (!wordOk) problems.push(`${at}.word: ${MAX_WORD_LENGTH}文字以内の語句を入力してください`)
    return wordOk && punishment !== null ? [{ kind: 'word', word, punishment }] : []
  }

  if (kind === 'repeat') {
    const { count, windowSeconds } = candidate
    const countOk = isInteger(count, MIN_REPEAT_COUNT, MAX_REPEAT_COUNT)
    const windowOk = isInteger(windowSeconds, MIN_REPEAT_WINDOW_SECONDS, MAX_REPEAT_WINDOW_SECONDS)
    if (!countOk) problems.push(`${at}.count: ${MIN_REPEAT_COUNT}〜${MAX_REPEAT_COUNT} の整数で指定してください`)
    if (!windowOk) problems.push(`${at}.windowSeconds: ${MIN_REPEAT_WINDOW_SECONDS}〜${MAX_REPEAT_WINDOW_SECONDS} の整数（秒）で指定してください`)
    return countOk && windowOk && punishment !== null ? [{ kind: 'repeat', count, windowSeconds, punishment }] : []
  }

  problems.push(`${at}.kind: word・url・repeat のいずれかで指定してください`)
  return []
}

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseModerationConfig = (input: unknown): ModerationConfig => {
  if (!isRecord(input) || !Array.isArray(input.rules)) throw new ConfigError(SUBJECT, ['rules: 配列で指定してください'])
  if (input.rules.length > MAX_RULES) throw new ConfigError(SUBJECT, [`rules: ${MAX_RULES}件以内にしてください`])

  const problems: string[] = []

  /** 有効・除外の指定を読む。真偽値でなければ問題点に積み、既定の値で埋める（問題点が1件でもあれば保存しないので使われない） */
  const readSwitch = (name: 'enabled' | 'exemptBroadcaster' | 'exemptVip' | 'exemptSubscriber'): boolean => {
    const value = input[name]
    if (typeof value === 'boolean') return value
    problems.push(`${name}: true か false で指定してください`)
    return DEFAULT_MODERATION_CONFIG[name]
  }

  // 呼ぶ順番が、問題点に並ぶ順番になる
  const enabled = readSwitch('enabled')
  const exemptBroadcaster = readSwitch('exemptBroadcaster')
  const exemptVip = readSwitch('exemptVip')
  const exemptSubscriber = readSwitch('exemptSubscriber')

  /** 連投のルールを既に読んだか。窓が1つに定まらなくなるため、2件目は受け付けない */
  let repeatSeen = false

  const rules = input.rules.flatMap((candidate: unknown, index): ModerationRule[] => {
    const at = `rules[${index}]`
    const rule = readRule(candidate, at, problems)
    if (rule[0]?.kind !== 'repeat') return rule
    if (repeatSeen) {
      problems.push(`${at}: 連投のルールは1件までにしてください（数える時間の幅が1つに定まらなくなるため）`)
      return []
    }
    repeatSeen = true
    return rule
  })

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { enabled, exemptBroadcaster, exemptVip, exemptSubscriber, rules }
}

export const saveModerationConfig = (store: KeyValueStore, config: ModerationConfig): Promise<void> => store.put(CONFIG_KEY, JSON.stringify(config))

/**
 * 保存済みの設定を読む。未保存なら既定の設定（無効）を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
export const loadModerationConfig = async (store: KeyValueStore): Promise<ModerationConfig> => {
  const text = await store.get(CONFIG_KEY)
  return text === null ? DEFAULT_MODERATION_CONFIG : (JSON.parse(text) as ModerationConfig)
}
