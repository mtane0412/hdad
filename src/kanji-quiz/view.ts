/**
 * 漢字クイズの描画（Canvas 2D）
 *
 * 1フレームぶんの場面（scene.ts の kanjiQuizSceneAt）と出題を受け取り、次を描く。
 * - 級の場面: 画面の真ん中に「漢検○級」と、出題させた人
 * - 出題の場面: 上の帯に級と出題させた人と残り秒数、真ん中に熟語（倍率は場面が決め、ctx.scale で奥から近づける）。
 *   最後の数秒は残り秒数を熟語の下に大きく赤で出す
 * - 答えの場面: 「時間切れ」（正解者が届いていれば「○○さん 正解！」。issue #301）と熟語・正解の読み・解説
 *
 * 文言は captions.ts、文の折り返しは市町村紹介と同じ wrapText が決め、ここは描くだけを受け持つ（通信も状態も持たない）。
 * テストを持たない（canvas に描くだけのため）。
 */
import { wrapText } from '../town-tour/wrap'
import { answerLineOf, gradeHeadlineOf, requesterLineOf, winnerLineOf } from './captions'
import type { KanjiQuizCall } from './call'
import type { KanjiQuizScene } from './scene'

/** 寸法の基準にする配信画面の大きさ（px）。箱がこれより小さければ、文字も帯も同じ割合で小さくする */
const BASE_WIDTH = 1920
const BASE_HEIGHT = 1080

const SANS_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif'
/** 熟語は筆で書いたような明朝で出す（試験の問題らしく見せる） */
const WORD_FAMILY = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif'

/** 基準の大きさでの寸法（px） */
const SIZES = {
  gradeFont: 160,
  requesterFont: 44,
  bandHeight: 110,
  bandFont: 48,
  wordFont: 300,
  countdownFont: 260,
  timeUpFont: 64,
  revealWordFont: 150,
  answerFont: 110,
  explanationFont: 46,
  explanationWidth: 1400,
  lineGap: 1.4,
  panelPadding: 48,
  panelRadius: 32,
  margin: 48,
  /** 帯の中で、級と出題させた人のあいだに空ける幅 */
  bandGap: 32,
} as const

/** 熟語・カウントダウンの縁取りの太さ（文字の大きさに対する割合） */
const STROKE_RATIO = 0.06
/** 級の場面の板の幅（箱の幅に対する割合） */
const GRADE_PANEL_WIDTH_RATIO = 0.6
/** 大きなカウントダウンを出すあいだ、熟語を上へずらす位置と、カウントダウンを置く位置（箱の高さに対する割合） */
const COUNTDOWN_WORD_Y_RATIO = 0.42
const COUNTDOWN_Y_RATIO = 0.78
/** 文字の中心から上下の端までの目安（文字の大きさに対する割合）。級の場面で、見出しと出題させた人を縦に並べる間隔に使う */
const HALF_LINE_RATIO = 0.6
/** 時間切れの場面で、熟語・読み・解説を縦に並べるときの、文字の中心から次の行までの目安（文字の大きさに対する割合） */
const REVEAL_LINE_RATIO = 0.7

const COLORS = {
  panel: 'rgba(16, 20, 32, 0.82)',
  text: '#ffffff',
  sub: '#c8d0e0',
  accent: '#ffcf40',
  countdown: '#ff4d4d',
  wordStroke: 'rgba(0, 0, 0, 0.6)',
} as const

/** 級の場面で、見出しがはっきり出るまでにかける割合（場面の長さに対して） */
const GRADE_FADE_PORTION = 0.3

/** 角を丸めた板を描く */
const fillPanel = (ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void => {
  ctx.fillStyle = COLORS.panel
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, radius)
  ctx.fill()
}

/** 真ん中寄せの1行を描く */
const centerText = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, font: string, color: string): void => {
  ctx.font = font
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x, y)
}

const drawGrade = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, call: KanjiQuizCall, progress: number): void => {
  ctx.globalAlpha = Math.min(1, progress / GRADE_FADE_PORTION)
  const panelWidth = width * GRADE_PANEL_WIDTH_RATIO
  const panelHeight = (SIZES.gradeFont + SIZES.requesterFont * 2 + SIZES.panelPadding * 2) * unit
  fillPanel(ctx, (width - panelWidth) / 2, (height - panelHeight) / 2, panelWidth, panelHeight, SIZES.panelRadius * unit)
  centerText(ctx, gradeHeadlineOf(call.problem.grade), width / 2, height / 2 - SIZES.requesterFont * HALF_LINE_RATIO * unit, `bold ${SIZES.gradeFont * unit}px ${SANS_FAMILY}`, COLORS.accent)
  const requester = requesterLineOf(call.requesterName)
  if (requester !== null) {
    centerText(ctx, requester, width / 2, height / 2 + SIZES.gradeFont * HALF_LINE_RATIO * unit, `${SIZES.requesterFont * unit}px ${SANS_FAMILY}`, COLORS.sub)
  }
  ctx.globalAlpha = 1
}

