/**
 * 読み上げのページの、OBSに貼るURLの組み立て
 *
 * 画面（speech-page.tsx）から分けてテストする（transcript/url.ts・side-super/url.ts と同じ扱い）。
 * 読み上げのページは Worker を呼ばない（チャンネル名を読む /api/chat/channel はキーの要らない公開API）ので、
 * このURLにはオーバーレイ用キーを入れない。
 *
 * 注意: 既定と同じ値はURLに書き足さない（URLを短く保ち、貼り間違いを減らすため）。
 * 読めない値は既定へ黙って戻さずエラーにする（Fail-Fast）。黙って戻すと、配信者が入れた値と違う設定で
 * 読み上げるURLを、そうと分からないまま渡してしまう。
 */

/** 読み上げのページのパス（speech/reader/index.html として配信される） */
const READER_PATH = '/speech/reader/'

const MIN_PORT = 1
const MAX_PORT = 65535

/** 読み上げの設定。既定値は src/speech/stage.ts のスキーマと合わせる */
export interface SpeechSettings {
  /** VOICEVOX ENGINE が動いているホスト */
  readonly host: 'localhost' | '127.0.0.1'
  /** VOICEVOX ENGINE のポート番号 */
  readonly port: number
  /** 話者ID */
  readonly speaker: number
  /** 読み上げ速度（1 が標準） */
  readonly speed: number
  /** 音量（0〜1） */
  readonly volume: number
  /** 読み上げる本文の長さの上限（文字数） */
  readonly maxLength: number
  /** 本文の前に表示名を読むか */
  readonly readName: boolean
  /** 読み上げない人のログイン名（botなど） */
  readonly ignoreLogins: readonly string[]
}

/** 何も指定しなかったときの設定。話者IDの 3 は VOICEVOX の既定で入っている「ずんだもん（ノーマル）」 */
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

/** 数として読める範囲にあるか確かめる。読めなければ、どの項目かが分かる文面で投げる */
const checkNumber = (value: number, label: string, min: number, max: number, integer: boolean): void => {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${label}は${min}〜${max}の${integer ? '整数' : '数'}で入力してください`)
  }
}

/**
 * OBSのブラウザソースに貼るURLを組み立てる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param settings 読み上げの設定。既定と同じ項目はURLに書き足さない
 * @throws 数の項目が読めない、または範囲の外のとき
 */
export const speechUrl = (origin: string, settings: SpeechSettings): string => {
  checkNumber(settings.port, 'ポート番号', MIN_PORT, MAX_PORT, true)
  checkNumber(settings.speaker, '話者ID', 0, 100000, true)
  checkNumber(settings.speed, '読み上げ速度', 0.5, 2, false)
  checkNumber(settings.volume, '音量', 0, 1, false)
  checkNumber(settings.maxLength, '読み上げる長さ', 1, 200, true)

  const query = new URLSearchParams()
  if (settings.host !== DEFAULT_SPEECH_SETTINGS.host) query.set('host', settings.host)
  if (settings.port !== DEFAULT_SPEECH_SETTINGS.port) query.set('port', String(settings.port))
  if (settings.speaker !== DEFAULT_SPEECH_SETTINGS.speaker) query.set('speaker', String(settings.speaker))
  if (settings.speed !== DEFAULT_SPEECH_SETTINGS.speed) query.set('speed', String(settings.speed))
  if (settings.volume !== DEFAULT_SPEECH_SETTINGS.volume) query.set('volume', String(settings.volume))
  if (settings.maxLength !== DEFAULT_SPEECH_SETTINGS.maxLength) query.set('maxLength', String(settings.maxLength))
  if (settings.readName !== DEFAULT_SPEECH_SETTINGS.readName) query.set('readName', String(settings.readName))
  if (settings.ignoreLogins.length > 0) query.set('ignore', settings.ignoreLogins.join(','))

  const search = query.toString()
  return search === '' ? `${origin}${READER_PATH}` : `${origin}${READER_PATH}?${search}`
}
