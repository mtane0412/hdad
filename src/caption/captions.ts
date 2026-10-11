/**
 * 映す字幕の決め方（合成ページの素材「字幕」）
 *
 * 届いた暫定・確定の文（message.ts）を積み、いま映す行を「届いた時刻」と「いまの時刻」だけから決める。
 * DOMもタイマーも持たず、合成ページは毎フレームここへ時刻を渡して映す行を受け取る（view.ts）。
 *
 * 見た目の既定は配信者に選ばせず、ここで決め切る（docs/principles.md の方針1。経緯は docs/decisions/caption.md）。
 * - 映すのは原文1文と訳文1つだけ。原文はいちばん新しい文（話している途中の文があればそれ、無ければ直前に確定した文）、
 *   訳文はいちばん新しく届いたもので、原文と別の文の訳のことがある。文を積み上げると、折り返した行が配信画面を埋める
 * - 確定した行は、確定してから FINAL_LIFETIME_MS で消す。訳文（issue #191）が届いたら同じIDの行に結び付け、
 *   訳文が届いてから数え直す（訳は原文より遅れて届くので、訳を読む時間を取る）。結び付ける先の行がもう無い訳文は捨てる
 * - 話している途中の文は、書き換わらないまま INTERIM_LIFETIME_MS が経ったら消す。認識していたタブが閉じられると
 *   「途中の文が無くなった」知らせが届かないので、話しかけの文が配信画面に残り続けないようにする
 * - 長い行は末尾（新しく話した部分）だけを CAPTION_MAX_CHARS 字まで映し、先頭を「…」で落とす（訳文は TRANSLATION_MAX_CHARS 字）。
 *   Web Speech API は話し続けるあいだ文を確定しないので、1発話が数百字になり、折り返すと配信画面の半分を埋める
 */
import type { CaptionMessage } from './message'

/**
 * 確定した行を映しておく時間（ミリ秒）。
 *
 * 1件の発話は平均14文字ほど（2026-10-01 の配信で 1,106 発話・15,722 字）で、読むのに3〜4秒かかる。
 * 訳文は次の文を話しはじめても残るので、読み終える前に消えないよう少し長めに取る。
 */
export const FINAL_LIFETIME_MS = 6000

/** 話している途中の文を、書き換わらないまま映しておく時間（ミリ秒）。ふつうは話しているあいだ1秒に何度も書き換わる */
export const INTERIM_LIFETIME_MS = 10000

/**
 * 原文の1行に映す字数の上限（「…」を含む）。
 *
 * 44pxの文字を左右96pxの余白を除いた1728px（src/caption/caption.css）に並べると1行に約39字入るので、2行ぶんにする。
 * 2026-10-02 の配信（Web Speech API）では 229 発話のうち 20 件がこれを超え、最長は268字だった。
 */
export const CAPTION_MAX_CHARS = 76

/** 訳文の1行に映す字数の上限（「…」を含む）。34pxの英字は1行に約90字入るので、単語の折り返しの余裕を見て2行ぶん弱にする */
export const TRANSLATION_MAX_CHARS = 160

/** 落とした先頭の代わりに付ける印 */
const ELLIPSIS = '…'

/**
 * 文の末尾だけを、「…」を含めて max 字までに切り詰める。
 *
 * 残す部分の前半に空白があれば、その次から始める（Web Speech API は話の間に空白を挟み、英語は単語の間に空白があるので、
 * 言葉の途中から始まらないようにする）。後半の空白にはそろえない（残る文が短くなりすぎる）。
 * 字数はコードポイントで数え、絵文字などを途中で割らない。
 */
export const tailOf = (text: string, max: number): string => {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const kept = chars.slice(chars.length - (max - 1))
  const space = kept.findIndex((char) => /\s/.test(char))
  const start = space !== -1 && space < kept.length / 2 ? space + 1 : 0
  return ELLIPSIS + kept.slice(start).join('')
}

/** 届いた時刻つきの1行 */
interface TimedLine {
  readonly text: string
  /** 届いた時刻（ミリ秒。合成ページの描画ループと同じ時計） */
  readonly at: number
}

/** 確定した1行。訳文が届いたら添える */
interface FinalLine extends TimedLine {
  readonly id: string
  readonly translation: string | null
}

/** 届いた字幕の積み上げ */
export interface CaptionState {
  /** 確定した行（古いものから。FINAL_LIFETIME_MS を過ぎたものは次の確定のときに捨てる） */
  readonly finals: readonly FinalLine[]
  /** 話している途中の文（無ければ null） */
  readonly interim: TimedLine | null
}

/** 映す1行 */
export interface CaptionLine {
  readonly text: string
  /** 確定した行なら true、話している途中の文なら false */
  readonly final: boolean
  /** 原文の下に添える訳文（いちばん新しく届いたもの。原文と別の文の訳のことがある）。映す訳文が無ければ null */
  readonly translation: string | null
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
  if (message.type === 'translation') {
    // 添える先がもう消えていれば捨てる。消えた行を訳文で呼び戻すと、話の流れから遅れた字幕が現れて紛らわしい
    const index = state.finals.findIndex((line) => line.id === message.id && now - line.at < FINAL_LIFETIME_MS)
    if (index === -1) return state
    return { ...state, finals: state.finals.map((line, at) => (at === index ? { ...line, translation: message.text, at: now } : line)) }
  }
  // 確定した文は、それまで話していた途中の文の続きなので、途中の文と入れ替える。
  // 訳文は次の文が確定したあとにも届くので、映しておく時間のうちは前の行も持っておく
  const line: FinalLine = { id: message.id, text: message.text, at: now, translation: null }
  return { finals: [...state.finals.filter((final) => now - final.at < FINAL_LIFETIME_MS), line], interim: null }
}

/** いま映す行（いちばん新しい1文だけ。何も映さないなら空） */
export const visibleCaptions = (state: CaptionState, now: number): CaptionLine[] => {
  const finals = state.finals.filter((line) => now - line.at < FINAL_LIFETIME_MS)
  const interim = state.interim !== null && now - state.interim.at < INTERIM_LIFETIME_MS ? state.interim : null
  const latest = interim ?? finals.at(-1)
  if (latest === undefined) return []
  // 訳文を添えた行は訳文が届いた時刻を持つので、時刻がいちばん新しいものが最後に届いた訳文である
  const translated = finals
    .filter((line) => line.translation !== null)
    .reduce<FinalLine | null>((newest, line) => (newest === null || line.at >= newest.at ? line : newest), null)
  const translation = translated?.translation ?? null
  return [
    {
      text: tailOf(latest.text, CAPTION_MAX_CHARS),
      final: latest !== interim,
      translation: translation === null ? null : tailOf(translation, TRANSLATION_MAX_CHARS),
    },
  ]
}
