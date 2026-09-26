/**
 * チャットの読み上げの設定
 *
 * 読み上げのページ（speech/reader/）が使う設定を、管理画面から受け取って検証し、ストア（KV）に保存する。
 * 読み上げそのもの（音声合成・再生）は配信者のPCで動くブラウザ（src/speech/）が受け持ち、ここは設定の形と
 * 保存先だけを扱う。作りは bot-config.ts・moderation-config.ts と同じで、問題点は最初の1件で止めずに
 * すべて集めてから拒否する（管理画面で一度に直せるようにするため）。
 *
 * 以前はこれらの設定をすべてOBSに貼るURLのクエリに埋めていたが、それだと配信中に音量ひとつ変えるにも
 * URLを貼り替えることになるため、Workerに持たせて画面から変えられるようにした（issue #86）。
 *
 * 注意: ホストは localhost と 127.0.0.1 の2つしか受け取らない。読み上げのページは https で配信されるので
 * http:// の VOICEVOX ENGINE への通信は混在コンテンツにあたるが、ブラウザはループバックを安全な接続元として
 * 例外扱いするため、そこだけは通る（src/speech/voicevox.ts と同じ理由。値の範囲もそちらと合わせる）。
 * 注意: ホストとポートは読み上げのページが起動のときにしか読まない（つなぎ先が変わるので、つなぎ直しが要る）。
 * 変えたらOBSの再読み込みが必要であることは、管理画面と読み上げのページが知らせる。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'speech-settings'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = '読み上げの設定'

/** VOICEVOX ENGINE を動かせるホスト。ブラウザが混在コンテンツを許すループバックだけに限る */
const ALLOWED_HOSTS = ['localhost', '127.0.0.1'] as const

const MIN_PORT = 1
const MAX_PORT = 65535
/** 話者ID（VOICEVOX のキャラクターとスタイルの組み合わせ）。上限は増え続けるので、桁だけを見て緩く区切る */
const MIN_SPEAKER = 0
const MAX_SPEAKER = 100000
const MIN_SPEED = 0.5
const MAX_SPEED = 2
const MIN_VOLUME = 0
const MAX_VOLUME = 1
const MIN_MAX_LENGTH = 1
const MAX_MAX_LENGTH = 200
/** 読み上げない人の上限。botを数個挙げるための項目なので、名簿として使えるほどには増やさせない */
const MAX_IGNORE_LOGINS = 50
/** Twitchのログイン名（英数字と下線、25文字まで） */
const LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/

/** VOICEVOX ENGINE を動かすホスト */
export type SpeechHost = (typeof ALLOWED_HOSTS)[number]

/** チャットの読み上げの設定。値の範囲は src/speech/ のスキーマと合わせる */
export interface SpeechSettings {
  /** VOICEVOX ENGINE が動いているホスト（起動のときにしか読まない） */
  readonly host: SpeechHost
  /** VOICEVOX ENGINE のポート番号（起動のときにしか読まない） */
  readonly port: number
  /** 話者ID */
  readonly speaker: number
  /** 読み上げ速度（1 が標準） */
  readonly speed: number
  /** 音量（0〜1） */
  readonly volume: number
  /** 読み上げる本文の長さの上限（文字数） */
  readonly maxLength: number
  /** 本文の前に発言者の表示名を読むか */
  readonly readName: boolean
  /** 読み上げない人のログイン名（botなど） */
  readonly ignoreLogins: readonly string[]
}

/** 未保存のときに使う設定。話者IDの 3 は VOICEVOX の既定で入っている「ずんだもん（ノーマル）」 */
export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  host: 'localhost',
  port: 50021,
  speaker: 3,
  speed: 1,
  volume: 1,
  maxLength: 60,
  readName: false,
  ignoreLogins: [],
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた設定を検証し、保存用の形にする。
 *
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseSpeechSettings = (input: unknown): SpeechSettings => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['設定はオブジェクトで指定してください'])

  const problems: string[] = []

  /**
   * 数の項目を読む。範囲の外なら問題点に積み、既定の値で埋める
   * （問題点が1件でもあれば保存しないので、埋めた値は使われない）。
   */
  const readNumber = (name: 'port' | 'speaker' | 'speed' | 'volume' | 'maxLength', min: number, max: number, integer: boolean): number => {
    const value = input[name]
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value))) {
      return value
    }
    problems.push(`${name}: ${min}〜${max} の${integer ? '整数' : '数'}で指定してください`)
    return DEFAULT_SPEECH_SETTINGS[name]
  }

  /** ホストを読む。ループバック以外は、そう書けない理由まで添えて拒む */
  const readHost = (): SpeechHost => {
    const value = input.host
    if (ALLOWED_HOSTS.includes(value as SpeechHost)) return value as SpeechHost
    problems.push(
      `host: ${ALLOWED_HOSTS.join(' か ')} で指定してください（ブラウザが http:// への通信を許すのはループバックだけのため）`,
    )
    return DEFAULT_SPEECH_SETTINGS.host
  }

  /** 読み上げない人を読む。ログイン名として読めないものと、重なっているものを位置つきで拒む */
  const readIgnoreLogins = (): readonly string[] => {
    const value = input.ignoreLogins
    if (!Array.isArray(value)) {
      problems.push('ignoreLogins: 配列で指定してください')
      return DEFAULT_SPEECH_SETTINGS.ignoreLogins
    }
    if (value.length > MAX_IGNORE_LOGINS) {
      problems.push(`ignoreLogins: ${MAX_IGNORE_LOGINS}件以内にしてください`)
      return DEFAULT_SPEECH_SETTINGS.ignoreLogins
    }
    // 読み上げるかどうかの判定は大文字小文字を区別しない（src/speech/text.ts）ので、重なりも区別せずに見る
    const seen = new Set<string>()
    return value.flatMap((login: unknown, index): string[] => {
      const at = `ignoreLogins[${index}]`
      if (typeof login !== 'string' || !LOGIN_PATTERN.test(login)) {
        problems.push(`${at}: Twitchのログイン名（英数字と下線、25文字まで）で指定してください`)
        return []
      }
      const key = login.toLowerCase()
      if (seen.has(key)) {
        problems.push(`${at}: 「${login}」がすでに挙がっています（大文字小文字は区別しません）`)
        return []
      }
      seen.add(key)
      return [login]
    })
  }

  // 呼ぶ順番が、問題点に並ぶ順番になる
  const host = readHost()
  const port = readNumber('port', MIN_PORT, MAX_PORT, true)
  const speaker = readNumber('speaker', MIN_SPEAKER, MAX_SPEAKER, true)
  const speed = readNumber('speed', MIN_SPEED, MAX_SPEED, false)
  const volume = readNumber('volume', MIN_VOLUME, MAX_VOLUME, false)
  const maxLength = readNumber('maxLength', MIN_MAX_LENGTH, MAX_MAX_LENGTH, true)

  const readName = input.readName
  if (typeof readName !== 'boolean') problems.push('readName: true か false で指定してください')

  const ignoreLogins = readIgnoreLogins()

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { host, port, speaker, speed, volume, maxLength, readName: readName as boolean, ignoreLogins }
}

export const saveSpeechSettings = (store: KeyValueStore, settings: SpeechSettings): Promise<void> =>
  store.put(CONFIG_KEY, JSON.stringify(settings))

/**
 * 保存済みの設定を読む。未保存なら既定の設定を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
export const loadSpeechSettings = async (store: KeyValueStore): Promise<SpeechSettings> => {
  const text = await store.get(CONFIG_KEY)
  return text === null ? DEFAULT_SPEECH_SETTINGS : (JSON.parse(text) as SpeechSettings)
}
