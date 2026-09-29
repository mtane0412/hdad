/**
 * BGMの切り替え方の判断
 *
 * 裏方のページ（src/bgm/task.ts）は、Worker から届いた「いま流している曲」と自分が鳴らしている曲を比べて、
 * 何をするかをここで決める。音声の再生（DOM）を持たないので、判断だけを切り出してテストする。
 *
 * 曲が同じかどうかは素材のID（mediaId）で見る。曲名やクレジットを直しただけで頭から流れ直さないためである。
 */
import type { BgmNowPlaying } from './api'

/** 届いた曲に合わせるためにすること */
export type BgmChange =
  /** 何もしない */
  | { readonly type: 'none' }
  /** 鳴らしている曲のまま、音量だけを変える */
  | { readonly type: 'volume'; readonly volume: number }
  /** この曲に切り替える（何も鳴らしていなければ流し始める） */
  | { readonly type: 'switch'; readonly url: string; readonly volume: number }
  /** 止める */
  | { readonly type: 'stop' }

/**
 * 鳴らしている曲（current）を、届いた曲（next）に合わせるためにすることを決める。
 *
 * @param current いま鳴らしているもの。起動の直後で何も受け取っていなければ null
 * @param next Worker から届いた、いま流している曲
 */
export const bgmChangeOf = (current: BgmNowPlaying | null, next: BgmNowPlaying): BgmChange => {
  const playing = current?.track ?? null
  if (next.track === null) return playing === null ? { type: 'none' } : { type: 'stop' }
  if (playing === null || playing.mediaId !== next.track.mediaId) return { type: 'switch', url: next.track.url, volume: next.volume }
  if (current?.volume !== next.volume) return { type: 'volume', volume: next.volume }
  return { type: 'none' }
}
