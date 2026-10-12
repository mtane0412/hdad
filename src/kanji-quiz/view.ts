/**
 * 漢字クイズの描画（Canvas 2D）
 *
 * 1フレームぶんの場面（scene.ts の kanjiQuizSceneAt）と出題を受け取り、次を描く。
 * - 級の場面: 画面の真ん中に「漢検○級」と、出題させた人
 * - 出題の場面: 上の帯に級と出題させた人と残り秒数、真ん中に熟語（倍率は場面が決め、ctx.scale で奥から近づける）。
 *   最後の数秒は残り秒数を熟語の下に大きく赤で出す。チャットの不正解の回答が届いていれば、最後の1件を熟語のすぐ下（いまの倍率での下端の下）に「直前の回答」として出す
 * - 答えの場面: はじめは「時間切れ！」（正解者が届いていれば「○○さん 正解！」。issue #301）だけを真ん中に大きく出し、
 *   解説の場面（scene.explanation）になったら、見出しを小さくして画面の真ん中の横帯の上に載せる。
 *   横帯は左に熟語、右に正解の読みと解説を並べ、画面を覆いすぎないコンパクトな形にする
 * - 配信を止めるまでの帯（issue #302）: 答えの場面に重ねて、画面の下に配信終了までの残り秒数・結果を出す
 *
 * 文言は captions.ts、文の折り返しは市町村紹介と同じ wrapText が決め、ここは描くだけを受け持つ（通信も状態も持たない）。
 * テストを持たない（canvas に描くだけのため）。
 */
import { wrapText } from '../town-tour/wrap'
import { answerLineOf, gradeHeadlineOf, requesterLineOf, stopBannerLineOf, winnerLineOf, wrongAnswerLineOf } from './captions'
import type { KanjiQuizCall } from './call'
import type { KanjiQuizScene, KanjiQuizStopBanner } from './scene'

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
  /** 結果だけを見せるあいだの見出し */
  resultFont: 120,
  /** 解説の帯の上に載せる見出し */
  timeUpFont: 56,
  /** 解説の帯の高さ（解説が3行以上に折り返したら、そのぶん伸ばす） */
  revealBandHeight: 240,
  revealWordFont: 130,
  answerFont: 60,
  explanationFont: 48,
  lineGap: 1.4,
  panelPadding: 48,
  panelRadius: 32,
  margin: 48,
  /** 帯の中で、級と出題させた人のあいだに空ける幅 */
  bandGap: 32,
  stopBannerHeight: 150,
  stopBannerFont: 80,
  /** 熟語の下に出す、直前の回答の板 */
  wrongAnswerFont: 44,
  wrongAnswerHeight: 76,
  wrongAnswerGap: 16,
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
/** 解説の帯のうち、熟語を置く左側の幅（帯の幅に対する割合） */
const REVEAL_WORD_PANEL_RATIO = 0.32
/** 熟語が左側に収まらないときに縮める目安（左側の幅に対する、熟語の幅の上限の割合） */
const REVEAL_WORD_FIT_RATIO = 0.85
/** 解説の帯の中で、読みの行と解説の行のあいだに引く線の太さ（px。基準の大きさで） */
const REVEAL_RULE_WIDTH = 3

