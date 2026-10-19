/**
 * canvas の素材が、配信の映像の上に直に置く文字を縁取りして描く。
 *
 * 配信の背景は明るいことも暗いことも柄があることもあるので、どれの上でも読めるよう、
 * 文字の外側に一定の割合の太さの縁を付ける。DOM の素材の縁取り（src/core/text-outline.css）と同じ太さに揃える。
 *
 * 縁は strokeText で描いてから、同じ位置に fillText で塗る（塗りを後にして、線の内側の半分を文字で隠す）。
 * 角は丸める。既定の miter のままだと、太い縁では「驚」「M」のような鋭い角から縁が尖って飛び出す。
 */

/**
 * 外に見える縁の幅（文字の大きさに対する割合）。src/core/text-outline.css の --outline-width の既定と同じ値にする。
 * 漢字の画が詰まっていても字の形がつぶれず、明るい背景でも白い文字の輪郭が途切れない太さとして選んだ。
 */
export const OUTLINE_RATIO = 0.08

/** 縁取り文字の大きさと色 */
export interface OutlinedTextStyle {
  /** 文字の大きさ（px）。ctx.font に指定した大きさと同じにする。縁の太さはここから決める */
  fontSize: number
  /** 文字の塗りの色 */
  fill: string
  /** 縁の色。塗りと明暗が逆の色にする（明るい塗りには暗い縁、暗い塗りには明るい縁） */
  outline: string
}

/**
 * 1行の文字を、縁を付けて描く。
 *
 * 書体・textAlign・textBaseline は呼び出し側が先に ctx に指定しておく。
 * 線の太さ・角の形・色は描き終えたら呼ぶ前の状態に戻すので、呼び出し側の続きの描画には影響しない。
 */
export const drawOutlinedText = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, style: OutlinedTextStyle): void => {
  ctx.save()
  // 線は輪郭の内と外に半分ずつ乗るので、外に見せたい幅の2倍で引く
  ctx.lineWidth = style.fontSize * OUTLINE_RATIO * 2
  ctx.lineJoin = 'round'
  ctx.strokeStyle = style.outline
  ctx.strokeText(text, x, y)
  ctx.fillStyle = style.fill
  ctx.fillText(text, x, y)
  ctx.restore()
}
