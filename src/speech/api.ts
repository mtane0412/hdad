/**
 * 読み上げの設定の読み書き（Workerの呼び出し）
 *
 * 読み上げの設定は Worker（KVの speech-settings）が持ち、2つの経路から読まれる。
 * - 管理画面（/speech/ のページ）: 配信者のセッションで /api/admin/speech を読み書きする
 * - 読み上げのページ（speech/reader/）: オーバーレイ用キーで /api/overlay/speech を読むだけ
 *
 * どちらも同じ形の設定を受け取るので、形の確かめ（readSpeechSettings）をここで共有する。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の型はここで定義して形を確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って既定の設定に倒すと、配信者が下げた音量で読み上げているつもりが
 * 最大音量で読み上げる、といった食い違いが起きる。
 * 注意: 値の範囲の検証は Worker（worker/speech-config.ts）だけが持つ。画面とWorkerで二重に持たない。
 */
import { createCaller, isRecord } from '../core/api'

const ADMIN_PATH = '/api/admin/speech'
const OVERLAY_PATH = '/api/overlay/speech'

/** チャットの読み上げの設定。項目と値の範囲は worker/speech-config.ts と合わせる */
export interface SpeechSettings {
  /** VOICEVOX ENGINE が動いているホスト（読み上げのページが起動のときにしか使わない） */
  host: string
  /** VOICEVOX ENGINE のポート番号（読み上げのページが起動のときにしか使わない） */
  port: number
  /** 話者ID */
  speaker: number
  /** 読み上げ速度（1 が標準） */
  speed: number
  /** 音量（0〜1） */
  volume: number
  /** 読み上げる本文の長さの上限（文字数） */
  maxLength: number
  /** 本文の前に発言者の表示名を読むか */
  readName: boolean
  /** 読み上げない人のログイン名（botなど） */
  ignoreLogins: string[]
}

/** 読み上げの設定として読む。想定した形でなければエラーにする */
const readSpeechSettings = (body: unknown, path: string): SpeechSettings => {
  if (
    !isRecord(body) ||
    typeof body.host !== 'string' ||
    typeof body.port !== 'number' ||
    typeof body.speaker !== 'number' ||
    typeof body.speed !== 'number' ||
    typeof body.volume !== 'number' ||
    typeof body.maxLength !== 'number' ||
    typeof body.readName !== 'boolean' ||
    !Array.isArray(body.ignoreLogins) ||
    !body.ignoreLogins.every((login: unknown) => typeof login === 'string')
  ) {
    throw new Error(`Workerの ${path} の応答が想定した形ではありません`)
  }
  return {
    host: body.host,
    port: body.port,
    speaker: body.speaker,
    speed: body.speed,
    volume: body.volume,
    maxLength: body.maxLength,
    readName: body.readName,
    ignoreLogins: body.ignoreLogins as string[],
  }
}

/** 管理画面からの読み書き */
export interface SpeechApi {
  /** 保存済みの設定を読む。未保存なら既定の設定が返る */
  load(): Promise<SpeechSettings>
  /** 設定をまるごと置き換えて保存する。検証はWorkerが行う */
  save(settings: SpeechSettings): Promise<SpeechSettings>
}

/** 読み上げのページからの読み出し */
export interface SpeechOverlayApi {
  /** いまの設定を読む */
  read(): Promise<SpeechSettings>
}

/**
 * 管理画面からの読み書きを組み立てる。
 *
 * セッションのクッキーと Origin ヘッダーはブラウザが付けるので、ここでは何もしない。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createSpeechApi = (fetchImpl: typeof fetch): SpeechApi => {
  const call = createCaller(fetchImpl)

  return {
    load: async () => readSpeechSettings(await call(ADMIN_PATH), ADMIN_PATH),

    save: async (settings) =>
      readSpeechSettings(
        await call(ADMIN_PATH, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        }),
        ADMIN_PATH,
      ),
  }
}

/**
 * 読み上げのページからの読み出しを組み立てる。
 *
 * 読み上げのページは素材ページなのでログインを持たず、オーバーレイ用キー（URLの ?key=）で
 * Worker に受け付けてもらう（サイドスーパーのオーバーレイと同じ）。
 *
 * @param fetchImpl 通信の実装
 * @param key オーバーレイ用キー
 */
export const createSpeechOverlayApi = (fetchImpl: typeof fetch, key: string): SpeechOverlayApi => {
  const call = createCaller(fetchImpl)
  const path = `${OVERLAY_PATH}?key=${encodeURIComponent(key)}`

  return {
    read: async () => readSpeechSettings(await call(path), OVERLAY_PATH),
  }
}