const COLORS = {
  panel: 'rgba(16, 20, 32, 0.82)',
  text: '#ffffff',
  sub: '#c8d0e0',
  accent: '#ffcf40',
  countdown: '#ff4d4d',
  wordStroke: 'rgba(0, 0, 0, 0.6)',
  /** 解説の帯の、熟語を置く左側と、読みと解説を置く右側 */
  revealWordPanel: 'rgba(20, 28, 80, 0.88)',
  revealTextPanel: 'rgba(8, 8, 12, 0.85)',
  reading: '#f0a0ff',
  revealRule: 'rgba(255, 255, 255, 0.7)',
  /** 配信を止めるまでの帯。止まる・数えているあいだは赤、止めない（取り消し・試し再生）ときは落ち着いた色 */
  stopBanner: 'rgba(30, 90, 60, 0.92)',
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

/**
 * 直前の回答（不正解）を、熟語のすぐ下の真ん中に、文字の幅に合わせた板に載せて描く。長ければ箱の幅に収まるよう縮める
 *
 * @param top 板の上端（熟語のいまの下端に間を空けた位置。熟語が近づくにつれて下がる）
 */
const drawWrongAnswer = (ctx: CanvasRenderingContext2D, width: number, unit: number, top: number, wrongAnswer: KanjiQuizWrongAnswer): void => {
  const margin = SIZES.margin * unit
  const line = wrongAnswerLineOf(wrongAnswer)
  ctx.font = `bold ${SIZES.wrongAnswerFont * unit}px ${SANS_FAMILY}`
  const padding = SIZES.panelPadding * unit
  const fit = Math.min(1, (width - margin * 2 - padding * 2) / ctx.measureText(line).width)
  const fontSize = SIZES.wrongAnswerFont * unit * fit
  const panelWidth = ctx.measureText(line).width * fit + padding * 2
  const panelHeight = SIZES.wrongAnswerHeight * unit
  fillPanel(ctx, (width - panelWidth) / 2, top, panelWidth, panelHeight, SIZES.panelRadius * unit)
  centerText(ctx, line, width / 2, top + panelHeight / 2, `bold ${fontSize}px ${SANS_FAMILY}`, COLORS.sub)
}

const drawQuestion = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  unit: number,
  call: KanjiQuizCall,
  scene: Extract<KanjiQuizScene, { kind: 'question' }>,
  wrongAnswer: KanjiQuizWrongAnswer | null,
): void => {
  // 大きなカウントダウンを出しているあいだは、帯の残り秒数を重ねて出さない
  drawBand(ctx, width, unit, call, scene.countdown ? null : scene.remainingSeconds)
  const wordY = scene.countdown ? height * COUNTDOWN_WORD_Y_RATIO : height / 2
  drawWord(ctx, call.problem.word, width / 2, wordY, SIZES.wordFont * unit, scene.wordScale)
  if (wrongAnswer !== null) {
    // 熟語は真ん中を中心に倍率を掛けて描くので、いまの下端は文字の大きさの半分に倍率を掛けたところ
    const wordBottom = wordY + (SIZES.wordFont * unit * scene.wordScale) / 2
    drawWrongAnswer(ctx, width, unit, wordBottom + SIZES.wrongAnswerGap * unit, wrongAnswer)
  }
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

/** 答えの場面の見出し（正解者がいれば名前を祝い、いなければ時間切れを告げる）と、その色 */
const revealHeadlineOf = (winnerName: string | null): { text: string; color: string } =>
  winnerName === null ? { text: '時間切れ！', color: COLORS.countdown } : { text: winnerLineOf(winnerName), color: COLORS.accent }

/** 縁取りしてから塗る1行（背景の映像に負けないように）。textAlign と textBaseline は呼び出し側が決める */
const outlinedText = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fontSize: number, font: string, color: string): void => {
  ctx.font = font
  ctx.lineWidth = fontSize * STROKE_RATIO
  ctx.lineJoin = 'round'
  ctx.strokeStyle = COLORS.wordStroke
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

const drawReveal = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  unit: number,
  call: KanjiQuizCall,
  scene: Extract<KanjiQuizScene, { kind: 'reveal' }>,
  winnerName: string | null,
): void => {
  drawBand(ctx, width, unit, call, null)
  const headline = revealHeadlineOf(winnerName)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // 結果だけを見せるあいだは、見出しを真ん中に大きく出す
  if (!scene.explanation) {
    const fontSize = SIZES.resultFont * unit
    outlinedText(ctx, headline.text, width / 2, height / 2, fontSize, `bold ${fontSize}px ${SANS_FAMILY}`, headline.color)
    return
  }

  // 解説は帯の右側に折り返す。3行以上になったら、そのぶん帯を伸ばす
  const margin = SIZES.margin * unit
  const bandX = margin
  const bandWidth = width - margin * 2
  const wordPanelWidth = bandWidth * REVEAL_WORD_PANEL_RATIO
  const textX = bandX + wordPanelWidth + SIZES.panelPadding * unit
  const textWidth = bandWidth - wordPanelWidth - SIZES.panelPadding * 2 * unit
  const explanationFont = `bold ${SIZES.explanationFont * unit}px ${SANS_FAMILY}`
  ctx.font = explanationFont
  const lines = wrapText(call.problem.explanation, textWidth, (text) => ctx.measureText(text).width)
  const explanationLineHeight = SIZES.explanationFont * SIZES.lineGap * unit
  const answerBlockHeight = SIZES.answerFont * SIZES.lineGap * unit
  // 読み・読みと解説のあいだ・解説・解説の下の線までの高さ
  const contentHeight = answerBlockHeight + SIZES.panelPadding * unit + lines.length * explanationLineHeight + (SIZES.panelPadding / 2 + REVEAL_RULE_WIDTH) * unit
  const bandHeight = Math.max(SIZES.revealBandHeight * unit, contentHeight + SIZES.panelPadding * unit)
  const bandY = (height - bandHeight) / 2

  // 帯の上に、見出しを小さく載せる
  const headlineSize = SIZES.timeUpFont * unit
  outlinedText(ctx, headline.text, width / 2, bandY - headlineSize, headlineSize, `bold ${headlineSize}px ${SANS_FAMILY}`, headline.color)

  // 左側: 熟語。長い熟語は左側に収まるよう縮める
  ctx.fillStyle = COLORS.revealWordPanel
  ctx.fillRect(bandX, bandY, wordPanelWidth, bandHeight)
  ctx.font = `bold ${SIZES.revealWordFont * unit}px ${WORD_FAMILY}`
  const wordFit = Math.min(1, (wordPanelWidth * REVEAL_WORD_FIT_RATIO) / ctx.measureText(call.problem.word).width)
  const wordSize = SIZES.revealWordFont * unit * wordFit
  outlinedText(ctx, call.problem.word, bandX + wordPanelWidth / 2, bandY + bandHeight / 2, wordSize, `bold ${wordSize}px ${WORD_FAMILY}`, COLORS.accent)

  // 右側: 正解の読み（真ん中寄せ）と、線で区切った解説（左寄せ）
  ctx.fillStyle = COLORS.revealTextPanel
  ctx.fillRect(bandX + wordPanelWidth, bandY, bandWidth - wordPanelWidth, bandHeight)
  const contentTop = bandY + (bandHeight - contentHeight) / 2
  const answerY = contentTop + answerBlockHeight / 2
  // 読みが多い・長い問題は、右側の幅に収まるよう縮める
  const answer = answerLineOf(call.problem.readings)
  ctx.font = `bold ${SIZES.answerFont * unit}px ${SANS_FAMILY}`
  const answerSize = SIZES.answerFont * unit * Math.min(1, textWidth / ctx.measureText(answer).width)
  centerText(ctx, answer, textX + textWidth / 2, answerY, `bold ${answerSize}px ${SANS_FAMILY}`, COLORS.reading)
  const explanationTop = contentTop + answerBlockHeight + SIZES.panelPadding * unit
  ctx.font = explanationFont
  ctx.fillStyle = COLORS.text
  ctx.textAlign = 'left'
  for (const [index, line] of lines.entries()) {
    ctx.fillText(line, textX, explanationTop + (index + 0.5) * explanationLineHeight)
  }
  // 解説の下に線を引く（参考にした番組の字幕の形）
  const ruleY = explanationTop + lines.length * explanationLineHeight + (SIZES.panelPadding / 2) * unit
  ctx.fillStyle = COLORS.revealRule
  ctx.fillRect(textX, ruleY, textWidth, REVEAL_RULE_WIDTH * unit)
}

