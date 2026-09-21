/**
 * アラート用オーバーレイのページ（alerts/index.html）のエントリスクリプト
 *
 * URLの ?key=<オーバーレイ用キー> でEventSubに接続し、届いた通知を設定（config.ts）と照らし合わせて、
 * 当てはまったものを1件ずつ順番に再生する。?demo=true なら接続せず、サンプルの交換を一定間隔で流す（配置の調整用）。
 * 起動に失敗した場合や、人が直さないと直らない失敗は、OBS上でも原因が分かるよう画面にエラー内容を表示する。
 */
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { triggers } from './config'
import { connectEventSub } from './connection'
import type { EventSubNotification } from './eventsub'
import { EMPTY_QUEUE, advance, enqueue } from './queue'
import { toAlert } from './trigger'
import { createAlertView } from './view'

const NOUN = 'アラート'
/** デモでサンプルの交換を流す間隔（ミリ秒） */
const DEMO_INTERVAL_MS = 9000

const schema = {
  key: {
    type: 'string',
    default: '',
    // Workerが発行するキー（worker/secret.ts の randomToken）は、URLにそのまま載せられる文字だけでできている
    pattern: /^[A-Za-z0-9_-]{32,}$/,
    example: '管理用API（/api/me）の overlayKey の値',
    description: 'オーバーレイ用キー（必須）',
  },
  demo: { type: 'boolean', default: false, description: 'サンプルのアラートを流す（配置の調整用。Twitchには接続しない）' },
} as const satisfies ParamSchema

const demoNotification: EventSubNotification = {
  type: 'notification',
  id: 'demo',
  subscriptionType: 'channel.channel_points_custom_reward_redemption.add',
  event: { user_name: 'たねのぶ', user_input: '', reward: { id: 'demo-reward', title: '水を飲む' } },
}

const start = (): void => {
  const root = document.querySelector<HTMLElement>('[data-alerts]')
  if (!root) throw new Error('data-alerts 属性を持つ要素が見つかりません')

  const params = parseParams(schema, new URLSearchParams(location.search))
  if (!params.demo && params.key === '') {
    throw new ParamError([
      'key: オーバーレイ用キーを指定してください（例: ?key=<キー>）',
      '配置の調整用にサンプルを表示する場合は ?demo=true を指定してください',
    ])
  }

  const view = createAlertView(root)
  let queue = EMPTY_QUEUE

  /** 再生中のアラートを表示し、終わったら次へ進む */
  const play = (): void => {
    if (queue.current === null) return
    void view
      .show(queue.current)
      // 素材が読めなくても後続のアラートは再生するが、黙って飛ばさず画面に知らせる
      .catch((error: unknown) => view.setNotice(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        queue = advance(queue)
        play()
      })
  }

  const handleNotification = (notification: EventSubNotification): void => {
    const alert = toAlert(triggers, notification)
    if (!alert) return
    const idle = queue.current === null
    queue = enqueue(queue, alert)
    if (idle) play()
  }

  if (params.demo) {
    handleNotification(demoNotification)
    window.setInterval(() => handleNotification(demoNotification), DEMO_INTERVAL_MS)
    return
  }

  connectEventSub(params.key, {
    onNotification: (notification) => {
      try {
        handleNotification(notification)
      } catch (error) {
        view.setNotice(error instanceof Error ? error.message : String(error))
      }
    },
    onStatus: (status) => view.setNotice(status === 'disconnected' ? 'Twitchとの接続が切れました。再接続します…' : null),
    onWarning: (message) => view.setNotice(message),
    onFatal: (message) => showError(new Error(message), NOUN),
  })
}

try {
  start()
} catch (error) {
  showError(error, NOUN)
  throw error
}
