/**
 * BGMの次の曲・前の曲の決め方
 *
 * 管理画面の「次の曲」「前の曲」（POST /api/admin/bgm/skip）と、裏方のページが曲の終わりを知らせたとき
 * （POST /api/overlay/bgm/ended）に、次に流す曲をここで決める。保存や押し出しを持たないので、判断だけを切り出してテストする。
 *
 * 通常の再生では一覧の順に進み、最後の曲の次は最初の曲に戻る（配信のBGMを黙って途切れさせないため）。
 * シャッフルでは、いま流している曲以外から選ぶ（同じ曲が続かないように）。
 *
 * 注意: シャッフルでも「前の曲」は一覧の順に戻る。選んだ順を覚えていないためである。
 */
import type { BgmTrack } from './bgm-config'

/** 進む向き */
export type BgmStep = 'next' | 'previous'

/**
 * 次に流す曲の素材のIDを決める。
 *
 * @param tracks 曲の一覧
 * @param currentMediaId いま流している曲の素材のID。止めているときは null
 * @param step 進む向き
 * @param shuffle シャッフルするか（次へ進むときだけ効く）
 * @param random 0以上1未満の乱数を返す。テストで固定できるよう引数で受け取る
 * @returns 次に流す曲の素材のID。曲が1つも無ければ null
 */
export const steppedMediaIdOf = (
  tracks: readonly BgmTrack[],
  currentMediaId: string | null,
  step: BgmStep,
  shuffle: boolean,
  random: () => number,
): string | null => {
  if (tracks.length === 0) return null

  if (shuffle && step === 'next') {
    const others = tracks.filter((track) => track.mediaId !== currentMediaId)
    // 曲が1つだけなら、その曲をもう一度流す
    const candidates = others.length > 0 ? others : tracks
    return candidates[Math.floor(random() * candidates.length)]?.mediaId ?? null
  }

  const index = tracks.findIndex((track) => track.mediaId === currentMediaId)
  // 止めている（一覧の中に流している曲が無い）ときは、次なら最初の曲、前なら最後の曲から始める
  if (index === -1) return (step === 'next' ? tracks[0] : tracks.at(-1))?.mediaId ?? null
  const offset = step === 'next' ? 1 : -1
  return tracks[(index + offset + tracks.length) % tracks.length]?.mediaId ?? null
}
