/**
 * アラート用オーバーレイのページ（alerts/index.html）のエントリスクリプト
 *
 * URLの ?key=<オーバーレイ用キー> でWorkerから設定（config.ts）を受け取り、EventSubに接続して、
 * 届いた通知のうち設定に当てはまったものを1件ずつ順番に再生する。
 * ?demo=true なら接続せず、5種類のイベントのサンプルを一定間隔で順に流す（配置の調整用）。
 * 起動に失敗した場合や、人が直さないと直らない失敗は、OBS上でも原因が分かるよう画面にエラー内容を表示する。
 */
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { fetchTriggers } from './config'
import { connectEventSub } from './connection'
import { demoNotifications, demoTriggers } from './demo'
import type { EventSubNotification } from './eventsub'
import { EMPTY_QUEUE, advance, enqueue } from './queue'
import { toAlert, type AlertTrigger } from './trigger'
import { createAlertView } from './view'

const NOUN = 'アラート'
/** デモでサンプルの通知を流す間隔（ミリ秒） */
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const start = async (): Promise<void> => {
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
      .catch((error: unknown) => view.setNotice(messageOf(error)))
      .finally(() => {
        queue = advance(queue)
        play()
      })
  }

  const handleNotification = (triggers: readonly AlertTrigger[], notification: EventSubNotification): void => {
    const alert = toAlert(triggers, notification)
    if (!alert) return
    const idle = queue.current === null
    queue = enqueue(queue, alert)
    if (idle) play()
  }

  if (params.demo) {
    // サンプルの通知を先頭から順に、一巡したらまた先頭から流す
    let demoIndex = 0
    const playDemo = (): void => {
      const notification = demoNotifications[demoIndex % demoNotifications.length]
      demoIndex += 1
      if (notification) handleNotification(demoTriggers, notification)
    }
    playDemo()
    window.setInterval(playDemo, DEMO_INTERVAL_MS)
    return
  }

  const loadTriggers = (): Promise<AlertTrigger[]> => fetchTriggers(params.key, (input, init) => fetch(input, init))
  // 起動時に設定を取得できなければ（キーの誤りなど）、接続せずにエラーを表示する
  let triggers = await loadTriggers()

  /** 通知の処理を届いた順に1件ずつ行うための列。設定の取得の速さによってアラートの順番が入れ替わらないようにする */
  let processing: Promise<void> = Promise.resolve()

  connectEventSub(params.key, {
    onNotification: (notification) => {
      // 管理画面での変更をOBSの再読み込みなしで反映するため、通知のたびに設定を取り直す。
      // 取り直せなかった場合は画面に知らせたうえで、最後に取得できた設定で再生する
      processing = processing
        .then(loadTriggers)
        .then((latest) => {
          triggers = latest
          // 前回の取得失敗のお知らせが残っていれば消す
          view.setNotice(null)
        })
        .catch((error: unknown) => view.setNotice(`最新の設定を取得できませんでした: ${messageOf(error)}`))
        .then(() => handleNotification(triggers, notification))
        .catch((error: unknown) => view.setNotice(messageOf(error)))
    },
    onStatus: (status) => view.setNotice(status === 'disconnected' ? 'Twitchとの接続が切れました。再接続します…' : null),
    onWarning: (message) => view.setNotice(message),
    onFatal: (message) => showError(new Error(message), NOUN),
  })
}

start().catch((error: unknown) => {
  showError(error, NOUN)
  throw error
})
