/**
 * チャットで推理の解答の照合（issue #377）
 *
 * 視聴者がチャンネルポイントの「解答」で送った文字列を、問題集の別名の一覧と照らして正誤を決める。
 * 表記を揃えてから完全一致したものだけを正解にし、LLM には判定させない（同じ解答が呼び出しのたびに違う判定にならないため）。
 * 表記の揺れのうち揃え方で吸収できないもの（略称・別の読みなど）は、問題集の別名に書き足して吸収する。
 *
 * 注意: Worker（解答の受け口）から読み込むので、DOM や src/core/ のブラウザ向けの部品に頼らない。
 * 注意: 揃え方はここだけが持つ。照合する両側（解答と別名）に同じ揃え方を通す。
 */
import type { ChatDeductionProblem } from './problems'

/** カタカナ（ァ〜ヶ）の範囲。ひらがな（ぁ〜ゖ）と同じ並びで、符号の位置が KATAKANA_OFFSET だけずれている */
const KATAKANA_PATTERN = /[ァ-ヶ]/g
const KATAKANA_OFFSET = 0x60
/** 照合で無視する文字（空白・中黒などの句読点・記号）。長音符（ー）は文字の一部なので含まない */
const IGNORED_PATTERN = /[\s\p{P}\p{S}]/gu

/**
 * 解答の表記を揃える。
 *
 * 1. 互換文字を揃える（NFKC。全角の英数字を半角に、半角のカタカナを全角にする）
 * 2. 英字を小文字にする
 * 3. 空白と記号（中黒・句読点・感嘆符など）を除く（前後の空白も途中の空白も除く）
 * 4. カタカナをひらがなに直す
 */
export const normalizeChatDeductionGuess = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(IGNORED_PATTERN, '')
    .replace(KATAKANA_PATTERN, (katakana) => String.fromCharCode(katakana.charCodeAt(0) - KATAKANA_OFFSET))

/**
 * 解答が問題の正解か。表記を揃えた解答が、表記を揃えた別名のどれかと完全に一致したときだけ正解にする。
 *
 * 揃えると空になる解答（記号だけ・空白だけ）は正解にしない。
 */
export const isCorrectChatDeductionGuess = (problem: ChatDeductionProblem, guess: string): boolean => {
  const normalized = normalizeChatDeductionGuess(guess)
  return normalized !== '' && problem.aliases.some((alias) => normalizeChatDeductionGuess(alias) === normalized)
}