/** 配信を止める時刻の帯（試し再生で止めないこと）を、画面の下に重ねて描く */
const drawStopBanner = (ctx: CanvasRenderingContext2D, width: number, height: number, unit: number, banner: KanjiQuizStopBanner): void => {
  const margin = SIZES.margin * unit
  const bannerHeight = SIZES.stopBannerHeight * unit
  const top = height - margin * 2 - bannerHeight
  ctx.fillStyle = COLORS.stopBanner
  ctx.beginPath()
  ctx.roundRect(margin * 3, top, width - margin * 6, bannerHeight, SIZES.panelRadius * unit)
  ctx.fill()
  centerText(ctx, stopBannerLineOf(banner), width / 2, top + bannerHeight / 2, `bold ${SIZES.stopBannerFont * unit}px ${SANS_FAMILY}`, COLORS.text)
}

/** 直前の回答（チャットの不正解の回答）。答えた人の表示名と、書かれたままの回答 */
export interface KanjiQuizWrongAnswer {
  readonly userName: string
  readonly answer: string
}

/**
 * 1フレームぶんを描く。流していなければ（playing が null）何も描かない。
 *
 * @param width 箱のCSS上の幅
 * @param height 箱のCSS上の高さ
 * @param playing 流している出題と場面と、最初の正解者の名前（届いていなければ null）と、配信を止めるまでの帯（出さなければ null）と、
 *   直前の回答（届いていなければ null。出題の場面でだけ出す）
 */
export const drawKanjiQuiz = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  playing: {
    call: KanjiQuizCall
    scene: KanjiQuizScene
    winnerName: string | null
    stopBanner: KanjiQuizStopBanner | null
    wrongAnswer: KanjiQuizWrongAnswer | null
  } | null,
): void => {
  ctx.clearRect(0, 0, width, height)
  if (playing === null) return
  const unit = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT)
  const { call, scene, winnerName, stopBanner, wrongAnswer } = playing
  drawScene(ctx, width, height, unit, call, scene, winnerName, wrongAnswer)
  if (stopBanner !== null) drawStopBanner(ctx, width, height, unit, stopBanner)
}

const drawScene = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  unit: number,
  call: KanjiQuizCall,
  scene: KanjiQuizScene,
  winnerName: string | null,
  wrongAnswer: KanjiQuizWrongAnswer | null,
): void => {
  switch (scene.kind) {
    case 'grade':
      drawGrade(ctx, width, height, unit, call, scene.progress)
      return
    case 'question':
      drawQuestion(ctx, width, height, unit, call, scene, wrongAnswer)
      return
    case 'reveal':
      drawReveal(ctx, width, height, unit, call, scene, winnerName)
      return
    case 'done':
      return
  }
}
