/**
 * VRMの演出の呼び出しの組み立て（issue #358）
 *
 * トリガー（alert-actions.ts）と管理画面の試し再生（vrm-routes.ts）が、合成ページの素材「VRM」へ押し出す呼び出しを作る。
 * 呼び出しは動き方の種と、出す VRM のURL（オーバーレイ用キーつき）だけを持ち、
 * 動きの中身（どちらから出てくるか・何回手を振るか）は合成ページが種から計算する（src/vrm/motion.ts）。
 *
 * 注意: 形は合成ページの読み取り（src/vrm/call.ts の parseVrmCall）と合わせる。worker/ から src/ の型は読み込まない約束なので、ここで持ち直す。
 */

/** 1回のVRMの演出の呼び出し */
export interface VrmCall {
  readonly id: string
  /** 動き方の種（0 以上 2^32 未満の整数） */
  readonly seed: number
  /** 出す VRM のURL（vrm-model.ts の playbackVrmModelOf で作ったもの） */
  readonly model: string
}

/** 出す VRM のURLと種から呼び出しを作る */
export const vrmCallOf = (model: string, seed: number, id: string): VrmCall => ({ id, seed, model })

/**
 * 乱数の32ビットの値を動き方の種にする。呼び出し側は crypto.getRandomValues(new Uint32Array(1)) を渡す。
 *
 * @throws 値が入っていない場合
 */
export const vrmSeedOf = (random: Uint32Array): number => {
  const seed = random[0]
  if (seed === undefined) throw new Error('VRMの演出の種にする乱数がありません')
  return seed
}
