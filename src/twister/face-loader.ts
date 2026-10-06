/**
 * ツイスターの人形の顔に貼る、Twitch のアイコン画像の読み込み
 *
 * アイコンは Twitch の画像配信元（static-cdn.jtvnw.net）から直接読む。配信元は Access-Control-Allow-Origin: * を返すので、
 * crossOrigin を付けて読めば WebGL のテクスチャにできる（Worker を経由しない）。
 *
 * 注意: 画像を扱うだけなのでテストを持たない（読み込めなかったときの扱いは呼び出し側の stage.ts が決める）。
 */

/**
 * アイコン画像を読み込む。
 *
 * @throws 読み込めない・画像として解釈できない場合
 */
export const loadFaceImage = async (url: string): Promise<HTMLImageElement> => {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = url
  try {
    await image.decode()
  } catch (error) {
    throw new Error(`アイコン画像を読み込めませんでした（${url}）: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return image
}
