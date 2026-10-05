/**
 * 市町村紹介の描画（Canvas 2D）
 *
 * 1フレームぶんの場面（timeline.ts の sceneAt）を受け取り、日本地図・市町村の塗り・冒頭の一文・大きさの文（人口・面積と挑む文）・
 * 紹介の場面（大見出し・項目・振り）・出典を描く。大見出しは項目より大きな文字で描く。
 * 冒頭のクイズ（issue #251）のあいだは、日本地図を描かずに市町村の形だけをシルエットで描き、問いとヒントを下の帯に描く。
 * クイズを終えたら、正解（と最初の正解者）を下の帯に描く。
 * 締めの全国制覇マップ（issue #252）では、これまでに紹介した市町村を今回の市町村とは別の色で塗り、今回の市町村を数えたら
 * その位置に印を描き、制覇数と節目の一文を下の帯に描く。
 * ズームの着地のあとの代表画像（issue #254）は、地図の上に白い縁を付けて縦横比を保って収め、作者とライセンスを出典の上の行に描く。
 * 最後の名誉町民の認定証（issue #253）は、地図の上に賞状風の枠の紙を重ね、表題・市町村の形・宛名・任命の文・日付・発行者を描く。
 * どこを映すかは camera.ts、文の折り返しは wrap.ts、大きさの文は scale.ts が決め、ここは描くだけを受け持つ（通信も状態も持たない）。
 *
 * 地図の形は、起動時に全国ぶんを1つの Path2D にまとめておき、毎フレームは拡大と移動を掛けて塗り直すだけにする
 * （1,700余りの市町村を毎フレーム作り直さないため）。線の太さは拡大率で割り、画面上で一定の太さに見せる。
 *
 * 注意: 引いた市町村の形が地図に無ければ投げる。一覧と地図の1対1は src/town-tour/towns.test.ts が確かめているので、
 * ここで投げるのは地図の読み込みが壊れたときだけである。
 */
import { cameraAt } from './camera'
import { scaleLinesOf } from './scale'
import type { Playback, Scene } from './timeline'
import { boundsOf, type Bounds, type Ring } from './topo'
import { wrapText } from './wrap'

/** 寸法の基準にする配信画面の高さ（px）。箱がこれより小さければ、文字も線も同じ割合で小さくする */
const BASE_HEIGHT = 1080
const BASE_WIDTH = 1920

const FONT_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif'
/** 認定証の文字。賞状らしく明朝体にする */
const CERTIFICATE_FONT_FAMILY = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif'

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
  silhouette: '#f2f2f2',
  /** 全国制覇マップで、これまでに紹介した市町村の塗り。今回の市町村（town）と見分けられる色にする */
  visited: '#4fb3a9',
  /** 認定証の紙・枠・文字 */
  certificatePaper: '#fbf6e9',
  certificateFrame: '#b8892d',
  certificateText: '#3a2a10',
  /** 代表画像の縁 */
  imageFrame: '#ffffff',
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
  scaleFont: 34,
  scaleLineHeight: 48,
  scalePadding: 16,
  margin: 32,
  /** 全国制覇マップで、今回の市町村に描く印の半径。日本全体を映すと小さな市町村は点にしか見えないので、画面上の大きさで描く */
  stampRadius: 22,
  stampWidth: 5,
  /** 認定証の紙の大きさ・余白と、枠の線（外側の太い線と、内側の細い線の二重） */
  certificateWidth: 1080,
  certificateHeight: 800,
  certificatePadding: 56,
  certificateOuterFrame: 10,
  certificateInnerFrame: 2,
  certificateFrameGap: 18,
  certificateTitleFont: 76,
  /** 認定証に描く市町村の形を収める高さ */
  certificateShapeHeight: 220,
  certificateHolderFont: 54,
  certificateBodyFont: 36,
  certificateBodyLineHeight: 52,
  certificateFooterFont: 30,
  certificateFooterLineHeight: 46,
  certificateGap: 28,
  /** 代表画像の縁の太さ */
  imageFrame: 8,
} as const

/** 紹介の場面の帯を置く高さ（箱の高さに対する割合）。帯の上端 */
const PANEL_TOP = 0.66
/** クイズのあいだシルエットを収める範囲（箱の高さに対する割合）。上の冒頭の一文の帯と、下のクイズの帯に重ならないようにする */
const SILHOUETTE_TOP = 0.1
const SILHOUETTE_BOTTOM = PANEL_TOP - 0.02
/**
 * 代表画像を収める範囲（箱の高さ・幅に対する割合）。上は冒頭の一文と大きさの文の下、下は作者とライセンス・出典の2行の上
 */
