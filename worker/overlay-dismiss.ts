/**
 * 演出を消す合図（下部バーの「演出を消す」）
 *
 * 合成ページへ押し出す中身は、合図であることを示す type だけを持つ。何を消すかは合成ページの素材ごとに決める
 * （再生中の一時的な演出は終わらせ、待っている演出はそのまま流す。src/overlay/stage.ts の watchDismiss）。
 */

/** 合成ページへ押し出す、演出を消す合図 */
export interface OverlayDismiss {
  readonly type: 'dismiss'
}

/** 押し出す合図（中身は毎回同じ） */
export const OVERLAY_DISMISS: OverlayDismiss = { type: 'dismiss' }
