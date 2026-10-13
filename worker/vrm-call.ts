/**
 * VRMのマスコットの反応の呼び出しの組み立て（issue #358・#359）
 *
 * トリガー（alert-actions.ts）と管理画面の試し再生（vrm-routes.ts）が、合成ページの素材「VRM」へ押し出す呼び出しを作る。
 * 呼び出しは動き方の種と反応の種類と、出す VRM のURL（オーバーレイ用キーつき）だけを持ち、
 * 動きの中身（どちらの手で何回振るか・何回うなずくか）は合成ページが種と反応の種類から計算する（src/vrm/motion.ts）。
 *
 * 反応の種類は、トリガーの項目ごとに決め切る（vrmReactionOf。配信者が選ぶ欄を持たない。docs/decisions/vrm.md）。
 *
 * 注意: 形と反応の種類の一覧は合成ページの読み取り（src/vrm/call.ts の parseVrmCall・VRM_REACTIONS）と合わせる。
 * worker/ から src/ の型は読み込まない約束なので、ここで持ち直す（一致は vrm-call.test.ts が確かめる）。
 */
import type { TriggerKind } from './trigger-menu'

/** 反応の種類（お礼・大喜び・手を振る・うなずく） */
export const VRM_REACTIONS = ['thanks', 'cheer', 'wave', 'nod'] as const

export type VrmReactionKind = (typeof VRM_REACTIONS)[number]

/** 1回の反応の呼び出し */
export interface VrmCall {
  readonly id: string
  /** 動き方の種（0 以上 2^32 未満の整数） */
  readonly seed: number
  /** 反応の種類 */
  readonly reaction: VrmReactionKind
  /** 出す VRM のURL（vrm-model.ts の playbackVrmModelOf で作ったもの） */
  readonly model: string
}

/**
 * トリガーの項目ごとの反応。
 *
 * - お礼（手を振ってお辞儀）: 支えてもらった出来事（フォロー・サブスク・チャンネルポイント）
 * - 大喜び（両手を上げる）: 大きな出来事（レイド・PRのマージ）
 * - 手を振る: 来た人への挨拶と、場面の切り替わりで迎える出来事（休憩の始まり・広告の終わり）
 * - うなずく: たくさん届くふだんの出来事（発言・コミット・作業の始まり・広告の始まり）。速いチャットでは反応の最中に届いたぶんを捨てる
 */
const REACTION_OF_KIND: Readonly<Record<TriggerKind, VrmReactionKind>> = {
  newViewer: 'wave',
  comeback: 'wave',
  welcome: 'wave',
  everyMessage: 'nod',
  keyword: 'nod',
  fromUser: 'nod',
  fromUserFirstOfStream: 'wave',
  reward: 'thanks',
  follow: 'thanks',
  subscribe: 'thanks',
  resubscribe: 'thanks',
  raid: 'cheer',
  adBreakBegin: 'nod',
  adBreakEnd: 'wave',
  commitPushed: 'nod',
  pullRequestMerged: 'cheer',
  pomodoroWorkBegin: 'nod',
  pomodoroBreakBegin: 'wave',
}

/** トリガーの項目から反応の種類を決める */
export const vrmReactionOf = (kind: TriggerKind): VrmReactionKind => REACTION_OF_KIND[kind]

/**
 * 試し再生の反応の種類を種から選ぶ（どの反応も試しに見られるように）。
 *
 * @throws 起こりえないが、一覧から引けなかった場合
 */
export const vrmDemoReactionOf = (seed: number): VrmReactionKind => {
  const reaction = VRM_REACTIONS[seed % VRM_REACTIONS.length]
  if (reaction === undefined) throw new Error('試し再生の反応を選べません')
  return reaction
}

/** 出す VRM のURLと種と反応の種類から呼び出しを作る */
export const vrmCallOf = (model: string, seed: number, reaction: VrmReactionKind, id: string): VrmCall => ({ id, seed, reaction, model })

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
