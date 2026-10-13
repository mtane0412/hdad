/**
 * VRMのマスコットの、Worker とのつなぎ方
 *
 * 合成ページの素材「VRM」は、出しっぱなしにするマスコットの VRM のURLを起動時と再接続時に読み（VRM_MASCOT_MODEL_PATH）、
 * 反応の呼び出し（種と VRM のURL）を WebSocket（VRM_SOCKET_PATH）で押し出してもらう。
 * プレビュー（?demo=true）だけは Worker の押し出しにつながず、配信者のセッションで出す VRM の設定（VRM_MODEL_PATH）を1回読み、
 * その素材を読み込んで決まった種の演出をくり返す（プレビューは管理画面の中で開くので、セッションがある）。
 */
import { createCaller, isRecord } from '../core/api'
import { VRM_MEDIA_PATH } from './call'
import { readVrmModel } from './model'

/** 呼び出しを受け取る WebSocket の経路（worker/vrm-routes.ts） */
export const VRM_SOCKET_PATH = '/api/overlay/vrm/socket'

/** マスコットとして読み込む VRM のURLを読む経路（worker/vrm-routes.ts。オーバーレイ用キーが要る） */
export const VRM_MASCOT_MODEL_PATH = '/api/overlay/vrm/model'

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

/**
 * 配信中のマスコットとして読み込む VRM のURLを、オーバーレイ用キーで読む。
 *
 * @throws 読めない場合（VRM を選んでいない409は Worker の理由のまま）・URLが素材の経路でない場合（よそのファイルを読み込まない）
 */
export const fetchMascotModelUrl = async (fetchImpl: typeof fetch, key: string): Promise<string> => {
  const body = await createCaller(fetchImpl)(`${VRM_MASCOT_MODEL_PATH}?key=${encodeURIComponent(key)}`)
  if (!isRecord(body) || typeof body.model !== 'string' || !body.model.startsWith(VRM_MEDIA_PATH)) {
    throw new Error('マスコットの VRM のURLが想定した形ではありません')
  }
  return body.model
}
