/**
 * チャットの自動モデレーションの判定
 *
 * 受け取った発言に対して「どの処分を与えるか」だけを決める。通信も現在時刻も持ち込まないので、
 * 連投の件数は呼び出し側（webhook-routes.ts）がデータベースから数えて引数で渡す（chat-command.ts と同じ方針）。
 * 処分の実行は bot-moderation.ts、設定の検証と保存は moderation-config.ts が受け持つ。
 *
 * 注意: 誤って視聴者を処分すると取り返しがつかないため、無効（enabled が false）のあいだは決して処分しない。
 * 注意: 配信者・モデレーターは Twitch 自身が処分を許さないため、除外を切ると失敗の記録が積み上がるだけになる。
 */
import type { ChatMessage } from './chat-command'

/** 発言に与える処分。delete は発言の削除だけ、timeout・ban は削除したうえでユーザーを処分する */
export type Punishment = { type: 'delete' } | { type: 'timeout'; durationSeconds: number } | { type: 'ban' }

/** 処分を決めるルール1つぶん */
export type ModerationRule =
  /** 本文に word を含む発言（大文字小文字を区別しない部分一致） */
  | { kind: 'word'; word: string; punishment: Punishment }
  /** URLを含む発言 */
  | { kind: 'url'; punishment: Punishment }
  /** 同じ文面を windowSeconds のあいだに count 回以上くり返した発言 */
  | { kind: 'repeat'; count: number; windowSeconds: number; punishment: Punishment }

/** 連投のルール。判定に直近の件数が要るので、呼び出し側が取り出せるよう型を分けてある */
export type RepeatRule = Extract<ModerationRule, { kind: 'repeat' }>

export interface ModerationConfig {
  /** 自動モデレーションを行うか。既定は false（画面から明示的に有効にしてもらう） */
  enabled: boolean
  /** 配信者とモデレーターを処分の対象外にする */
  exemptBroadcaster: boolean
  /** VIPを処分の対象外にする */
  exemptVip: boolean
  /** サブスクライバー（創設者を含む）を処分の対象外にする */
  exemptSubscriber: boolean
  rules: ModerationRule[]
}

/** 配信者・モデレーターの除外が見るバッジ */
const BROADCASTER_BADGES = ['broadcaster', 'moderator']
/** サブスクライバーの除外が見るバッジ。古参のサブスクにはサブスクバッジの代わりに創設者のバッジが付く */
const SUBSCRIBER_BADGES = ['subscriber', 'founder']
const VIP_BADGES = ['vip']

/**
 * URLとみなす書き方。設定に任意の正規表現を置かせないのは、検証と暴走（ReDoS）の対策が要るため。
 *
 * 次の3通りを拾う。いずれも入れ子の繰り返しを含まないので、長い文面でも計算量が増えない。
 * - `http://`・`https://` から始まるもの
 * - `www.` から始まるもの
 * - scheme を省いた短縮URL（`bit.ly/xxxx` のように、ドメインのあとにスラッシュが続くもの）
 *
 * 「example.com」のようにスラッシュの無い書き方は拾わない（「3.5割」のような普通の発言と見分けが付かないため）。
 */
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|[a-z0-9][a-z0-9-]*\.[a-z]{2,}\/\S*/i

/** 処分の重さ。同じ発言が複数のルールに当たったとき、どちらを採るかを比べるのに使う */
const WEIGHT: Record<Punishment['type'], number> = { delete: 1, timeout: 2, ban: 3 }

/**
 * 2つの処分のうち、重いほうを返す。
 *
 * 重さは ban > timeout > delete の順で、タイムアウト同士なら長いほうを重いとみなす。
 */
const heavier = (left: Punishment, right: Punishment): Punishment => {
  if (WEIGHT[left.type] !== WEIGHT[right.type]) return WEIGHT[left.type] > WEIGHT[right.type] ? left : right
  if (left.type === 'timeout' && right.type === 'timeout') return left.durationSeconds >= right.durationSeconds ? left : right
  return left
}

/** 発言者が、設定で決めた処分の対象外かどうか */
const isExempt = (config: ModerationConfig, message: ChatMessage): boolean => {
  const has = (names: readonly string[]): boolean => message.badges.some((badge) => names.includes(badge))
  return (
    (config.exemptBroadcaster && has(BROADCASTER_BADGES)) || (config.exemptVip && has(VIP_BADGES)) || (config.exemptSubscriber && has(SUBSCRIBER_BADGES))
  )
}

/**
 * ルール1つに当てはまるかどうか。
 *
 * @param recentSameTextCount 直近の同じ文面の件数（この発言を含む）
 */
const matches = (rule: ModerationRule, message: ChatMessage, recentSameTextCount: number): boolean => {
  switch (rule.kind) {
    case 'word':
      return message.text.toLowerCase().includes(rule.word.toLowerCase())
    case 'url':
      return URL_PATTERN.test(message.text)
    case 'repeat':
      return recentSameTextCount >= rule.count
  }
}

/**
 * 発言に対する処分を決める。対象外・該当なしは null。
 *
 * 複数のルールに当たった場合は、重い処分（ban > timeout（長いほう）> delete）を採る。
 *
 * @param recentSameTextCount この発言者が直近に送った同じ文面の件数（この発言を含む）。
 *   連投のルールが無いときは使われないので、呼び出し側は数えずに 1 を渡してよい
 */
export const judge = (config: ModerationConfig, message: ChatMessage, recentSameTextCount: number): Punishment | null => {
  if (!config.enabled) return null
  if (isExempt(config, message)) return null

  return config.rules.reduce<Punishment | null>((decided, rule) => {
    if (!matches(rule, message, recentSameTextCount)) return decided
    return decided === null ? rule.punishment : heavier(decided, rule.punishment)
  }, null)
}

/**
 * 連投のルールを取り出す。無効なとき・連投のルールが無いときは null。
 *
 * 呼び出し側はこれが null のあいだ、直近の発言をデータベースへ書かない
 * （チャットは件数の桁が違うため、数える必要があるときだけ書き込みの枠を使う）。
 * 連投のルールは1件までに制限してあるので（moderation-config.ts）、数える窓も1つに定まる。
 */
export const repeatRuleOf = (config: ModerationConfig): RepeatRule | null => {
  if (!config.enabled) return null
  return config.rules.find((rule): rule is RepeatRule => rule.kind === 'repeat') ?? null
}
