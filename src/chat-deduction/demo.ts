/**
 * 合成ページの素材「チャットで推理」のサンプル（issue #378）
 *
 * 管理画面のプレビューは Worker につながないので、富士山の問題で質問が増えていき、不正解を挟んで正解で終わる場面を順に流す。
 * 開催中の場面は正解の表記を持たない（Worker と同じく、開催中に答えを出さない）。
 * プレビューでは音を鳴らさないので、音の設定はどの枠も鳴らさない形にしておく。
 */
import type { ChatDeductionBoard, ChatDeductionBoardGame, ChatDeductionCard } from './board'
import type { ChatDeductionSound } from './sound'

const game: ChatDeductionBoardGame = { id: 1, category: 'place', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null, answer: null }

const silentSound: ChatDeductionSound = {
  slots: { bgm: null, start: null, answered: null, wrong: null, correct: null, stopped: null },
  bgmVolume: 0,
  effectVolume: 0,
}

const cards: readonly ChatDeductionCard[] = [
  { kind: 'question', id: 1, userName: 'hana', text: '生き物ですか？', verdict: 'no', reply: '生き物ではありません。' },
  { kind: 'question', id: 2, userName: 'mugi', text: '日本にありますか？', verdict: 'yes', reply: '静岡県と山梨県にまたがっています。' },
  { kind: 'question', id: 3, userName: 'ren', text: '温泉が湧いていますか？', verdict: 'unknown', reply: 'メモからは分かりません。' },
  { kind: 'guess', id: 1, userName: 'aoi', text: '阿蘇山', correct: false },
  { kind: 'question', id: 4, userName: 'hana', text: '日本でいちばん高いですか？', verdict: 'yes', reply: '標高3776メートルで日本一です。' },
  { kind: 'guess', id: 2, userName: 'mugi', text: '富士山', correct: true },
]

/** カードが1枚ずつ増えていく場面。最後の1枚（正解）で終える */
export const demoChatDeductionBoards: readonly ChatDeductionBoard[] = cards.map((_, index) => {
  const shown = cards.slice(0, index + 1)
  const solved = index === cards.length - 1
  return {
    game: solved ? { ...game, endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山' } : game,
    cards: shown,
    sound: silentSound,
  }
})