const IMAGE_TOP = 0.31
const IMAGE_BOTTOM = 0.87
const IMAGE_WIDTH = 0.8
/** 作者とライセンス・出典の行を詰めて描く幅の上限（箱の幅に対する割合）。作者が長くても画面からはみ出さない */
const CREDIT_WIDTH = 0.9
/** 作者とライセンスの行を、出典の行から離す高さ（文字の大きさに対する倍率） */
const CREDIT_LINE_SPACING = 1.5
/** 文を折り返す幅（箱の幅に対する割合） */
const TEXT_WIDTH = 0.86
/** 冒頭の一文と紹介の場面の、行数の上限（項目は Worker が80文字以内、大見出しは30文字以内にそろえている） */
const MAX_HEADLINE_LINES = 2
const MAX_ITEM_LINES = 3
const MAX_HOOK_LINES = 2
/** 全国制覇マップの帯の見出し */
const CONQUEST_LABEL = '全国制覇マップ'
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
   * @param frame いま再生している1件とその場面と、読み込み終えた代表画像（無ければ null）。再生していなければ null（何も描かない）
   */
  render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    frame: { playback: Playback; scene: Scene; image: HTMLImageElement | null } | null,
  ): void
}

/**
 * 日本地図の形から、描くものを組み立てる。
 *
 * @param shapes 市町村のコードごとの輪の列（topo.ts の decodeTownShapes）
 */
export const createTownTourRenderer = (shapes: ReadonlyMap<string, readonly Ring[]>): TownTourRenderer => {
  const land = pathOf([...shapes.values()].flat())
  const figures = new Map<string, TownFigure>()
  /** これまでに紹介した市町村をまとめた形。再生ごとに記録が変わるので、元にした記録と一緒に覚えておく */
  let visitedCache: { readonly source: ReadonlySet<string>; readonly path: Path2D } | null = null
  const visitedPathOf = (codes: ReadonlySet<string>): Path2D => {
    if (visitedCache?.source === codes) return visitedCache.path
    const path = pathOf(
      [...codes].flatMap((code) => {
        const rings = shapes.get(code)
        if (rings === undefined) throw new Error(`日本地図に、紹介済みのコード ${code} の市町村の形がありません`)
        return rings
      }),
    )
    visitedCache = { source: codes, path }
    return path
  }
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
      const { playback, scene, image } = frame
      const unit = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT)
      const figure = figureOf(playback.call.code)

      ctx.save()
      ctx.globalAlpha = scene.opacity
      ctx.fillStyle = COLORS.backdrop
      ctx.fillRect(0, 0, width, height)
      const visited = scene.conquest === null ? null : { path: visitedPathOf(playback.conquest.visited), ...scene.conquest }
      drawMap(ctx, width, height, unit, land, figure, scene, visited)
      const headlineBottom = drawHeadline(ctx, width, unit, scene.headlineText, scene.headline)
      // 大きさの文は、市町村の形が塗られる（ズームが着地する）のに合わせて出し、そのまま最後まで残す
      if (scene.fill > 0) drawScale(ctx, width, unit, headlineBottom, scaleLinesOf(playback.call), scene.fill)
      if (scene.quiz !== null) drawQuizPanel(ctx, width, height, unit, scene.quiz)
      else if (scene.conquest !== null) drawConquestPanel(ctx, width, height, unit, scene.conquest)
      else if (scene.certificate !== null) drawCertificate(ctx, width, height, unit, figure, scene.certificate)
      else drawPanel(ctx, width, height, unit, scene)
      if (scene.image !== null && image !== null) drawImage(ctx, width, height, unit, image, scene.image)
      if (scene.credit !== null) drawCredit(ctx, width, height, unit, scene.credit, scene.image?.credit ?? null)
      ctx.restore()
    },
  }
}

/**
 * 全国の形と、引いた市町村の塗りを描く。クイズのあいだは、市町村だけを寄った位置にシルエットで描く。
 * 全国制覇マップのあいだ（visited が null でない）は、これまでに紹介した市町村も塗り、今回の市町村を数えたら印を描く
 */
