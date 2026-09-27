/**
 * 合成オーバーレイの構成の読み書き（管理用APIの呼び出し）
 *
 * 構成（どの段にどの素材をどこへ置くか）は Worker（KVの overlay-layout）が持ち、2つの経路から読まれる。
 * - 管理画面（/overlay/ のページ）: 配信者のセッションで /api/admin/overlay/layout を読み書きする
 * - 合成ページ（overlay/stage/）: オーバーレイ用キーで /api/overlay/layout を読むだけ（api.ts）
 *
 * どちらも同じ形を受け取るので、形の確かめ（api.ts の readOverlays）を共有する（focus/api.ts と同じ作り）。
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 値の検証（オーバーレイの名前の書式・位置と大きさの範囲）は Worker（worker/overlay-layout.ts）だけが持つ。
 * 画面は空欄を0に丸めず、そのまま送って返ってきた問題点を並べる（issue #86 で決めた「画面とWorkerで
 * 二重に持たない」と同じ）。位置と大きさが空欄のときは NaN のまま渡され、JSONでは null になる。
 * 注意: worker/ の型はブラウザ用のコードから読み込まない約束なので、応答の形はここで確かめる（Fail-Fast）。
 */
import { createCaller } from '../core/api'
import { readOverlays } from './api'
import type { Overlay } from './layout'

const PATH = '/api/admin/overlay/layout'

/** 管理画面からの読み書き */
export interface OverlayLayoutAdminApi {
  /** 保存済みの構成を読む。まだ何も置いていなければ空の配列 */
  load(): Promise<Overlay[]>
  /**
   * 構成を保存する。オーバーレイの中の素材の並びがそのまま重ねる順（あとのものが前）になる。
   *
   * @returns 保存された構成（Workerが検証して返したもの）
   */
  save(overlays: readonly Overlay[]): Promise<Overlay[]>
}

/**
 * 管理画面からの読み書きを組み立てる。
 *
 * セッションのクッキーと Origin ヘッダーはブラウザが付けるので、ここでは何もしない。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 */
export const createOverlayLayoutAdminApi = (fetchImpl: typeof fetch): OverlayLayoutAdminApi => {
  const call = createCaller(fetchImpl)

  return {
    load: async () => readOverlays(await call(PATH)),

    save: async (overlays) =>
      readOverlays(
        await call(PATH, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overlays }),
        }),
      ),
  }
}
