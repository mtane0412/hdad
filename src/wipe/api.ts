/**
 * ワイプのWorkerの呼び出し
 *
 * 合成ページの素材「ワイプ」が、発言した人のアイコンのURLをオーバーレイ用キーで /api/overlay/wipe/icon から引く
 * （チャットは匿名IRCで受けるのでアイコンが届かないため）。呼び出しと失敗の扱いは `../core/api` に任せ、
 * fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の形はここで確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。
 */
import { createCaller, isRecord } from '../core/api'

const ICON_PATH = '/api/overlay/wipe/icon'

export interface WipeOverlayApi {
  /** ログイン名から、その人のアイコンのURLを引く */
  lookupIcon(login: string): Promise<string>
}

/**
 * オーバーレイからの呼び出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createWipeOverlayApi = (fetchImpl: typeof fetch, key: string): WipeOverlayApi => {
  const call = createCaller(fetchImpl)

  return {
    lookupIcon: async (login) => {
      const body = await call(`${ICON_PATH}?${new URLSearchParams({ key, login }).toString()}`)
      if (!isRecord(body) || typeof body.profileImageUrl !== 'string') {
        throw new Error(`Workerの ${ICON_PATH} の応答が想定した形ではありません`)
      }
      return body.profileImageUrl
    },
  }
}
