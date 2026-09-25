/**
 * アラート用オーバーレイのページ（alerts/index.html）のエントリスクリプト
 *
 * URLの ?key=<オーバーレイ用キー> でWorkerへつなぎ、押し出されてくるアラートを1件ずつ順番に再生する。
 * Twitchの通知を受け取るのも、どのトリガーに当てはまるかを決めるのもWorkerで、このページは再生するだけでよい
 * （条件に「その配信で初めての発言か」のように、データベースの記録からしか決められないものがあるため）。
 * ?demo=true なら接続せず、8種類のイベントぶんのサンプルを一定間隔で順に流す（配置の調整用）。
 * 起動に失敗した場合や、人が直さないと直らない失敗は、OBS上でも原因が分かるよう画面にエラー内容を表示する。
 */
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import type { Alert } from './alert'
import { demoAlerts } from './demo'
import { EMPTY_QUEUE, advance, enqueue } from './queue'
import { connectAlerts } from './socket'
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

  /** 再生する列に1件積む。いま何も再生していなければ、その場で再生を始める */
  const showAlert = (alert: Alert): void => {
    const idle = queue.current === null
    queue = enqueue(queue, alert)
    if (idle) play()
  }

  if (params.demo) {
    // サンプルのアラートを先頭から順に、一巡したらまた先頭から流す
    let demoIndex = 0
    const playDemo = (): void => {
      const alert = demoAlerts[demoIndex % demoAlerts.length]
      demoIndex += 1
      if (alert) showAlert(alert)
    }
    playDemo()
    window.setInterval(playDemo, DEMO_INTERVAL_MS)
    return
  }

  connectAlerts(params.key, {
    onAlert: (alert) => {
      // 前回の失敗のお知らせが残っていれば消す
      view.setNotice(null)
      showAlert(alert)
    },
    onStatus: (status) => view.setNotice(status === 'disconnected' ? 'Workerとの接続が切れました。再接続します…' : null),
    onWarning: (message) => view.setNotice(message),
  })
}

start().catch((error: unknown) => {
  showError(error, NOUN)
  throw error
})
