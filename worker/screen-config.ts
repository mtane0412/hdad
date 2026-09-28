/**
 * 配信画面の取り込みの設定
 *
 * 裏方のページ（src/screen/）が OBS（obs-websocket）につないで現在のプログラムシーンを撮るのに使う設定を、
 * 管理画面から受け取って検証し、ストア（KV）に保存する。撮影そのものは配信者のPCで動くブラウザが受け持ち、
 * ここは設定の形と保存先だけを扱う。作りは speech-config.ts と同じで、問題点は最初の1件で止めずに
 * すべて集めてから拒否する（管理画面で一度に直せるようにするため）。
 *
 * 撮るのは現在のプログラムシーン1枚だけなので、ソース名の設定は持たない（issue #122）。配信者が入力するのは
 * obs-websocket のポートとパスワード、撮影間隔の3つだけである。
 *
 * 注意: ホストは localhost と 127.0.0.1 の2つしか受け取らない。裏方のページは https で配信されるので
 * ws:// の obs-websocket への通信は混在コンテンツにあたるが、ブラウザはループバックを安全な接続元として
 * 例外扱いするため、そこだけは通る（src/transcript/connection.ts と同じ理由）。
 * 注意: パスワードが空であることは許す。obs-websocket の認証を切ってループバックだけで待ち受ける運用を
 * 拒まないためである（そのとき裏方は認証のやりとりを行わない）。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'screen-settings'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = '画面取り込みの設定'

/** OBS を動かせるホスト。ブラウザが混在コンテンツを許すループバックだけに限る */
const ALLOWED_HOSTS = ['localhost', '127.0.0.1'] as const

const MIN_PORT = 1
const MAX_PORT = 65535
/**
 * 撮影間隔の下限（秒）。
 *
 * GetSourceScreenshot は obs-websocket が Complexity Rating 4/5 とする重い要求で、ゲームと配信のエンコードと
 * 同居させる必要がある。実測での検証は15秒間隔で行ったので、そこを下限にする（issue #122）。
 */
const MIN_INTERVAL_SECONDS = 15
/** 撮影間隔の上限（秒）。これより間を空けると、画面が変わったことに気づけないまま配信が進む */
const MAX_INTERVAL_SECONDS = 600
/** パスワードの長さの上限。obs-websocket が受け付ける長さに上限はないが、押し込まれたものを黙って保存しない */
const MAX_PASSWORD_LENGTH = 200

/** OBS を動かすホスト */
export type ScreenHost = (typeof ALLOWED_HOSTS)[number]

/** 配信画面の取り込みの設定。値の範囲は src/screen/ のスキーマと合わせる */
export interface ScreenSettings {
  /** OBS が動いているホスト（起動のときにしか読まない） */
  readonly host: ScreenHost
  /** obs-websocket のポート番号（起動のときにしか読まない） */
  readonly port: number
  /** obs-websocket のパスワード。空なら認証のやりとりを行わない */
  readonly password: string
  /** 撮影の間隔（秒） */
  readonly intervalSeconds: number
}

/** 未保存のときに使う設定。ポートの 4455 は obs-websocket の既定、間隔は issue #122 が定めた出発点 */
export const DEFAULT_SCREEN_SETTINGS: ScreenSettings = {
  host: 'localhost',
  port: 4455,
  password: '',
  intervalSeconds: 60,
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseScreenSettings = (input: unknown): ScreenSettings => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['設定はオブジェクトで指定してください'])

  const problems: string[] = []

  /**
   * 数の項目を読む。範囲の外なら問題点に積み、既定の値で埋める
   * （問題点が1件でもあれば保存しないので、埋めた値は使われない）。
   */
  const readNumber = (name: 'port' | 'intervalSeconds', min: number, max: number): number => {
    const value = input[name]
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value
    problems.push(`${name}: ${min}〜${max} の整数で指定してください`)
    return DEFAULT_SCREEN_SETTINGS[name]
  }

  /** ホストを読む。ループバック以外は、そう書けない理由まで添えて拒む */
  const readHost = (): ScreenHost => {
    const value = input.host
    if (ALLOWED_HOSTS.includes(value as ScreenHost)) return value as ScreenHost
    problems.push(`host: ${ALLOWED_HOSTS.join(' か ')} で指定してください（ブラウザが ws:// への通信を許すのはループバックだけのため）`)
    return DEFAULT_SCREEN_SETTINGS.host
  }

  /** パスワードを読む。空は許す（obs-websocket の認証を切った運用を拒まない） */
  const readPassword = (): string => {
    const value = input.password
    if (typeof value === 'string' && value.length <= MAX_PASSWORD_LENGTH) return value
    problems.push(`password: ${MAX_PASSWORD_LENGTH}文字までの文字列で指定してください（認証を切っているなら空にします）`)
    return DEFAULT_SCREEN_SETTINGS.password
  }

  // 呼ぶ順番が、問題点に並ぶ順番になる
  const host = readHost()
  const port = readNumber('port', MIN_PORT, MAX_PORT)
  const password = readPassword()
  const intervalSeconds = readNumber('intervalSeconds', MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS)

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { host, port, password, intervalSeconds }
}

export const saveScreenSettings = (store: KeyValueStore, settings: ScreenSettings): Promise<void> =>
  store.put(CONFIG_KEY, JSON.stringify(settings))

/**
 * 保存済みの設定を読む。未保存なら既定の設定を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
export const loadScreenSettings = async (store: KeyValueStore): Promise<ScreenSettings> => {
  const text = await store.get(CONFIG_KEY)
  return text === null ? DEFAULT_SCREEN_SETTINGS : (JSON.parse(text) as ScreenSettings)
}
