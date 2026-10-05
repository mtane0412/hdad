/**
 * 市町村紹介の描画（Canvas 2D）
 *
 * 1フレームぶんの場面（timeline.ts の sceneAt）を受け取り、日本地図・市町村の塗り・冒頭の一文・紹介の場面（大見出し・項目・振り）・出典を描く。
 * 大見出しは項目より大きな文字で描く。
 * どこを映すかは camera.ts、文の折り返しは wrap.ts が決め、ここは描くだけを受け持つ（通信も状態も持たない）。
 *
 * 地図の形は、起動時に全国ぶんを1つの Path2D にまとめておき、毎フレームは拡大と移動を掛けて塗り直すだけにする
 * （1,700余りの市町村を毎フレーム作り直さないため）。線の太さは拡大率で割り、画面上で一定の太さに見せる。
 *
 * 注意: 引いた市町村の形が地図に無ければ投げる。一覧と地図の1対1は src/town-tour/towns.test.ts が確かめているので、
 * ここで投げるのは地図の読み込みが壊れたときだけである。
 */
import { cameraAt } from './camera'
import type { Playback, Scene } from './timeline'
import { boundsOf, type Bounds, type Ring } from './topo'
import { wrapText } from './wrap'

/** 寸法の基準にする配信画面の高さ（px）。箱がこれより小さければ、文字も線も同じ割合で小さくする */
const BASE_HEIGHT = 1080
const BASE_WIDTH = 1920

const FONT_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif'

/** 色。地図が配信画面の上でも読めるよう、背景は暗く敷く */
const COLORS = {
  backdrop: 'rgba(12, 22, 38, 0.88)',
  land: '#2f4f3a',
  border: 'rgba(255, 255, 255, 0.18)',
  town: '#f4b63f',
  townBorder: '#ffffff',
  band: 'rgba(0, 0, 0, 0.55)',
  text: '#ffffff',
  label: '#f4b63f',
  credit: 'rgba(255, 255, 255, 0.8)',
} as const

/** 配信画面（1920×1080）での寸法（px） */
const SIZES = {
  borderWidth: 0.8,
  townBorderWidth: 2.5,
  headlineFont: 44,
  headlineTop: 36,
  headlineLineHeight: 60,
  labelFont: 30,
  itemFont: 46,
  itemLineHeight: 64,
  hookFont: 64,
  hookLineHeight: 84,
  panelPadding: 28,
  creditFont: 22,
  margin: 32,
} as const

/** 紹介の場面の帯を置く高さ（箱の高さに対する割合）。帯の上端 */
const PANEL_TOP = 0.66
/** 文を折り返す幅（箱の幅に対する割合） */
const TEXT_WIDTH = 0.86
/** 冒頭の一文と紹介の場面の、行数の上限（項目は Worker が80文字以内、大見出しは30文字以内にそろえている） */
const MAX_HEADLINE_LINES = 2
const MAX_ITEM_LINES = 3
const MAX_HOOK_LINES = 2
/** 紹介が届くのを待っているあいだに出す文言 */
const WAITING_TEXT = '紹介を準備しています…'

/** 輪の列を Path2D にする */
const pathOf = (rings: readonly Ring[]): Path2D => {
  const path = new Path2D()
  for (const ring of rings) {
    ring.forEach(([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)))
    path.closePath()
  }
  return path
}

/** 市町村1つぶんの描くもの。引くたびに作らないよう、コードごとに覚えておく */
interface TownFigure {
  readonly path: Path2D
  readonly bounds: Bounds
}

export interface TownTourRenderer {
  /**
   * 1フレームぶんを描く。
   *
   * @param frame いま再生している1件とその場面。再生していなければ null（何も描かない）
   */
  render(ctx: CanvasRenderingContext2D, width: number, height: number, frame: { playback: Playback; scene: Scene } | null): void
}

/**
 * 日本地図の形から、描くものを組み立てる。
 *
 * @param shapes 市町村のコードごとの輪の列（topo.ts の decodeTownShapes）
 */
export const createTownTourRenderer = (shapes: ReadonlyMap<string, readonly Ring[]>): TownTourRenderer => {
  const land = pathOf([...shapes.values()].flat())
  const figures = new Map<string, TownFigure>()
  const figureOf = (code: string): TownFigure => {
    const known = figures.get(code)
    if (known !== undefined) return known
    const rings = shapes.get(code)
    if (rings === undefined) throw new Error(`日本地図に、コード ${code} の市町村の形がありません`)
    const figure = { path: pathOf(rings), bounds: boundsOf(rings) }
    figures.set(code, figure)
    return figure
  }

  return {
    render: (ctx, width, height, frame) => {
      ctx.clearRect(0, 0, width, height)
      if (frame === null) return
      const { playback, scene } = frame
      const unit = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT)
      const figure = figureOf(playback.call.code)

      ctx.save()
      ctx.globalAlpha = scene.opacity
      ctx.fillStyle = COLORS.backdrop
      ctx.fillRect(0, 0, width, height)
      drawMap(ctx, width, height, unit, land, figure, scene)
      drawHeadline(ctx, width, unit, playback.call.headline, scene.headline)
      drawPanel(ctx, width, height, unit, scene)
      if (scene.credit !== null) drawCredit(ctx, width, height, unit, scene.credit)
      ctx.restore()
    },
  }
}

