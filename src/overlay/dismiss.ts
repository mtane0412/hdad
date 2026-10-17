/**
 * 演出を消す合図（下部バーの「演出を消す」）
 *
 * 下部バーが POST /api/admin/overlay/dismiss を呼ぶと、Worker は締め切った意見ボードを片付けてから、
 * 合成ページへ合図を押し出す（worker/admin-routes.ts の postOverlayDismiss）。合成ページは合図を受けたら、
 * 素材ごとに再生中の一時的な演出を終わらせ、待っている演出はそのまま流す（stage.ts の watchDismiss）。
 *
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、合図の形はここで確かめる（Fail-Fast）。
 */
import { createCaller, isRecord } from '../core/api'

const ADMIN_PATH = '/api/admin/overlay/dismiss'

/** 演出を消す合図が押し出されてくる経路（WebSocket） */
export const DISMISS_SOCKET_PATH = '/api/overlay/dismiss/socket'

/** 一度もつながらないまま閉じたときに出す、いちばんありそうな原因 */
export const DISMISS_SOCKET_HINT = '演出を消す合図の配送先につながりません（下部バーの「演出を消す」が届きません）。URLのオーバーレイ用キーが正しいか確かめてください'

/** 下部バーからの呼び出し */
export interface OverlayDismissApi {
  /** 合成ページに出ている演出を消すよう Worker に頼む。合成ページへ送れなければ投げる */
  dismiss(): Promise<void>
}

/**
 * 下部バーからの呼び出しを組み立てる。セッションのクッキーと Origin ヘッダーはブラウザが付ける。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createOverlayDismissApi = (fetchImpl: typeof fetch): OverlayDismissApi => {
  const call = createCaller(fetchImpl)
  return {
    dismiss: async () => {
      await call(ADMIN_PATH, { method: 'POST' })
    },
  }
}

/**
 * 押し出された合図を読む。合図でなければ投げる。
 *
 * @throws JSON でない・type が dismiss でない場合
 */
export const parseOverlayDismiss = (text: string): void => {
  const body: unknown = JSON.parse(text)
  if (!isRecord(body) || body.type !== 'dismiss') throw new Error('演出を消す合図として読めない中身が届きました')
}
