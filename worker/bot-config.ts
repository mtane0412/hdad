/**
 * チャットボットのコマンドの設定
 *
 * 「どの `!コマンド` に、どう応答するか」を管理画面から受け取って検証し、ストア（KV）に保存する。
 * 判定そのものは chat-command.ts が受け持ち、ここは設定の形と保存先だけを扱う。
 *
 * 注意: 検証は最初の1件で止めず、問題点をすべて集めてから拒否する（管理画面で一度に直せるようにする）。
 * 注意: Twitchが受け付けない内容（500文字を超える応答文など）は、チャットへ送る前のここで止める。
 */
import { ConfigError } from './alert-config'
import type { BotCommand } from './chat-command'
import { MAX_STREAM_SUMMARY_LENGTH } from './stream-summary'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'bot-commands'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = 'コマンドの設定'

const MAX_COMMANDS = 50
const MAX_NAME_LENGTH = 50
/** Twitchが決めているチャット本文の上限（文字） */
const MAX_REPLY_LENGTH = 500
/** クールダウンの上限（秒）。1時間 */
const MAX_COOLDOWN_SECONDS = 60 * 60
/** Twitchのログイン名の最大の長さ（文字）。差し込み後にいちばん長くなる場合を見積もるのに使う */
const MAX_LOGIN_LENGTH = 25

/** 保存するコマンド */
export interface StoredCommand extends BotCommand {
  /** 同じコマンドに続けて応答しない秒数。0 なら毎回応答する */
  cooldownSeconds: number
}

export interface BotConfig {
  commands: StoredCommand[]
}

export const EMPTY_CONFIG: BotConfig = { commands: [] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** コマンド名として使えるか。空白と `!` を含めないのは、発言の先頭の語と突き合わせるため */
const isValidName = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= MAX_NAME_LENGTH && !/[\s!]/.test(value)

/**
 * 差し込み語が最も長い値に置き換わった場合の、応答文の長さ。
 *
 * 保存の時点では発言者もあらすじの中身も分からないため、それぞれが上限いっぱいだった場合で見積もる。
 * こうしておくと、保存できた応答文は必ずTwitchへ送れる（送る段になって長さで弾かれない）。
 */
const expandedLength = (reply: string): number =>
  reply.replaceAll('{user}', 'x'.repeat(MAX_LOGIN_LENGTH)).replaceAll('{summary}', 'x'.repeat(MAX_STREAM_SUMMARY_LENGTH)).length

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseBotConfig = (input: unknown): BotConfig => {
  if (!isRecord(input) || !Array.isArray(input.commands)) throw new ConfigError(SUBJECT, ['commands: 配列で指定してください'])
  if (input.commands.length > MAX_COMMANDS) throw new ConfigError(SUBJECT, [`commands: ${MAX_COMMANDS}件以内にしてください`])

  const problems: string[] = []
  /** 既に出てきたコマンド名（小文字）。判定が大文字小文字を無視するので、重複もそれに合わせて見る */
  const seenNames = new Set<string>()

  const commands = input.commands.flatMap((candidate: unknown, index): StoredCommand[] => {
    const at = `commands[${index}]`
    if (!isRecord(candidate)) {
      problems.push(`${at}: オブジェクトで指定してください`)
      return []
    }
    const { name, reply, cooldownSeconds } = candidate

    // 判定結果を変数に置くのは、問題点の記録と、下の if での型の絞り込みの両方に使うため
    const nameOk = isValidName(name)
    const duplicated = nameOk && seenNames.has(name.toLowerCase())
    // 空白だけの文言はTwitchが受け付けない。長さは差し込み後で見る
    const replyFilled = typeof reply === 'string' && reply.trim() !== ''
    const replyOk = replyFilled && expandedLength(reply) <= MAX_REPLY_LENGTH
    const cooldownOk =
      typeof cooldownSeconds === 'number' && Number.isInteger(cooldownSeconds) && cooldownSeconds >= 0 && cooldownSeconds <= MAX_COOLDOWN_SECONDS

    if (!nameOk) problems.push(`${at}.name: 空白と ! を含まない${MAX_NAME_LENGTH}文字以内の文字列で指定してください`)
    else if (duplicated) problems.push(`${at}.name: コマンド名「${name}」が重複しています（大文字小文字は区別しません）`)
    if (!replyFilled) problems.push(`${at}.reply: 送り返す文言を入力してください`)
    else if (!replyOk) {
      problems.push(
        `${at}.reply: ${MAX_REPLY_LENGTH}文字以内にしてください（{user} は最大${MAX_LOGIN_LENGTH}文字、{summary} は最大${MAX_STREAM_SUMMARY_LENGTH}文字に置き換わります）`,
      )
    }
    if (!cooldownOk) problems.push(`${at}.cooldownSeconds: 0〜${MAX_COOLDOWN_SECONDS} の整数で指定してください`)

    if (!nameOk || duplicated || !replyOk || !cooldownOk) return []
    seenNames.add(name.toLowerCase())
    return [{ name, reply, cooldownSeconds }]
  })

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { commands }
}

export const saveBotConfig = (store: KeyValueStore, config: BotConfig): Promise<void> => store.put(CONFIG_KEY, JSON.stringify(config))

/**
 * 保存済みの設定を読む。未保存ならコマンドなしの設定を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
export const loadBotConfig = async (store: KeyValueStore): Promise<BotConfig> => {
  const text = await store.get(CONFIG_KEY)
  return text === null ? EMPTY_CONFIG : (JSON.parse(text) as BotConfig)
}
