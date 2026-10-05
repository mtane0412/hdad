/**
 * 市町村紹介のあいだ配信のBGMを下げておく長さ（issue #245）
 *
 * 合成ページは紹介のBGMを鳴らしはじめたとき・紹介が届いたとき・紹介を作れなかったときに、
 * 「いまから何ミリ秒、配信のBGMを下げておくか」を Worker 経由で裏方のページへ送る（src/bgm/api.ts の duck）。
 * 裏方のページは受け取ってからその長さが過ぎたら自分で戻すので、合成ページが閉じられた・知らせが届かなかったときも
 * 配信のBGMは下がったまま残らない。ここはその長さを、再生の状態と現在時刻だけから決める。
 *
 * 注意: 通信も DOM も持ち込まない（送るのは合成ページの stage.ts）。
 */
import { tourSpanOf, type Playback } from './timeline'

/**
 * 紹介を待っているあいだに下げておく長さ（ミリ秒）。
 *
 * 紹介は届くまで2〜5秒かかり、届くまで再生の終わりが決まらない。届いたら終わりまでの長さを送り直すので、
 * ここは待つ時間より十分に長く、待っているうちに合成ページが閉じられても長く下げたままにならない長さにする。
 */
export const LOADING_DUCK_HOLD_MS = 30_000

/**
 * 配信のBGMを now から下げておく長さ（ミリ秒）を決める。
 *
 * @param now 現在時刻（ミリ秒。Date.now() と同じ基準）
 * @returns 下げておく長さ。0 は「すぐ戻す」。紹介のBGMの枠が空なら下げないので null
 */
export const bgmDuckHoldOf = (playback: Playback, now: number): number | null => {
  if (playback.call.sound.slots.bgm === null) return null
  const { intro } = playback
  switch (intro.status) {
    case 'loading':
      return LOADING_DUCK_HOLD_MS
    case 'failed':
      return 0
    case 'ready': {
      const { end } = tourSpanOf(playback, intro.intro, intro.readyAt)
      return Math.max(0, playback.startedAt + end - now)
    }
  }
}