const drawMap = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  unit: number,
  land: Path2D,
  figure: TownFigure,
  scene: Scene,
  visited: { readonly path: Path2D; readonly opacity: number; readonly stamp: number } | null,
): void => {
  const inQuiz = scene.quiz !== null
  // クイズのあいだは寄りきった映し方で、帯に挟まれた範囲の真ん中に置く
  const viewHeight = inQuiz ? height * (SILHOUETTE_BOTTOM - SILHOUETTE_TOP) : height
  const viewCenterY = inQuiz ? height * ((SILHOUETTE_TOP + SILHOUETTE_BOTTOM) / 2) : height / 2
  const camera = cameraAt(inQuiz ? 1 : scene.zoom, figure.bounds, width, viewHeight)
  ctx.save()
  ctx.translate(width / 2, viewCenterY)
  ctx.scale(camera.scale, camera.scale)
  ctx.translate(-camera.centerX, -camera.centerY)
  ctx.lineJoin = 'round'

  if (inQuiz) {
    ctx.fillStyle = COLORS.silhouette
    ctx.fill(figure.path)
    ctx.restore()
    return
  }

  ctx.fillStyle = COLORS.land
  ctx.fill(land)
  ctx.strokeStyle = COLORS.border
  ctx.lineWidth = (SIZES.borderWidth * unit) / camera.scale
  ctx.stroke(land)

  if (visited !== null) {
    ctx.save()
    ctx.globalAlpha *= visited.opacity
    ctx.fillStyle = COLORS.visited
    ctx.fill(visited.path)
    ctx.restore()
  }

  if (visited !== null && visited.stamp > 0) {
    // 今回の市町村の中心に、画面上で一定の大きさの輪を描く（拡大率で割って、日本全体を映していても見える大きさにする）
    const { bounds } = figure
    ctx.save()
    ctx.globalAlpha *= visited.stamp
    ctx.strokeStyle = COLORS.town
    ctx.lineWidth = (SIZES.stampWidth * unit) / camera.scale
    ctx.beginPath()
    ctx.arc((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, (SIZES.stampRadius * unit) / camera.scale, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

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

/** 冒頭の一文（「○○さんのレイドを記念して、本日は△△町をご紹介します」）を上の帯に描き、帯の下端の高さを返す */
const drawHeadline = (ctx: CanvasRenderingContext2D, width: number, unit: number, headline: string, opacity: number): number => {
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
  return bandHeight
}

/** 大きさの文（人口・面積と、挑む文）を、冒頭の一文の帯のすぐ下に描く。挑む文は目立つ色にする */
const drawScale = (ctx: CanvasRenderingContext2D, width: number, unit: number, top: number, lines: readonly string[], opacity: number): void => {
  const padding = SIZES.scalePadding * unit
  const lineHeight = SIZES.scaleLineHeight * unit
  ctx.save()
  ctx.globalAlpha *= opacity
  ctx.fillStyle = COLORS.band
  ctx.fillRect(0, top, width, padding * 2 + lineHeight * lines.length)
  ctx.font = `bold ${SIZES.scaleFont * unit}px ${FONT_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  lines.forEach((line, index) => {
    ctx.fillStyle = index === 0 ? COLORS.text : COLORS.label
    ctx.fillText(line, width / 2, top + padding + lineHeight * index, width * TEXT_WIDTH)
  })
  ctx.restore()
}

/** クイズの見出し・問いと、ここまでに出したヒントを下の帯に描く */
const drawQuizPanel = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, quiz: NonNullable<Scene['quiz']>): void => {
  const padding = SIZES.panelPadding * unit
  const top = height * PANEL_TOP
  const labelHeight = SIZES.labelFont * unit + padding / 2
  const questionLineHeight = SIZES.itemLineHeight * unit
  const hintHeight = SIZES.scaleLineHeight * unit
  const questionFont = `bold ${SIZES.itemFont * unit}px ${FONT_FAMILY}`
  ctx.save()
  // 問いは市町村の名前の長さで伸びるので、ほかの場面と同じく折り返す
  ctx.font = questionFont
  const questionLines = wrapText(quiz.question, width * TEXT_WIDTH, (text) => ctx.measureText(text).width).slice(0, MAX_ITEM_LINES)
  const questionHeight = questionLineHeight * questionLines.length
  ctx.fillStyle = COLORS.band
  ctx.fillRect(0, top, width, padding * 2 + labelHeight + questionHeight + hintHeight * quiz.hints.length)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.font = `bold ${SIZES.labelFont * unit}px ${FONT_FAMILY}`
  ctx.fillStyle = COLORS.label
  ctx.fillText(quiz.label, width / 2, top + padding)
  ctx.font = questionFont
  ctx.fillStyle = COLORS.text
  drawLines(ctx, questionLines, width / 2, top + padding + labelHeight, questionLineHeight)
  ctx.font = `bold ${SIZES.scaleFont * unit}px ${FONT_FAMILY}`
  ctx.fillStyle = COLORS.label
  quiz.hints.forEach((hint, index) => {
    ctx.fillText(`ヒント${index + 1}: ${hint}`, width / 2, top + padding + labelHeight + questionHeight + hintHeight * index, width * TEXT_WIDTH)
  })
  ctx.restore()
}

/**
 * 紹介の場面（見出しと文）、正解の場面、または紹介を待っている旨を下の帯に描く。
 * 帯の高さは文を伏せているあいだも文の行数ぶん取る（溜めの後に帯が伸びないように）
 */
const drawPanel = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, scene: Scene): void => {
  const content =
    scene.item ??
    (scene.reveal === null ? null : { line: { kind: 'point', label: scene.reveal.label, text: scene.reveal.text }, opacity: scene.reveal.opacity, textOpacity: 1 }) ??
    (scene.waiting ? { line: { kind: 'point', label: '', text: WAITING_TEXT }, opacity: 1, textOpacity: 1 } : null)
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

/** 全国制覇マップの見出し・制覇数と、節目の一文を下の帯に描く */
const drawConquestPanel = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, conquest: NonNullable<Scene['conquest']>): void => {
  const padding = SIZES.panelPadding * unit
  const top = height * PANEL_TOP
  const labelHeight = SIZES.labelFont * unit + padding / 2
  const countHeight = SIZES.itemLineHeight * unit
  const milestoneHeight = SIZES.scaleLineHeight * unit
  ctx.save()
  ctx.globalAlpha *= conquest.opacity
  ctx.fillStyle = COLORS.band
  ctx.fillRect(0, top, width, padding * 2 + labelHeight + countHeight + milestoneHeight * conquest.milestones.length)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.font = `bold ${SIZES.labelFont * unit}px ${FONT_FAMILY}`
  ctx.fillStyle = COLORS.label
  ctx.fillText(CONQUEST_LABEL, width / 2, top + padding)
  ctx.font = `bold ${SIZES.itemFont * unit}px ${FONT_FAMILY}`
  ctx.fillStyle = COLORS.text
  ctx.fillText(conquest.label, width / 2, top + padding + labelHeight, width * TEXT_WIDTH)
  ctx.font = `bold ${SIZES.scaleFont * unit}px ${FONT_FAMILY}`
  ctx.fillStyle = COLORS.label
  ctx.globalAlpha *= conquest.stamp
  conquest.milestones.forEach((milestone, index) => {
    ctx.fillText(milestone, width / 2, top + padding + labelHeight + countHeight + milestoneHeight * index, width * TEXT_WIDTH)
  })
  ctx.restore()
}

/**
 * 名誉町民の認定証を、画面の中央に賞状風の紙として描く。上から表題・市町村の形・宛名・任命の文・日付と発行者の順に並べる。
 * 紙は箱に収まる大きさまで縮める（配信画面より小さい箱でも、文字と紙の釣り合いを変えない）
 */
const drawCertificate = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  unit: number,
  figure: TownFigure,
  certificate: NonNullable<Scene['certificate']>,
): void => {
  const fit = Math.min(1, (width * TEXT_WIDTH) / (SIZES.certificateWidth * unit), (height * TEXT_WIDTH) / (SIZES.certificateHeight * unit))
  /** 認定証の中の寸法の基準（unit を紙が収まるまで縮めたもの） */
  const u = unit * fit
  const paperWidth = SIZES.certificateWidth * u
  const paperHeight = SIZES.certificateHeight * u
  const left = (width - paperWidth) / 2
  const top = (height - paperHeight) / 2
  const centerX = width / 2
  const font = (size: number): string => `bold ${size * u}px ${CERTIFICATE_FONT_FAMILY}`

  ctx.save()
  ctx.globalAlpha *= certificate.opacity
  // 後ろの地図・冒頭の一文・大きさの文を暗い幕で沈め、紙だけが目に入るようにする（出典はこの後に描くので幕に隠れない）
  ctx.fillStyle = COLORS.backdrop
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = COLORS.certificatePaper
  ctx.fillRect(left, top, paperWidth, paperHeight)
  // 賞状風の二重の枠（外側を太く、内側を細く）
  ctx.strokeStyle = COLORS.certificateFrame
  const outer = SIZES.certificateOuterFrame * u
  ctx.lineWidth = outer
  ctx.strokeRect(left + outer, top + outer, paperWidth - outer * 2, paperHeight - outer * 2)
  const innerInset = outer * 2 + SIZES.certificateFrameGap * u
  ctx.lineWidth = SIZES.certificateInnerFrame * u
  ctx.strokeRect(left + innerInset, top + innerInset, paperWidth - innerInset * 2, paperHeight - innerInset * 2)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = COLORS.certificateText
  const textWidth = paperWidth - SIZES.certificatePadding * u * 2
  let cursor = top + SIZES.certificatePadding * u
  ctx.font = font(SIZES.certificateTitleFont)
  ctx.fillText(certificate.title, centerX, cursor, textWidth)
  cursor += (SIZES.certificateTitleFont + SIZES.certificateGap) * u

  // 市町村の形を、決めた高さの枠に収まるよう縦横の比を保って縮め、中央に置く
  const shapeHeight = SIZES.certificateShapeHeight * u
  const { bounds } = figure
  const shapeScale = Math.min(textWidth / (bounds.maxX - bounds.minX), shapeHeight / (bounds.maxY - bounds.minY))
  ctx.save()
  ctx.translate(centerX, cursor + shapeHeight / 2)
  ctx.scale(shapeScale, shapeScale)
  ctx.translate(-(bounds.minX + bounds.maxX) / 2, -(bounds.minY + bounds.maxY) / 2)
  ctx.fillStyle = COLORS.town
  ctx.fill(figure.path)
  ctx.lineJoin = 'round'
  ctx.strokeStyle = COLORS.certificateFrame
  ctx.lineWidth = (SIZES.townBorderWidth * u) / shapeScale
  ctx.stroke(figure.path)
  ctx.restore()
  cursor += shapeHeight + SIZES.certificateGap * u

  ctx.font = font(SIZES.certificateHolderFont)
  ctx.fillText(certificate.holder, centerX, cursor, textWidth)
  cursor += (SIZES.certificateHolderFont + SIZES.certificateGap) * u

  ctx.font = font(SIZES.certificateBodyFont)
  const bodyLines = wrapText(certificate.appointment, textWidth, (text) => ctx.measureText(text).width).slice(0, MAX_HEADLINE_LINES)
  drawLines(ctx, bodyLines, centerX, cursor, SIZES.certificateBodyLineHeight * u)

  // 日付と発行者は紙の下端にそろえる
  ctx.font = font(SIZES.certificateFooterFont)
  ctx.textBaseline = 'bottom'
  const bottom = top + paperHeight - SIZES.certificatePadding * u
  ctx.fillText(certificate.issuer, centerX, bottom, textWidth)
  ctx.fillText(certificate.date, centerX, bottom - SIZES.certificateFooterLineHeight * u, textWidth)
  ctx.restore()
}

/** 代表画像を、縦横比を保って収める範囲の中ほどに、白い縁を付けて描く */
const drawImage = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  unit: number,
  image: HTMLImageElement,
  scene: NonNullable<Scene['image']>,
): void => {
  const areaHeight = height * (IMAGE_BOTTOM - IMAGE_TOP)
  const scale = Math.min((width * IMAGE_WIDTH) / image.naturalWidth, areaHeight / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  const left = (width - drawWidth) / 2
  const top = height * IMAGE_TOP + (areaHeight - drawHeight) / 2
  const frame = SIZES.imageFrame * unit
  ctx.save()
  ctx.globalAlpha *= scene.opacity
  ctx.fillStyle = COLORS.imageFrame
  ctx.fillRect(left - frame, top - frame, drawWidth + frame * 2, drawHeight + frame * 2)
  ctx.drawImage(image, left, top, drawWidth, drawHeight)
  ctx.restore()
}

/**
 * 出典（「出典: Wikipedia「当別町」（CC BY-SA 4.0）」）を右下に描く。
 * 代表画像を出しているあいだは、その上の行に作者とライセンス（「写真: 撮影者（CC BY-SA 4.0）」）を描く
 */
const drawCredit = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, credit: string, imageCredit: string | null): void => {
  const right = width - SIZES.margin * unit
  const bottom = height - SIZES.margin * unit
  ctx.save()
  ctx.font = `${SIZES.creditFont * unit}px ${FONT_FAMILY}`
  ctx.fillStyle = COLORS.credit
  ctx.textAlign = 'right'
  ctx.textBaseline = 'bottom'
  ctx.fillText(credit, right, bottom, width * CREDIT_WIDTH)
  if (imageCredit !== null) ctx.fillText(imageCredit, right, bottom - SIZES.creditFont * unit * CREDIT_LINE_SPACING, width * CREDIT_WIDTH)
  ctx.restore()
}
