/**
 * 手書きで描いたものの読み書き（Workerの呼び出し）
 *
 * 描いたものは Worker（KVの draw-strokes）が持ち、2つの経路から読まれる（注目コメントの api.ts と同じ作り）。
 * - 描く画面（/draw/）: 配信者のセッションで /api/admin/draw/strokes を読み書きする
 * - 合成ページ（overlay/stage/ の「手書き」の素材）: オーバーレイ用キーで /api/overlay/draw/strokes を読むだけ
 *
 * どちらも同じ形を受け取るので、形の確かめ（readStrokes）をここで共有する。呼び出しと失敗の扱いは
 * `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の形はここで確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って「何も描かれていない」に倒すと、保存した図が
 * 出ない理由が配信中に分からない。
 * 描く画面は、背景に敷く配信画面の1枚（/api/admin/draw/background）もここから読む。Workerが返すのは Gyazo の
 * 画像のURLで、画像そのものはブラウザが Gyazo から直接読む。状態コードで「新しい1枚」「変わっていない」
 * 「まだ無い」を読み分けるので、JSONの呼び出し（createCaller）は使わない。
 *
 * 注意: 保存する値の検証（線の本数・点の数）は Worker（worker/draw-config.ts）が持つ。1本ぶんとして
 * 読めるかの判定だけは src/draw/strokes.ts の isStroke を両方が使う。
 */
import { createCaller, isRecord, toApiError } from '../core/api'
import { isStroke, type Strokes } from './strokes'

const ADMIN_PATH = '/api/admin/draw/strokes'
const OVERLAY_PATH = '/api/overlay/draw/strokes'
const BACKGROUND_PATH = '/api/admin/draw/background'

/** 背景の画像を読み込んでよい場所。Gyazo の画像の置き場だけにし、知らない場所の画像は背景に読み込まない */
const GYAZO_IMAGE_ORIGIN = 'https://i.gyazo.com'

/** 変わっていない（手元の1枚のまま） */
const NOT_MODIFIED = 304
/** まだ1枚も無い */
const NO_CONTENT = 204

/** 背景の1枚を読んだ結果 */
export type DrawBackgroundResult =
  /** まだ1枚も無い（配信中に画面の取り込みを動かしたことがない） */
  | { readonly kind: 'none' }
  /** 手元の1枚から変わっていない */
  | { readonly kind: 'unchanged' }
  /** 新しい1枚 */
  | {
      readonly kind: 'image'
      /** 画像そのもののURL（Gyazo） */
      readonly url: string
      /** 次に読むときに添える印。同じ1枚なら画像を送らずに済む */
      readonly etag: string
      /** 撮った時刻（ミリ秒） */
      readonly capturedAt: number
    }

/** 応答から描かれた線の集まりを読む。想定した形でなければエラーにする */
const readStrokes = (body: unknown, path: string): Strokes => {
  const wrongShape = new Error(`Workerの ${path} の応答が想定した形ではありません`)
  const strokes: unknown = isRecord(body) ? body.strokes : undefined
  if (!Array.isArray(strokes) || !strokes.every(isStroke)) throw wrongShape
  return { strokes }
}

/** 描く画面からの読み書き */
export interface DrawApi {
  /** 保存されている線を読む。一度も描いていなければ空の集まり */
  load(): Promise<Strokes>
  /** 描いたものを保存する（全消しの直後は空の集まりを送る）。検証はWorkerが行う */
  save(strokes: Strokes): Promise<void>
  /**
   * 背景に敷く配信画面の1枚を読む。
   *
   * @param etag 手元にある1枚の印（まだ無ければ null）
   */
  loadBackground(etag: string | null): Promise<DrawBackgroundResult>
}

/** 合成ページからの読み出し */
export interface DrawOverlayApi {
  /** 保存されている線を読む */
  read(): Promise<Strokes>
}

/**
 * 描く画面からの読み書きを組み立てる。
 *
 * セッションのクッキーと Origin ヘッダーはブラウザが付けるので、ここでは何もしない。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createDrawApi = (fetchImpl: typeof fetch): DrawApi => {
  const call = createCaller(fetchImpl)

  return {
    load: async () => readStrokes(await call(ADMIN_PATH), ADMIN_PATH),

    save: async ({ strokes }) => {
      await call(ADMIN_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strokes }),
      })
    },

    loadBackground: async (etag) => {
      const response = await fetchImpl(BACKGROUND_PATH, etag === null ? {} : { headers: { 'If-None-Match': etag } })
      if (response.status === NOT_MODIFIED) return { kind: 'unchanged' }
      if (response.status === NO_CONTENT) return { kind: 'none' }
      if (!response.ok) throw toApiError(response.status, await response.json().catch(() => null))
      const newMarker = response.headers.get('ETag')
      const body: unknown = await response.json().catch(() => null)
      const url: unknown = isRecord(body) ? body.url : undefined
      const capturedAt: unknown = isRecord(body) ? body.capturedAt : undefined
      if (newMarker === null || typeof url !== 'string' || !url.startsWith(`${GYAZO_IMAGE_ORIGIN}/`) || typeof capturedAt !== 'number') {
        throw new Error(`Workerの ${BACKGROUND_PATH} の応答が想定した形ではありません`)
      }
      return { kind: 'image', url, etag: newMarker, capturedAt }
    },
  }
}

/**
 * 合成ページからの読み出しを組み立てる。
 *
 * 合成ページはOBSに載せるページなのでログインを持たず、オーバーレイ用キー（URLの ?key=）で
 * Worker に受け付けてもらう（注目コメント・読み上げと同じ）。
 *
 * @param fetchImpl 通信の実装
 * @param key オーバーレイ用キー
 */
export const createDrawOverlayApi = (fetchImpl: typeof fetch, key: string): DrawOverlayApi => {
  const call = createCaller(fetchImpl)
  const path = `${OVERLAY_PATH}?key=${encodeURIComponent(key)}`

  return {
    read: async () => readStrokes(await call(path), OVERLAY_PATH),
  }
}
