/**
 * ツイスターの呼び出しの組み立て（issue #272）
 *
 * レイドのトリガー（alert-actions.ts）と管理画面の試し再生（twister-routes.ts）が、合成ページの素材「ツイスター」へ押し出す呼び出しを作る。
 * 呼び出しは対戦の種と2人（0番: レイドした人、1番: 配信者）の名前とアイコンと、対戦のあいだ流す BGM の設定だけを持ち、対戦の中身（指示・倒れ方・勝敗）は
 * 合成ページが種から計算する（src/twister/game.ts）。Worker は対戦を計算しない（倒れ込みの物理が Workers Free の CPU の上限に収まらないため）。
 *
 * 注意: 形は合成ページの読み取り（src/twister/call.ts の parseTwisterCall）と合わせる。worker/ から src/ の型は読み込まない約束なので、ここで持ち直す。
 * 注意: Twitch がアイコンを返さなかった人（消えたアカウントなど）は iconUrl を null にし、合成ページは名前の頭文字の顔で流す（対戦は止めない）。
 */
import type { TwisterTrigger } from './alert-event'
import type { TwisterPlaybackSound } from './twister-sound'

/** 対戦する1人 */
export interface TwisterPlayer {
  readonly name: string
  /** 顔に貼るアイコン画像の URL。映すアイコンが無ければ null */
  readonly iconUrl: string | null
}

/** 1回の対戦の呼び出し */
export interface TwisterCall {
  readonly id: string
  /** 対戦の種（0 以上 2^32 未満の整数） */
  readonly seed: number
  /** 0番がレイドした人、1番が配信者 */
  readonly players: readonly [TwisterPlayer, TwisterPlayer]
  /** 対戦のあいだ流す BGM（twister-sound.ts の playbackTwisterSoundOf で音声のURLにしたもの） */
  readonly sound: TwisterPlaybackSound
}

/** 試し再生で、レイドした人の代わりに出す名前 */
const DEMO_RAIDER_NAME = 'レイドした人（試し）'
/** 試し再生で、配信者に出す名前（試し再生はレイドの通知を持たないので、配信者の表示名を知らない） */
const DEMO_BROADCASTER_NAME = '配信者'

/**
 * レイドで対戦する2人から呼び出しを作る。
 *
 * @param icons ユーザーIDごとのアイコンの URL（twitch.ts の getProfileImageUrls の結果）
 * @param broadcasterId 配信者のユーザーID（アイコンを引くのに使う）
 */
export const twisterCallOf = (
  raid: TwisterTrigger,
  icons: Readonly<Record<string, string>>,
  broadcasterId: string,
  sound: TwisterPlaybackSound,
  seed: number,
  id: string,
): TwisterCall => ({
  id,
  seed,
  players: [
    { name: raid.raiderName, iconUrl: icons[raid.raiderId] ?? null },
    { name: raid.broadcasterName, iconUrl: icons[broadcasterId] ?? null },
  ],
  sound,
})

/**
 * 管理画面の試し再生の呼び出しを作る。配信者は自分のアイコンで対戦し、BGM はレイドと同じ設定で流す。
 *
 * @param raider レイドしてきたとみなす相手。null なら試しの相手（アイコンなし）で対戦する
 */
export const demoTwisterCallOf = (
  raider: TwisterPlayer | null,
  broadcasterIcon: string | null,
  sound: TwisterPlaybackSound,
  seed: number,
  id: string,
): TwisterCall => ({
  id,
  seed,
  players: [
    raider ?? { name: DEMO_RAIDER_NAME, iconUrl: null },
    { name: DEMO_BROADCASTER_NAME, iconUrl: broadcasterIcon },
  ],
  sound,
})

/**
 * 乱数の32ビットの値を対戦の種にする。呼び出し側は crypto.getRandomValues(new Uint32Array(1)) を渡す。
 *
 * @throws 値が入っていない場合
 */
export const twisterSeedOf = (random: Uint32Array): number => {
  const seed = random[0]
  if (seed === undefined) throw new Error('ツイスターの種にする乱数がありません')
  return seed
}
