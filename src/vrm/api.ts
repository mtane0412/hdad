/**
 * VRMの演出の、Worker とのつなぎ方
 *
 * 合成ページの素材「VRM」は、Worker から呼び出し（種と VRM のURL）を WebSocket（VRM_SOCKET_PATH）で押し出してもらう。
 * プレビュー（?demo=true）だけは Worker の押し出しにつながず、配信者のセッションで出す VRM の設定（VRM_MODEL_PATH）を1回読み、
 * その素材を読み込んで決まった種の演出をくり返す（プレビューは管理画面の中で開くので、セッションがある）。
 */
import { createCaller } from '../core/api'
import { VRM_MEDIA_PATH } from './call'
import { readVrmModel } from './model'

/** 呼び出しを受け取る WebSocket の経路（worker/vrm-routes.ts） */
export const VRM_SOCKET_PATH = '/api/overlay/vrm/socket'

/** 出す VRM の設定を読み書きする経路（worker/vrm-routes.ts。配信者のセッションが要る） */
export const VRM_MODEL_PATH = '/api/admin/vrm/model'

/** つながらないときに素材の箱に出す、直し方の手がかり */
export const VRM_SOCKET_HINT = 'VRMの演出の配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

/**
 * プレビューで読み込む VRM のURLを、出す VRM の設定から作る（オーバーレイ用キーは付けず、配信者のセッションで読む）。
 *
 * @throws 設定を読めない場合・VRM を選んでいない場合（何も映らないプレビューを黙って出さない）
 */
export const fetchPreviewModelUrl = async (fetchImpl: typeof fetch): Promise<string> => {
  const { model } = readVrmModel(await createCaller(fetchImpl)(VRM_MODEL_PATH))
  if (model === null) throw new Error('VRMの演出で出す VRM が選ばれていません。トリガーのページの「VRM」で選んでください')
  return `${VRM_MEDIA_PATH}${encodeURIComponent(model)}`
}
