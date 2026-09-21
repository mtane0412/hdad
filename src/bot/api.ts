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
const DEVICE_CODE_PATH = '/api/admin/bot/device-code'
const DEVICE_TOKEN_PATH = '/api/admin/bot/device-token'

/** 接続しているbotアカウント */
export interface BotStatus {
  userId: string
  login: string
  /** 認可されていないスコープ。1つでもあれば接続し直しが要る */
  missingScopes: string[]
}

/** 別の端末で接続するために、利用者へ見せる内容 */
export interface DeviceCode {
  /** 交換のときに送り返すコード。利用者には見せない */
  deviceCode: string
  /** 利用者が認可の画面で入力するコード */
  userCode: string
  /** 利用者を案内する先のURL */
  verificationUri: string
  /** コードが使えなくなるまでの秒数 */
  expiresIn: number
  /** 次に問い合わせるまで空ける秒数 */
  intervalSeconds: number
}

/**
 * 認可を待っている間の問い合わせの結果。
 * slow-down は pending と同じく「まだ認可されていない」だが、次からの間隔を延ばす必要がある（RFC 8628）。
 */
export type DevicePoll = { status: 'pending' } | { status: 'slow-down' } | { status: 'connected'; bot: BotStatus }

export interface BotApi {
  /** botの接続状態。未接続なら null */
  status(): Promise<BotStatus | null>
  /** botを切断する（Workerが持つトークンを消す） */
  disconnect(): Promise<void>
  /** botの名前で配信者のチャンネルへメッセージを送る */
  sendMessage(message: string): Promise<void>
  /** 別の端末で接続するためのコードを発行する */
  startDeviceCode(): Promise<DeviceCode>
  /** 利用者が認可を済ませたかを問い合わせる。まだなら pending */
  pollDeviceCode(deviceCode: string): Promise<DevicePoll>
}

const isDeviceCode = (value: unknown): value is DeviceCode =>
  isRecord(value) &&
  typeof value.deviceCode === 'string' &&
  typeof value.userCode === 'string' &&
  typeof value.verificationUri === 'string' &&
  typeof value.expiresIn === 'number' &&
  typeof value.intervalSeconds === 'number'

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

    startDeviceCode: async () => {
      const body = await call(DEVICE_CODE_PATH, { method: 'POST' })
      if (!isDeviceCode(body)) throw new Error(`Workerの ${DEVICE_CODE_PATH} の応答が想定した形ではありません`)
      return body
    },

    pollDeviceCode: async (deviceCode) => {
      const body = await call(DEVICE_TOKEN_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      })
      if (isRecord(body) && body.status === 'pending') return { status: 'pending' }
      if (isRecord(body) && body.status === 'slow-down') return { status: 'slow-down' }
      if (isRecord(body) && body.status === 'connected' && isBotStatus(body.bot)) return { status: 'connected', bot: body.bot }
      throw new Error(`Workerの ${DEVICE_TOKEN_PATH} の応答が想定した形ではありません`)
    },
  }
}
