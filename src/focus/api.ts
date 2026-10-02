/**
 * 注目コメントの読み書き（Workerの呼び出し）
 *
 * 取り上げている発言1件は Worker（KVの focus-comment）が持ち、2つの経路から読まれる。
 * - 管理画面（コメントの画面 /comments/）: 配信者のセッションで /api/admin/focus を読み書きする
 * - 合成ページ（overlay/stage/ の「注目コメント」の素材）: オーバーレイ用キーで /api/overlay/focus を読むだけ
 *
 * どちらも同じ形を受け取るので、形の確かめ（readFocusTarget）をここで共有する（読み上げの api.ts と同じ作り）。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の型はここで定義して形を確かめる。
 * 想定した形でなければエラーにする（Fail-Fast）。黙って「取り上げていない」に倒すと、Workerの作りが変わって
 * 届かなくなっていても、配信中は「まだ取り上げていない」と見分けが付かない。
 * 注意: 値の検証（ログイン名の書式・本文の長さ）は Worker（worker/focus-config.ts）だけが持つ。
 */
import { createCaller, isRecord } from '../core/api'
import type { FocusTarget } from './focused'

const ADMIN_PATH = '/api/admin/focus'
const OVERLAY_PATH = '/api/overlay/focus'

/**
 * 管理画面が選んで送る発言1件。worker/focus-config.ts の FocusPick と合わせる。
 * アイコンのURLは送らない（Worker が Twitch から引いて添え、FocusTarget にして返す）
 */
export type FocusPick = Omit<FocusTarget, 'profileImageUrl'>

/** 応答から取り上げている1件を読む。想定した形でなければエラーにする */
const readFocusTarget = (body: unknown, path: string): FocusTarget | null => {
  const wrongShape = new Error(`Workerの ${path} の応答が想定した形ではありません`)
  if (!isRecord(body) || !('target' in body)) throw wrongShape
  const target: unknown = body.target
  if (target === null) return null
  if (
    !isRecord(target) ||
    typeof target.messageId !== 'string' ||
    typeof target.login !== 'string' ||
    typeof target.displayName !== 'string' ||
    typeof target.text !== 'string' ||
    typeof target.profileImageUrl !== 'string'
  ) {
    throw wrongShape
  }
  return {
    messageId: target.messageId,
    login: target.login,
    displayName: target.displayName,
    text: target.text,
    profileImageUrl: target.profileImageUrl,
  }
}

/** 管理画面からの読み書き */
export interface FocusApi {
  /** いま取り上げているものを読む。取り上げていなければ null */
  load(): Promise<FocusTarget | null>
  /** 選んだ発言を取り上げる（外すときは null）。検証とアイコンの取得はWorkerが行い、アイコンを添えた1件が返る */
  save(pick: FocusPick | null): Promise<FocusTarget | null>
}

/** オーバーレイからの読み出し */
export interface FocusOverlayApi {
  /** いま取り上げている1件を読む */
  read(): Promise<FocusTarget | null>
}

/**
 * 管理画面からの読み書きを組み立てる。
 *
 * セッションのクッキーと Origin ヘッダーはブラウザが付けるので、ここでは何もしない。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createFocusApi = (fetchImpl: typeof fetch): FocusApi => {
  const call = createCaller(fetchImpl)

  return {
    load: async () => readFocusTarget(await call(ADMIN_PATH), ADMIN_PATH),

    save: async (pick) =>
      readFocusTarget(
        await call(ADMIN_PATH, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: pick }),
        }),
        ADMIN_PATH,
      ),
  }
}

/**
 * オーバーレイからの読み出しを組み立てる。
 *
 * 合成ページはOBSに載せるページなのでログインを持たず、オーバーレイ用キー（URLの ?key=）で
 * Worker に受け付けてもらう（サイドスーパー・読み上げと同じ）。
 *
 * @param fetchImpl 通信の実装
 * @param key オーバーレイ用キー
 */
export const createFocusOverlayApi = (fetchImpl: typeof fetch, key: string): FocusOverlayApi => {
  const call = createCaller(fetchImpl)
  const path = `${OVERLAY_PATH}?key=${encodeURIComponent(key)}`

  return {
    read: async () => readFocusTarget(await call(path), OVERLAY_PATH),
  }
}
