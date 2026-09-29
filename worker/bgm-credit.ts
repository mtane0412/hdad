/**
 * BGMのクレジットの差し込み語 {bgm}
 *
 * チャットコマンドの応答文の {bgm} を、いま流している曲の曲名・クレジット表記・クレジット先のURLに置き換える（issue #152）。
 * 専用のコマンドを作らず差し込み語にするのは、{summary}（stream-summary.ts）と同じく、
 * コマンド名や前後の文言を配信者が決められるようにするためである。
 *
 * 注意: 曲を止めているのは正常な状態なので、エラーにせず流していないと分かる文言に置き換える
 * （視聴者がコマンドを打ったのに無応答だと、壊れているのか止めているのか区別できない）。
 */
import { MAX_CREDIT_LENGTH, MAX_CREDIT_URL_LENGTH, MAX_TITLE_LENGTH, type BgmTrack } from './bgm-config'

/** 応答文に書く差し込み語 */
export const BGM_PLACEHOLDER = '{bgm}'

/** 曲を止めているときに {bgm} へ入れる文言 */
export const NO_BGM = 'いまはBGMを流していません'

/** クレジットの文に要る、曲の項目 */
export type BgmCreditSource = Pick<BgmTrack, 'title' | 'credit' | 'creditUrl'>

/**
 * {bgm} が置き換わる文の最大の長さ。応答文の長さの検証（bot-config.ts）が、保存の時点で見積もるのに使う。
 * 曲名を囲む「」と、項目の間の空白2つのぶんを足している（bgmCreditText の形と合わせる）
 */
export const MAX_BGM_CREDIT_LENGTH = MAX_TITLE_LENGTH + MAX_CREDIT_LENGTH + MAX_CREDIT_URL_LENGTH + 4

/**
 * 流している曲のクレジットを1行の文にする。
 *
 * @param track 流している曲。止めているときは null
 */
export const bgmCreditText = (track: BgmCreditSource | null): string => {
  if (track === null) return NO_BGM
  const text = `「${track.title}」 ${track.credit}`
  return track.creditUrl === '' ? text : `${text} ${track.creditUrl}`
}

/**
 * 文言の差し込み語 {bgm} を、流している曲のクレジットに置き換える。
 *
 * @param track 流している曲。止めている・読む必要がない場合は null
 */
export const fillBgmCredit = (text: string, track: BgmCreditSource | null): string =>
  // 置き換えを関数で渡すのは、曲名に $& などが入っていても置き換えの記号として読ませないため
  text.replaceAll(BGM_PLACEHOLDER, () => bgmCreditText(track))
