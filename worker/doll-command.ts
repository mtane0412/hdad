/**
 * 人形の組み込みのコマンド（!人形・!人形ランキング）
 *
 * チャットの受け口（worker/webhook-routes.ts）から呼ばれ、視聴者の !人形 で発言者のいまの人形の所持数を、
 * !人形ランキング でいまの人形の点数のランキングを、合成ページの素材「人形の獲得」へ出す（押し出しは worker/doll-standing.ts）。
 * チャットへは何も返さない（見せる場所は配信画面）。合成ページに出すだけなので bot の接続は要らない。
 *
 * 続けて打たれて配信画面が埋まらないよう、所持数は人ごとに、ランキングは全体で、DOLL_COMMAND_COOLDOWN_SECONDS の間を空けるまで出さない
 * （間を空けている途中の発言は黙って流す。登録したコマンドのクールダウンと同じ扱い）。
 *
 * 注意: 出せなかったとき（いまの人形が無い・オーバーレイ用キーが無いなど）は投げずに `doll-show-failed` として記録する。
 *   投げると Twitch が同じ通知を再送するため（作業机の組み込みのコマンドと同じ扱い）。
 */
import type { ChatMessage } from './chat-command'
import { consumeCooldown, reserveChatReply } from './chat-store'
import type { DollAwardEnv } from './doll-award'
import { showDollRanking, showDollStanding } from './doll-standing'
import { recordFailure } from './stats-store'

/** コマンドの先頭に付ける文字（worker/chat-command.ts の登録したコマンドと同じ） */
const PREFIX = '!'

/** 何を出すコマンドか。standing は発言者の所持数、ranking はランキング */
export type DollCommand = 'standing' | 'ranking'

/** 組み込みのコマンドの名前（`!` を除く）と、何を出すか。管理画面で同じ名前のコマンドは登録させない（worker/bot-config.ts） */
const COMMANDS: ReadonlyMap<string, DollCommand> = new Map([
  ['人形', 'standing'],
  ['人形ランキング', 'ranking'],
])

/** 組み込みのコマンドの名前の一覧（worker/bot-config.ts が同じ名前を拒むのに使う） */
export const DOLL_COMMAND_NAMES: readonly string[] = [...COMMANDS.keys()]

/** 同じもの（所持数は同じ人の、ランキングは誰のでも）を続けて出さない秒数 */
export const DOLL_COMMAND_COOLDOWN_SECONDS = 30

/** 組み込みのコマンドを実行するのに要るもの */
export interface DollCommandContext {
  readonly env: DollAwardEnv
  readonly now: number
}

/**
 * 発言から人形の組み込みのコマンドを読み取る。
 *
 * 最初の語だけをコマンド名として見る（worker/chat-command.ts の findCommand と同じ見方）。後ろに続く文字は無視する。
 *
 * @returns 人形のコマンドでなければ null
 */
export const readDollCommand = (text: string): DollCommand | null => {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PREFIX)) return null
  const [name = ''] = trimmed.slice(PREFIX.length).split(/\s+/)
  return COMMANDS.get(name) ?? null
}

/**
 * 発言が人形の組み込みのコマンドなら、所持数かランキングを合成ページへ出す。
 *
 * 鍵に動作の種類を混ぜるのは、同じ発言で自動モデレーションやトリガーの送信と鍵を取り合わないため（webhook-routes.ts と同じ）。
 * 鍵の確保はクールダウンの判定より先に行う（逆にすると、再送のたびに最後に使った時刻が更新されるため）。
 *
 * @returns 人形のコマンドとして扱ったら true（出さなかった・出せなかったときも含む）。人形のコマンドでなければ false
 */
export const handleDollCommand = async ({ env, now }: DollCommandContext, message: ChatMessage): Promise<boolean> => {
  const command = readDollCommand(message.text)
  if (command === null) return false

  if (!(await reserveChatReply(env.DB, `${message.messageId}:dolls`, now))) return true
  // クールダウンの鍵は登録したコマンドの名前と同じ表（command_uses）に置くので、コロンで区切って重ならない形にする
  const cooldownKey = command === 'standing' ? `dolls:standing:${message.chatterUserId}` : 'dolls:ranking'
  if (!(await consumeCooldown(env.DB, cooldownKey, DOLL_COMMAND_COOLDOWN_SECONDS, now))) return true

  try {
    if (command === 'standing') await showDollStanding(env, message.chatterUserId, message.chatterUserName)
    else await showDollRanking(env)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const what = command === 'standing' ? `${message.chatterUserName}さんの人形の所持数` : '人形のランキング'
    await recordFailure(env.DB, 'doll-show-failed', `チャットのコマンドで${what}を出せませんでした: ${reason}`, now)
  }
  return true
}
