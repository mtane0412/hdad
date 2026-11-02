/**
 * 描画の間引き
 *
 * 管理画面のプレビューは編集画面と描画の経路を取り合うので、合成ページの描画ループ（src/overlay/stage.ts の
 * startDrawLoop）を一定の頻度に抑える。素材の描画は経過時間だけから決まるので、間引いても動きの速さは変わらない。
 * 時刻もタイマーも持ち込まない計算だけを置くので、ここだけを取り出してテストできる。
 */

const MILLISECONDS_PER_SECOND = 1000

/**
 * フレームごとに「このフレームを描くか」を答える関数を作る。
 *
 * 前に描いた時刻から数えるのではなく、間隔の刻みに揃えて数える。画面の更新の刻みとの端数を捨てると、
 * そのぶん毎回遅れて指定より低い頻度になるためである。長く止まったあとは端数だけを残すので、続けて描かない。
 *
 * @param framesPerSecond 描く頻度（1秒あたりの回数）
 * @returns 経過時間（ミリ秒）を受け取り、描くなら真を返す関数
 * @throws 0以下の頻度が指定された場合
 */
export const createFrameGate = (framesPerSecond: number): ((elapsedMs: number) => boolean) => {
  if (framesPerSecond <= 0) throw new Error(`描画の頻度は0より大きくしてください: ${framesPerSecond}`)
  const intervalMs = MILLISECONDS_PER_SECOND / framesPerSecond
  let lastDrawnMs: number | undefined
  return (elapsedMs) => {
    if (lastDrawnMs === undefined) {
      lastDrawnMs = elapsedMs
      return true
    }
    const passedMs = elapsedMs - lastDrawnMs
    if (passedMs < intervalMs) return false
    lastDrawnMs = elapsedMs - passedMs % intervalMs
    return true
  }
}
