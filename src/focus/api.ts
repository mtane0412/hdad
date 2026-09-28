/**
 * 注目コメントの読み書き（Workerの呼び出し）
 *
 * 取り上げているものは Worker（KVの focus-target）が持ち、2つの経路から読まれる。
 * - 管理画面（/focus/ のページ）: 配信者のセッションで /api/admin/focus を読み書きする
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
import { createCaller, isRecord, readList } from '../core/api'
import type { FocusTarget } from './focused'

const ADMIN_PATH = '/api/admin/focus'
const ADMIN_MESSAGES_PATH = '/api/admin/focus/messages'
const OVERLAY_PATH = '/api/overlay/focus'

/** 取り上げる発言を選ぶ一覧の1件。worker/stream-chat-store.ts の PickableChatMessage と合わせる */
export interface PickableMessage {
  messageId: string
  login: string
  displayName: string
  text: string
  /** 届いた日時（ISO 8601） */
  at: string
}

/** 応答から取り上げているものを読む。想定した形でなければエラーにする */
const readFocusTarget = (body: unknown, path: string): FocusTarget | null => {
  const 違う形 = new Error(`Workerの ${path} の応答が想定した形ではありません`)
  if (!isRecord(body) || !('target' in body)) throw 違う形
  const target: unknown = body.target
  if (target === null) return null
  if (!isRecord(target)) throw 違う形

  if (target.type === 'viewer' && typeof target.login === 'string') {
    return { type: 'viewer', login: target.login }
  }
  if (
    target.type === 'message' &&
    typeof target.messageId === 'string' &&
    typeof target.login === 'string' &&
    typeof target.displayName === 'string' &&
    typeof target.text === 'string'
  ) {
    return { type: 'message', messageId: target.messageId, login: target.login, displayName: target.displayName, text: target.text }
  }
  throw 違う形
}

/** 取り上げる発言を選ぶ一覧の1件として読めるか */
const isPickableMessage = (value: unknown): value is PickableMessage =>
  isRecord(value) &&
  typeof value.messageId === 'string' &&
  typeof value.login === 'string' &&
  typeof value.displayName === 'string' &&
  typeof value.text === 'string' &&
  typeof value.at === 'string'

/** 管理画面からの読み書き */
export interface FocusApi {
  /** いま取り上げているものを読む。取り上げていなければ null */
  load(): Promise<FocusTarget | null>
  /** 取り上げるものを保存する（外すときは null）。検証はWorkerが行う */
  save(target: FocusTarget | null): Promise<FocusTarget | null>
  /** 取り上げる発言を選ぶための、いま進んでいる配信の直近の発言（新しい順） */
  recent(): Promise<PickableMessage[]>
}

/** オーバーレイからの読み出し */
export interface FocusOverlayApi {
  /** いま取り上げているものを読む */
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

    save: async (target) =>
      readFocusTarget(
        await call(ADMIN_PATH, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target }),
        }),
        ADMIN_PATH,
      ),

    recent: async () => readList(await call(ADMIN_MESSAGES_PATH), 'messages', isPickableMessage),
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