/** 全国の形と、引いた市町村の塗りを描く */
const drawMap = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, land: Path2D, figure: TownFigure, scene: Scene): void => {
  const camera = cameraAt(scene.zoom, figure.bounds, width, height)
  ctx.save()
  ctx.translate(width / 2, height / 2)
  ctx.scale(camera.scale, camera.scale)
  ctx.translate(-camera.centerX, -camera.centerY)
  ctx.lineJoin = 'round'

  ctx.fillStyle = COLORS.land
  ctx.fill(land)
  ctx.strokeStyle = COLORS.border
  ctx.lineWidth = (SIZES.borderWidth * unit) / camera.scale
  ctx.stroke(land)

  if (scene.fill > 0) {
    ctx.globalAlpha *= scene.fill
    ctx.fillStyle = COLORS.town
    ctx.fill(figure.path)
    ctx.strokeStyle = COLORS.townBorder
    ctx.lineWidth = (SIZES.townBorderWidth * unit) / camera.scale
    ctx.stroke(figure.path)
  }
  ctx.restore()
}

/** 行を上から順に、中央そろえで描く */
const drawLines = (ctx: CanvasRenderingContext2D, lines: readonly string[], centerX: number, top: number, lineHeight: number): void => {
  lines.forEach((line, index) => ctx.fillText(line, centerX, top + lineHeight * index))
}

/** 冒頭の一文（「○○さんのレイドを記念して、本日は△△町をご紹介します」）を上の帯に描く */
const drawHeadline = (ctx: CanvasRenderingContext2D, width: number, unit: number, headline: string, opacity: number): void => {
  ctx.save()
  ctx.font = `bold ${SIZES.headlineFont * unit}px ${FONT_FAMILY}`
  const lines = wrapText(headline, width * TEXT_WIDTH, (text) => ctx.measureText(text).width).slice(0, MAX_HEADLINE_LINES)
  const bandHeight = SIZES.headlineTop * unit * 2 + SIZES.headlineLineHeight * unit * lines.length
  ctx.globalAlpha *= opacity
  ctx.fillStyle = COLORS.band
  ctx.fillRect(0, 0, width, bandHeight)
  ctx.fillStyle = COLORS.text
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  drawLines(ctx, lines, width / 2, SIZES.headlineTop * unit, SIZES.headlineLineHeight * unit)
  ctx.restore()
}

/** 紹介の場面（見出しと文）、または紹介を待っている旨を下の帯に描く。帯の高さは文を伏せているあいだも文の行数ぶん取る（溜めの後に帯が伸びないように） */
const drawPanel = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, scene: Scene): void => {
  const content = scene.item ?? (scene.waiting ? { line: { kind: 'point', label: '', text: WAITING_TEXT }, opacity: 1, textOpacity: 1 } : null)
  if (content === null) return

  const isHook = content.line.kind === 'hook'
  const textFont = `bold ${(isHook ? SIZES.hookFont : SIZES.itemFont) * unit}px ${FONT_FAMILY}`
  const lineHeight = (isHook ? SIZES.hookLineHeight : SIZES.itemLineHeight) * unit
  ctx.save()
  ctx.globalAlpha *= content.opacity
  ctx.font = textFont
  const lines = wrapText(content.line.text, width * TEXT_WIDTH, (text) => ctx.measureText(text).width).slice(0, isHook ? MAX_HOOK_LINES : MAX_ITEM_LINES)
  const padding = SIZES.panelPadding * unit
  const top = height * PANEL_TOP
  const labelHeight = content.line.label === '' ? 0 : SIZES.labelFont * unit + padding / 2
  ctx.fillStyle = COLORS.band
  ctx.fillRect(0, top, width, padding * 2 + labelHeight + lineHeight * lines.length)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  if (content.line.label !== '') {
    ctx.font = `bold ${SIZES.labelFont * unit}px ${FONT_FAMILY}`
    ctx.fillStyle = COLORS.label
    ctx.fillText(content.line.label, width / 2, top + padding)
  }
  ctx.font = textFont
  ctx.fillStyle = COLORS.text
  ctx.globalAlpha *= content.textOpacity
  drawLines(ctx, lines, width / 2, top + padding + labelHeight, lineHeight)
  ctx.restore()
}

/** 出典（「出典: Wikipedia「当別町」（CC BY-SA 4.0）」）を右下に描く */
const drawCredit = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, credit: string): void => {
  ctx.save()
  ctx.font = `${SIZES.creditFont * unit}px ${FONT_FAMILY}`
  ctx.fillStyle = COLORS.credit
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText(credit, width - SIZES.margin * unit, height - SIZES.margin * unit)
  ctx.restore()
}
