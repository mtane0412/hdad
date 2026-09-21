/**
 * チャットボットの管理用APIの呼び出し
 *
 * チャットボットのページ（bot-page.tsx）はWorker（/api/admin/bot・/api/admin/bot/messages）を
 * 同じサイトの相対パスで呼び出す。セッションのクッキーと Origin ヘッダーはブラウザが付けるので、ここでは何もしない。
 * 呼び出しと失敗の扱いは `@/core/api` に任せる。fetch を引数で受け取るのは、テストで差し替えるため。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の型はここで定義し、受け取るたびに形を確かめる。
 * 想定した形でなければエラーにする（黙って未接続扱いにすると、接続済みのbotを接続していないように見せてしまう）。
 *
 * botの接続そのもの（Twitchの認可画面への往復）はここでは行わない。通常のリンクで /api/auth/login?role=bot を開く。
 */
import { createCaller, isRecord } from '@/core/api'

const STATUS_PATH = '/api/admin/bot'
const MESSAGES_PATH = '/api/admin/bot/messages'

/** 接続しているbotアカウント */
export interface BotStatus {
  userId: string
  login: string
  /** 認可されていないスコープ。1つでもあれば接続し直しが要る */
  missingScopes: string[]
}

export interface BotApi {
  /** botの接続状態。未接続なら null */
  status(): Promise<BotStatus | null>
  /** botを切断する（Workerが持つトークンを消す） */
  disconnect(): Promise<void>
  /** botの名前で配信者のチャンネルへメッセージを送る */
  sendMessage(message: string): Promise<void>
}

const isBotStatus = (value: unknown): value is BotStatus =>
  isRecord(value) &&
  typeof value.userId === 'string' &&
  typeof value.login === 'string' &&
  Array.isArray(value.missingScopes) &&
  value.missingScopes.every((scope: unknown) => typeof scope === 'string')

export const createBotApi = (fetchImpl: typeof fetch): BotApi => {
  const call = createCaller(fetchImpl)

  return {
    status: async () => {
      const body = await call(STATUS_PATH)
      const bot: unknown = isRecord(body) ? body.bot : undefined
      if (bot === null) return null
      if (!isBotStatus(bot)) throw new Error(`Workerの ${STATUS_PATH} の応答が想定した形ではありません`)
      return bot
    },

    disconnect: async () => {
      await call(STATUS_PATH, { method: 'DELETE' })
    },

    sendMessage: async (message) => {
      await call(MESSAGES_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
    },
  }
}
