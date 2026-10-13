/**
 * VRMの演出で出すモデルの設定（issue #358）
 *
 * VRMの演出（動作 vrm）で出すキャラクターの VRM を、管理画面（/triggers/）から受け取って検証し、ストア（KV）に保存する。
 * 出すのは合成ページの素材「VRM」で、ここは設定の形と保存先だけを扱う。
 * 設定は VRMの演出として1つだけ持ち、どのトリガーと試し再生も同じモデルを出す。
 *
 * VRM は配信者が R2（MEDIA）にアップロードしたものを使う（再配布できないモデルを、公開しているリポジトリに入れられないため）。
 * 作りはペロペロの効果音（lick-sound.ts）と同じで、問題点はすべて集めてから拒否する。
 *
 * 注意: モデルが空（null）なのは「まだ選んでいない」状態で、ほかのモデルで埋めない。演出を流すときに投げる（playbackVrmModelOf）。
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。選ばれている素材は削除させない（admin-routes.ts）。
 * 注意: 形は管理画面の読み取り（src/vrm/model.ts）と合わせる。worker/ から src/ の型は読み込まない約束なので、ここで持ち直す。
 */
import { ConfigError, mediaPath, type MediaKind } from './alert-config'
import type { KeyValueStore } from './store'

/** 保存する VRM の設定 */
export interface VrmModel {
  /** 出す VRM の素材のID。まだ選んでいなければ null */
  readonly model: string | null
}

const MODEL_KEY = 'vrm-model'
/** 問題点のメッセージに出す、何の設定かの名前 */
const MODEL_SUBJECT = 'VRMの演出のモデル'

/** 未保存のときの設定。モデルはリポジトリに入れられないので、選んでいない状態から始める */
export const DEFAULT_VRM_MODEL: VrmModel = { model: null }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 管理画面から送られてきた VRM の設定を検証し、保存用の形にする。
 *
 * @param input `{ model: 素材のID | null }`
 * @param kindOfMedia 素材のIDから種類を引く。無い素材なら null
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseVrmModel = (input: unknown, kindOfMedia: (mediaId: string) => MediaKind | null): VrmModel => {
  if (!isRecord(input) || Array.isArray(input)) throw new ConfigError(MODEL_SUBJECT, ['設定はオブジェクトで指定してください'])
  const { model } = input
  if (model === null) return { model }
  if (typeof model !== 'string') throw new ConfigError(MODEL_SUBJECT, ['model: 素材のIDか null で指定してください'])
  const kind = kindOfMedia(model)
  if (kind === null) throw new ConfigError(MODEL_SUBJECT, [`model: 素材「${model}」が存在しません`])
  if (kind !== 'vrm') throw new ConfigError(MODEL_SUBJECT, [`model: 素材「${model}」は VRM ではありません`])
  return { model }
}

export const saveVrmModel = (store: KeyValueStore, model: VrmModel): Promise<void> => store.put(MODEL_KEY, JSON.stringify(model))

/** 保存済みの VRM の設定を読む。未保存ならモデルを選んでいない設定を返す */
export const loadVrmModel = async (store: KeyValueStore): Promise<VrmModel> => {
  const text = await store.get(MODEL_KEY)
  return text === null ? DEFAULT_VRM_MODEL : (JSON.parse(text) as VrmModel)
}

/** その素材が VRM の演出に選ばれているか（選ばれている素材は削除させない） */
export const vrmModelUses = (model: VrmModel, mediaId: string): boolean => model.model === mediaId

/**
 * 合成ページへ押し出す VRM のURLを組み立てる。素材のIDを、VRM を読むパス（オーバーレイ用キーつき）に置き換える。
 *
 * @param overlayKey オーバーレイ用キー。未発行なら null
 * @throws モデルを選んでいない場合・オーバーレイ用キーが未発行の場合（何も映らない演出を黙って流さない）
 */
export const playbackVrmModelOf = (model: VrmModel, overlayKey: string | null): string => {
  if (model.model === null) throw new Error('VRMの演出で出す VRM が選ばれていません。トリガーのページの「VRM」で選んでください')
  if (overlayKey === null) throw new Error('オーバーレイ用キーが未発行のため、VRM のURLを作れません。管理画面にログインしてください')
  return mediaPath(model.model, overlayKey)
}
