/**
 * VRMの演出で出すモデルの設定の形（issue #358）
 *
 * 出す VRM の素材のIDを1つだけ持つ（まだ選んでいなければ null）。管理画面が Worker の応答を読むとき（src/admin/api.ts）と、
 * 合成ページのプレビューが設定を読むとき（api.ts）に使う。値の検証（素材が VRM か）は Worker（worker/vrm-model.ts）だけが持ち、ここは形だけを見る。
 *
 * 注意: 通信も DOM も持ち込まない。
 * 注意: 形が違う設定は補わずに投げる（Fail-Fast）。欠けた設定を「選んでいない」と読むと、壊れた設定に気づけないため。
 */
import { isRecord } from '../core/api'

export interface VrmModel {
  /** 出す VRM の素材のID。まだ選んでいなければ null */
  readonly model: string | null
}

/**
 * Worker が返した VRM の設定を読む。
 *
 * @throws モデルが素材のIDか null でない場合
 */
export const readVrmModel = (value: unknown): VrmModel => {
  if (!isRecord(value) || (value.model !== null && typeof value.model !== 'string')) {
    throw new Error('WorkerのVRMの演出のモデルの設定が想定した形ではありません')
  }
  return { model: value.model }
}
