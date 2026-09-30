/**
 * 画面の取り込みの設定の読み出しと、撮った1枚の送信（Workerの呼び出し）
 *
 * 画面の取り込みの設定は Worker（KVの screen-settings）が持ち、2つの経路から読まれる。
 * - 管理画面（/screen/ のページ）: 配信者のセッションで /api/admin/screen を読み書きする
 * - 裏方のページ（overlay/backstage/）: オーバーレイ用キーで /api/overlay/screen を読むだけ
 *
 * 受け取る形は2つに分かれる。管理画面は設定をまるごと（上げ先のコレクションを含めて）読み書きし、裏方のページは
 * 撮るのに要る設定（つなぎ先と間隔）だけを受け取る。上げるのは Worker なので、コレクションは裏方に渡らない。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の型はここで定義して形を確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って既定の設定に倒すと、配信者が変えたポートではなく
 * 既定のポートへつなぎに行って、撮れていないことに配信中ずっと気づけない。
 * 注意: 値の範囲の検証は Worker（worker/screen-config.ts）だけが持つ。画面とWorkerで二重に持たない。
 * 注意: 撮った1枚はJSONに包まず、画像そのものを本文にして送る。Base64にすると本文が4/3倍になるうえ、
 * Worker 側でも組み直しが要る。
 */
import { createCaller, isRecord } from '../core/api'

const ADMIN_PATH = '/api/admin/screen'
const OVERLAY_PATH = '/api/overlay/screen'

/** 裏方のページが撮るのに要る設定。項目と値の範囲は worker/screen-config.ts と合わせる */
export interface ScreenConnection {
  /** OBS が動いているホスト（裏方のページが起動のときにしか使わない） */
  host: string
  /** obs-websocket のポート番号（裏方のページが起動のときにしか使わない） */
  port: number
  /** obs-websocket のパスワード。空なら認証のやりとりを行わない */
  password: string
  /** 撮影の間隔（秒） */
  intervalSeconds: number
}

/** 管理画面が読み書きする設定。撮るのに要る設定に、上げ先のコレクションを追加したもの */
export interface ScreenSettings extends ScreenConnection {
  /** 上げ先の Gyazo のコレクションID。空ならコレクションに入れない */
  collectionId: string
}

/**
 * 撮るのに要る設定として読む。想定した形でなければエラーにする。
 *
 * @throws 応答が想定した形でない場合
 */
export const readScreenConnection = (body: unknown): ScreenConnection => {
  if (
    !isRecord(body) ||
    typeof body.host !== 'string' ||
    typeof body.port !== 'number' ||
    typeof body.password !== 'string' ||
    typeof body.intervalSeconds !== 'number'
  ) {
    throw new Error('Workerの画面の取り込みの設定の応答が想定した形ではありません')
  }
  return { host: body.host, port: body.port, password: body.password, intervalSeconds: body.intervalSeconds }
}

/**
 * 管理画面が読み書きする設定として読む。想定した形でなければエラーにする。
 *
 * @throws 応答が想定した形でない場合
 */
export const readScreenSettings = (body: unknown): ScreenSettings => {
  const connection = readScreenConnection(body)
  if (!isRecord(body) || typeof body.collectionId !== 'string') {
    throw new Error('Workerの画面の取り込みの設定の応答が想定した形ではありません')
  }
  return { ...connection, collectionId: body.collectionId }
}

export interface ScreenApi {
  /** 撮るのに要る設定を読む */
  read(): Promise<ScreenConnection>
  /**
   * 撮った1枚を送る。
   *
   * @returns 記録されたなら true。配信していなくてWorkerが捨てたなら false
   */
  send(image: Blob): Promise<boolean>
}

/**
 * 裏方のページからの呼び出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createScreenApi = (fetchImpl: typeof fetch, key: string): ScreenApi => {
  const call = createCaller(fetchImpl)
  const query = `?key=${encodeURIComponent(key)}`

  return {
    async read() {
      return readScreenConnection(await call(`${OVERLAY_PATH}${query}`))
    },
    async send(image) {
      const body = await call(`${OVERLAY_PATH}${query}`, {
        method: 'POST',
        headers: { 'Content-Type': image.type },
        body: image,
      })
      const recorded: unknown = isRecord(body) ? body.recorded : undefined
      if (typeof recorded !== 'boolean') throw new Error('Workerの応答に recorded がありません')
      return recorded
    },
  }
}

/** 管理画面からの読み書き（読み上げの SpeechApi と同じ形） */
export interface ScreenAdminApi {
  /** 保存済みの設定を読む。未保存なら既定の設定が返る */
  load(): Promise<ScreenSettings>
  /** 設定をまるごと置き換えて保存する。検証はWorkerが行う */
  save(settings: ScreenSettings): Promise<ScreenSettings>
}

/**
 * 管理画面からの読み書きを組み立てる。
 *
 * セッションのクッキーと Origin ヘッダーはブラウザが付けるので、ここでは何もしない。
 */
export const createScreenAdminApi = (fetchImpl: typeof fetch): ScreenAdminApi => {
  const call = createCaller(fetchImpl)
  return {
    async load() {
      return readScreenSettings(await call(ADMIN_PATH))
    },
    async save(settings) {
      return readScreenSettings(
        await call(ADMIN_PATH, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }),
      )
    },
  }
}
