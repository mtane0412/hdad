/**
 * 市町村紹介の代表画像の読み込み（issue #254）
 *
 * 紹介が届いたら、画像の場面を流しはじめる前に画像を読み込んで描ける状態にしておく（描画のたびに読み込みを待たない）。
 * 読み込めなかった・時間内に読み込めなかったときは投げ、合成ページ（stage.ts）が素材の箱に失敗を出して画像の場面を飛ばす。
 *
 * 注意: Image 要素を扱う部分なので、sound-player.ts と同じくテストを持たない。
 */

/**
 * 画像を読み込む時間の上限（ミリ秒）。Wikipedia へ問い合わせる上限（worker/town-wikipedia.ts の WIKIPEDIA_TIMEOUT_MS）より短くする。
 * 読み込み中は「紹介を準備しています…」のまま待つので、長く待たせるよりは画像を飛ばして先へ進む
 */
export const IMAGE_LOAD_TIMEOUT_MS = 10_000

/**
 * 画像を読み込み、描ける状態にして返す
 *
 * @throws 読み込めなかった・IMAGE_LOAD_TIMEOUT_MS のうちに読み込めなかったとき
 */
export const loadTownTourImage = (url: string): Promise<HTMLImageElement> => {
  const image = new Image()
  image.src = url
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      // 読み込みを打ち切り、遅れて届いた画像を使わない
      image.src = ''
      reject(new Error(`代表画像を${IMAGE_LOAD_TIMEOUT_MS / 1000}秒のうちに読み込めませんでした: ${url}`))
    }, IMAGE_LOAD_TIMEOUT_MS)
    image.decode().then(
      () => {
        window.clearTimeout(timer)
        resolve(image)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(new Error(`代表画像を読み込めませんでした: ${url}（${error instanceof Error ? error.message : String(error)}）`))
      },
    )
  })
}
