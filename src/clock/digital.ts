/**
 * digital: 現在時刻を数字で表示するシンプルなデジタル時計
 *
 * 1行目に時刻、2行目に日付と曜日を中央ぞろえで描く。時刻は配信PCのローカル時刻を使う。
 * 文字サイズはピクセル指定ではなく、OBSのブラウザソースの幅・高さに収まる最大サイズから決めるため、
 * ソースの大きさを変えても文字がはみ出さない。
 * 表示内容は frame.now だけから決まり、フレーム間の状態は持たない（文字幅の計測結果だけは、同じ入力に同じ値を返すメモとして覚えておく）。
 */
import { defineBackground, paintBackdrop } from '../core/background'

/** 時刻の行に対する、日付の行の文字サイズの比率 */
const DATE_SIZE_RATIO = 0.4
/** 文字サイズに対する行の高さの比率 */
const LINE_HEIGHT = 1.2
/** 文字サイズに対する縁取りの太さの比率 */
const OUTLINE_RATIO = 0.08
/** 文字の幅を測るときの基準の文字サイズ（px）。幅は文字サイズに比例するので、この値で割って1pxあたりに直す */
const MEASURE_FONT_SIZE = 100
/** 数字の幅がそろう等幅フォント。秒が進むたびに表示が左右に揺れるのを防ぐ */
const FONT_FAMILY = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const NOON_HOUR = 12
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const

const twoDigits = (value: number): string => String(value).padStart(2, '0')

/**
 * 時刻の行の文字列を作る。
 *
 * @param now 表示する時刻（ローカル時刻として読む）
 * @param options hour12: 12時間制（AM/PM付き）にするか / seconds: 秒を表示するか
 * @returns 24時間制は「21:34:08」、12時間制は「PM 9:34:08」の形式
 */
export const formatTimeLine = (
  now: Date,
  options: { readonly hour12: boolean; readonly seconds: boolean },
): string => {
  const hours = now.getHours()
  const tail = options.seconds
    ? `${twoDigits(now.getMinutes())}:${twoDigits(now.getSeconds())}`
    : twoDigits(now.getMinutes())
  if (!options.hour12) return `${twoDigits(hours)}:${tail}`

  const period = hours < NOON_HOUR ? 'AM' : 'PM'
  // 12時間制では0時台・12時台をどちらも「12時」と表す
  const hours12 = hours % NOON_HOUR === 0 ? NOON_HOUR : hours % NOON_HOUR
  return `${period} ${hours12}:${tail}`
}

/**
 * 日付の行の文字列を作る。
 *
 * @param now 表示する日付（ローカル時刻として読む）
 * @param options date: 月日を表示するか / weekday: 曜日を表示するか
 * @returns 「9/20 (日)」の形式。どちらも表示しない場合は空文字
 */
export const formatDateLine = (
  now: Date,
  options: { readonly date: boolean; readonly weekday: boolean },
): string => {
  const parts: string[] = []
  if (options.date) parts.push(`${now.getMonth() + 1}/${now.getDate()}`)
  if (options.weekday) parts.push(`(${WEEKDAYS[now.getDay()]})`)
  return parts.join(' ')
}

/** 幅と高さの組 */
interface Size {
  readonly width: number
  readonly height: number
}

/**
 * 内容が領域に収まる最大の文字サイズに、倍率を掛けた文字サイズを求める。
 *
 * @param area 描画領域の大きさ（px）
 * @param contentPerPixel 文字サイズ1pxあたりに内容が占める大きさ
 * @param scale 収まる最大サイズに対する倍率（0〜1）
 * @returns 文字サイズ（px）
 */
export const fitFontSize = (area: Size, contentPerPixel: Size, scale: number): number =>
  Math.min(area.width / contentPerPixel.width, area.height / contentPerPixel.height) * scale

export const digital = defineBackground({
  id: 'digital',
  title: 'Digital',
  description: '現在時刻を数字で表示する。日付・曜日・秒の表示と12時間制を切り替えられる',
  schema: {
    color: { type: 'color', default: '#ffffff', description: '文字の色' },
    outline: {
      type: 'color',
      default: '#101820',
      allowTransparent: true,
      description: '文字の縁取りの色',
    },
    bg: { type: 'color', default: 'transparent', allowTransparent: true, description: '背景色' },
    size: { type: 'number', default: 0.9, min: 0.1, max: 1, description: '文字の大きさ（収まる最大に対する倍率）' },
    seconds: { type: 'boolean', default: true, description: '秒を表示する' },
    date: { type: 'boolean', default: true, description: '日付を表示する' },
    weekday: { type: 'boolean', default: true, description: '曜日を表示する' },
    hour12: { type: 'boolean', default: false, description: '12時間制（AM/PM）で表示する' },
  },
  create: ({ color, outline, bg, size, seconds, date, weekday, hour12 }) => {
    const fontOf = (fontSize: number): string => `bold ${fontSize}px ${FONT_FAMILY}`

    /**
     * 文字サイズ1pxあたりの文字列の幅。数字をすべて 0 に置き換えて測り、時刻が進んでも文字サイズが変わらないようにする。
     * 置き換え後の文字列は桁数や曜日が変わらない限り同じなので、測った結果を覚えておき、毎フレーム測り直さない
     */
    const measuredWidths = new Map<string, number>()
    const measure = (ctx: CanvasRenderingContext2D, text: string): number => {
      const template = text.replace(/\d/g, '0')
      const known = measuredWidths.get(template)
      if (known !== undefined) return known
      ctx.font = fontOf(MEASURE_FONT_SIZE)
      const measured = ctx.measureText(template).width / MEASURE_FONT_SIZE
      measuredWidths.set(template, measured)
      return measured
    }

    return (frame) => {
      const { ctx, width, height, now } = frame
      paintBackdrop(frame, bg)

      const timeLine = formatTimeLine(now, { hour12, seconds })
      const dateLine = formatDateLine(now, { date, weekday })
      const hasDateLine = dateLine !== ''

      const fontSize = fitFontSize(
        { width, height },
        {
          // 縁取りは文字の外側にも太さの半分ずつはみ出すので、その分を幅に含める。
          // 高さは、行の高さによる上下の余白（(LINE_HEIGHT - 1) / 2）が縁取りのはみ出し（OUTLINE_RATIO / 2）より大きいので足さない
          width:
            Math.max(measure(ctx, timeLine), measure(ctx, dateLine) * DATE_SIZE_RATIO) + OUTLINE_RATIO,
          height: LINE_HEIGHT * (1 + (hasDateLine ? DATE_SIZE_RATIO : 0)),
        },
        size,
      )

      const drawLine = (text: string, lineFontSize: number, centerY: number): void => {
        ctx.font = fontOf(lineFontSize)
        if (outline !== 'transparent') {
          ctx.strokeStyle = outline
          ctx.lineWidth = lineFontSize * OUTLINE_RATIO
          ctx.lineJoin = 'round'
          ctx.strokeText(text, width / 2, centerY)
        }
        ctx.fillStyle = color
        ctx.fillText(text, width / 2, centerY)
      }

      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const timeHeight = fontSize * LINE_HEIGHT
      const dateFontSize = fontSize * DATE_SIZE_RATIO
      const dateHeight = hasDateLine ? dateFontSize * LINE_HEIGHT : 0
      const top = (height - timeHeight - dateHeight) / 2
      drawLine(timeLine, fontSize, top + timeHeight / 2)
      if (hasDateLine) drawLine(dateLine, dateFontSize, top + timeHeight + dateHeight / 2)
    }
  },
})
