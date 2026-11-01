/**
 * 素材の canvas を描くときの画素比
 *
 * 素材は canvas の解像度を「箱のCSS上の大きさ × 画素比」で決める（src/core/mount.ts・three.js を使う各素材の view.ts）。
 * 管理画面のプレビューは実寸で描いて縮小して映すので、Retina の画素比2のままでは表示に要らない画素を
 * 描くことになる（1枚 3840×2160）。そこでプレビューだけ上限を設ける。上限はページに1つで、起動のときに
 * 合成ページ（src/overlay/stage.ts）が決める。配信画面では決めないので、これまでどおり画面の画素比で描く。
 */

/** 画素比の上限。決めていないあいだは上限なし */
let limit = Number.POSITIVE_INFINITY

/**
 * 画素比の上限を決める。
 *
 * @param maxRatio 上限（0より大きい数）
 * @throws 0以下の上限が指定された場合
 */
export const limitRenderRatio = (maxRatio: number): void => {
  if (maxRatio <= 0) throw new Error(`画素比の上限は0より大きくしてください: ${maxRatio}`)
  limit = maxRatio
}

/** いま描くときに使う画素比（画面の画素比は窓を移すと変わるので、フレームごとに呼ぶ） */
export const renderRatio = (): number => Math.min(window.devicePixelRatio, limit)
