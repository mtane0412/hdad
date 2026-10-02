/**
 * 映す字幕の決め方（合成ページの素材「字幕」）
 *
 * 届いた暫定・確定の文（message.ts）を積み、いま映す行を「届いた時刻」と「いまの時刻」だけから決める。
 * DOMもタイマーも持たず、合成ページは毎フレームここへ時刻を渡して映す行を受け取る（view.ts）。
 *
 * 見た目の既定は配信者に選ばせず、ここで決め切る（docs/principles.md の方針1。経緯は docs/decisions/caption.md）。
 * - 映すのは新しいものから CAPTION_LINES 行まで。話している途中の文がいちばん下に来る
 * - 確定した行は、確定してから FINAL_LIFETIME_MS で消す
 * - 話している途中の文は、書き換わらないまま INTERIM_LIFETIME_MS が経ったら消す。認識していたタブが閉じられると
 *   「途中の文が無くなった」知らせが届かないので、話しかけの文が配信画面に残り続けないようにする
 */
import type { CaptionMessage } from './message'

/** 映す行数の上限 */
export const CAPTION_LINES = 2

/**
 * 確定した行を映しておく時間（ミリ秒）。
 *
 * 1件の発話は平均14文字ほど（2026-10-01 の配信で 1,106 発話・15,722 字）で、読むのに3〜4秒かかる。
 * 次の発話が続けて確定しても前の行は上に残るので、読み終える前に消えないよう少し長めに取る。
 */
export const FINAL_LIFETIME_MS = 6000

/** 話している途中の文を、書き換わらないまま映しておく時間（ミリ秒）。ふつうは話しているあいだ1秒に何度も書き換わる */
export const INTERIM_LIFETIME_MS = 10000

/** 届いた時刻つきの1行 */
interface TimedLine {
  readonly text: string
  /** 届いた時刻（ミリ秒。合成ページの描画ループと同じ時計） */
  readonly at: number
}

/** 届いた字幕の積み上げ */
export interface CaptionState {
  /** 確定した行（古いものから。上限を超えたら古いものから捨てる） */
  readonly finals: readonly TimedLine[]
  /** 話している途中の文（無ければ null） */
  readonly interim: TimedLine | null
}

/** 映す1行 */
export interface CaptionLine {
  readonly text: string
  /** 確定した行なら true、話している途中の文なら false */
  readonly final: boolean
}

/** まだ何も届いていない */
export const NO_CAPTIONS: CaptionState = { finals: [], interim: null }

/**
 * 届いた1通を積む。
 *
 * @param now 届いた時刻（ミリ秒。visibleCaptions に渡す時刻と同じ時計）
 */
export const applyCaptionMessage = (state: CaptionState, message: CaptionMessage, now: number): CaptionState => {
  if (message.type === 'interim') {
    return { ...state, interim: message.text === '' ? null : { text: message.text, at: now } }
  }
  // 確定した文は、それまで話していた途中の文の続きなので、途中の文と入れ替える。
  // 映すのは CAPTION_LINES 行までなので、それより古い確定の行は持っておかない
  return { finals: [...state.finals, { text: message.text, at: now }].slice(-CAPTION_LINES), interim: null }
}

/** いま映す行（上から下へ。新しいものが下） */
export const visibleCaptions = (state: CaptionState, now: number): CaptionLine[] => {
  const finals = state.finals.filter((line) => now - line.at < FINAL_LIFETIME_MS).map((line) => ({ text: line.text, final: true }))
  const interim = state.interim !== null && now - state.interim.at < INTERIM_LIFETIME_MS ? [{ text: state.interim.text, final: false }] : []
  return [...finals, ...interim].slice(-CAPTION_LINES)
}
