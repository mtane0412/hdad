/**
 * 市町村紹介のナレーションの音声の読み込み（issue #255）
 *
 * Worker が合成した音声（WAV）を、鳴らせる URL（blob:）にして長さを読み取る。場面の長さは読み上げの長さで決まる
 * （timeline.ts）ので、紹介を届いたものとして流しはじめる前に、すべての音声の長さを読み終えておく。
 * 読み込めなかった・時間内に読めなかったときは投げ、合成ページ（stage.ts）が素材の箱に失敗を出してその場面だけ無音で流す。
 *
 * 注意: Audio 要素と URL.createObjectURL を扱う部分なので、image-loader.ts・sound-player.ts と同じくテストを持たない。
 * 注意: 作った URL は再生を終えたら releaseNarration で手放す（配信中に何度も流すので、音声を持ち続けない）。
 */
import type { Narration, NarrationClip } from './narration'

/**
 * 音声の長さを読み取る時間の上限（ミリ秒）。音声はもう手元にあるので、読めないまま長く待たせずに無音で先へ進む
 */
export const NARRATION_LOAD_TIMEOUT_MS = 5_000

/** 秒をミリ秒にする（Audio 要素の長さは秒） */
const MS_PER_SECOND = 1000

/**
 * 合成した音声を鳴らせる URL にし、長さを読み取る。
 *
 * @throws 音声として読めなかった・長さが分からない・NARRATION_LOAD_TIMEOUT_MS のうちに読めなかったとき（作った URL は手放してから投げる）
 */
export const loadNarrationClip = (audio: Blob): Promise<NarrationClip> => {
  const url = URL.createObjectURL(audio)
  const element = new Audio()
  element.preload = 'metadata'
  return new Promise<NarrationClip>((resolve, reject) => {
    // fail が使う timer は直後に作る（fail が呼ばれるのは、どれもタイマーを作った後の見張りから）
    const fail = (reason: string): void => {
      window.clearTimeout(timer)
      element.removeAttribute('src')
      URL.revokeObjectURL(url)
      reject(new Error(`ナレーションの音声を読めませんでした（${reason}）`))
    }
    const timer = window.setTimeout(() => fail(`${NARRATION_LOAD_TIMEOUT_MS / MS_PER_SECOND}秒のうちに長さを読めませんでした`), NARRATION_LOAD_TIMEOUT_MS)
    element.addEventListener(
      'loadedmetadata',
      () => {
        const { duration } = element
        // 長さの分からない音声で場面を決めると、場面が延びすぎたり縮んだりするので使わない
        if (!Number.isFinite(duration) || duration <= 0) {
          fail(`長さが分かりません: ${duration}`)
          return
        }
        window.clearTimeout(timer)
        element.removeAttribute('src')
        resolve({ url, duration: duration * MS_PER_SECOND })
      },
      { once: true },
    )
    element.addEventListener('error', () => fail('音声の形式を読めません'), { once: true })
    element.src = url
  })
}

/** 1件の紹介の読み上げの音声の URL をすべて手放す */
export const releaseNarration = ({ opening, lines }: Narration): void => {
  for (const clip of [opening, ...lines]) {
    if (clip !== null) URL.revokeObjectURL(clip.url)
  }
}