/** 上の帯（級・出題させた人・残り秒数） */
const drawBand = (ctx: CanvasRenderingContext2D, width: number, unit: number, call: KanjiQuizCall, remainingSeconds: number | null): void => {
  const bandHeight = SIZES.bandHeight * unit
  const margin = SIZES.margin * unit
  fillPanel(ctx, margin, margin, width - margin * 2, bandHeight, SIZES.panelRadius * unit)
  const middle = margin + bandHeight / 2
  ctx.font = `bold ${SIZES.bandFont * unit}px ${SANS_FAMILY}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = COLORS.accent
  ctx.fillText(gradeHeadlineOf(call.problem.grade), margin * 2, middle)
  // 出題させた人は級に続けて、ひと回り小さく添える
  const requester = requesterLineOf(call.requesterName)
  if (requester !== null) {
    const gradeWidth = ctx.measureText(gradeHeadlineOf(call.problem.grade)).width + SIZES.bandGap * unit
    ctx.font = `${SIZES.requesterFont * unit}px ${SANS_FAMILY}`
    ctx.fillStyle = COLORS.sub
    ctx.fillText(requester, margin * 2 + gradeWidth, middle)
  }
  if (remainingSeconds !== null) {
    ctx.font = `bold ${SIZES.bandFont * unit}px ${SANS_FAMILY}`
    ctx.fillStyle = COLORS.text
    ctx.textAlign = 'right'
    ctx.fillText(`残り ${remainingSeconds}秒`, width - margin * 2, middle)
  }
}

/** 熟語を、真ん中を中心に倍率を掛けて描く（奥から近づいてくる） */
const drawWord = (ctx: CanvasRenderingContext2D, word: string, centerX: number, centerY: number, fontSize: number, scale: number): void => {
  ctx.save()
  ctx.translate(centerX, centerY)
  ctx.scale(scale, scale)
  ctx.font = `bold ${fontSize}px ${WORD_FAMILY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // 背景の映像に負けないよう、縁取りしてから塗る
  ctx.lineWidth = fontSize * STROKE_RATIO
  ctx.lineJoin = 'round'
  ctx.strokeStyle = COLORS.wordStroke
  ctx.strokeText(word, 0, 0)
  ctx.fillStyle = COLORS.text
  ctx.fillText(word, 0, 0)
  ctx.restore()
}

const drawQuestion = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  unit: number,
  call: KanjiQuizCall,
  scene: Extract<KanjiQuizScene, { kind: 'question' }>,
): void => {
  // 大きなカウントダウンを出しているあいだは、帯の残り秒数を重ねて出さない
  drawBand(ctx, width, unit, call, scene.countdown ? null : scene.remainingSeconds)
  const wordY = scene.countdown ? height * COUNTDOWN_WORD_Y_RATIO : height / 2
  drawWord(ctx, call.problem.word, width / 2, wordY, SIZES.wordFont * unit, scene.wordScale)
  if (scene.countdown) {
    const font = `bold ${SIZES.countdownFont * unit}px ${SANS_FAMILY}`
    const countdownY = height * COUNTDOWN_Y_RATIO
    ctx.lineWidth = SIZES.countdownFont * unit * STROKE_RATIO
    ctx.strokeStyle = COLORS.wordStroke
    ctx.font = font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.strokeText(String(scene.remainingSeconds), width / 2, countdownY)
    centerText(ctx, String(scene.remainingSeconds), width / 2, countdownY, font, COLORS.countdown)
  }
}

const drawReveal = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, call: KanjiQuizCall, winnerName: string | null): void => {
  drawBand(ctx, width, unit, call, null)
  const margin = SIZES.margin * unit
  const top = (SIZES.margin * 2 + SIZES.bandHeight) * unit
  fillPanel(ctx, margin * 2, top, width - margin * 4, height - top - margin, SIZES.panelRadius * unit)

  let y = top + (SIZES.panelPadding + SIZES.timeUpFont / 2) * unit
  // 正解者がいれば名前を祝い、いなければ時間切れを告げる
  const headline = winnerName === null ? '時間切れ！ 正解は…' : winnerLineOf(winnerName)
  centerText(ctx, headline, width / 2, y, `bold ${SIZES.timeUpFont * unit}px ${SANS_FAMILY}`, winnerName === null ? COLORS.countdown : COLORS.accent)
  y += (SIZES.timeUpFont / 2 + SIZES.revealWordFont * REVEAL_LINE_RATIO) * unit
  drawWord(ctx, call.problem.word, width / 2, y, SIZES.revealWordFont * unit, 1)
  y += (SIZES.revealWordFont * REVEAL_LINE_RATIO + SIZES.answerFont * REVEAL_LINE_RATIO) * unit
  centerText(ctx, answerLineOf(call.problem.readings), width / 2, y, `bold ${SIZES.answerFont * unit}px ${SANS_FAMILY}`, COLORS.accent)
  y += (SIZES.answerFont * REVEAL_LINE_RATIO + SIZES.explanationFont * SIZES.lineGap) * unit

  const explanationFont = `${SIZES.explanationFont * unit}px ${SANS_FAMILY}`
  ctx.font = explanationFont
  const lines = wrapText(call.problem.explanation, SIZES.explanationWidth * unit, (text) => ctx.measureText(text).width)
  for (const [index, line] of lines.entries()) {
    centerText(ctx, line, width / 2, y + index * SIZES.explanationFont * SIZES.lineGap * unit, explanationFont, COLORS.text)
  }
}

/**
 * 1フレームぶんを描く。流していなければ（playing が null）何も描かない。
 *
 * @param width 箱のCSS上の幅
 * @param height 箱のCSS上の高さ
 * @param playing 流している出題と場面と、最初の正解者の名前（届いていなければ null）
 */
export const drawKanjiQuiz = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  playing: { call: KanjiQuizCall; scene: KanjiQuizScene; winnerName: string | null } | null,
): void => {
  ctx.clearRect(0, 0, width, height)
  if (playing === null) return
  const unit = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT)
  const { call, scene, winnerName } = playing
  switch (scene.kind) {
    case 'grade':
      drawGrade(ctx, width, height, unit, call, scene.progress)
      return
    case 'question':
      drawQuestion(ctx, width, height, unit, call, scene)
      return
    case 'reveal':
      drawReveal(ctx, width, height, unit, call, winnerName)
      return
    case 'done':
      return
  }
}
