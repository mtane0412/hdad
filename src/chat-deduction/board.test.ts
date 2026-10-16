/**
 * 合成ページの素材「チャットで推理」が受け取るカードの一覧の読み取り（board.ts）のテスト
 *
 * Worker の応答と WebSocket で押し出された文字列を、形を確かめてから読むこと（想定外の形は黙って映さずに投げる）を確かめる（issue #378）。
 */
import { describe, expect, it } from 'vitest'
import { parseChatDeductionBoardMessage, readChatDeductionBoard, type ChatDeductionBoard } from './board'

/** BGM と正解の音だけを選んだ設定 */
const sound = {
  slots: { bgm: '/api/media/media-thinking?key=overlay-key', start: null, answered: null, wrong: null, correct: '/api/media/media-pinpon?key=overlay-key', stopped: null },
  bgmVolume: 0.2,
  effectVolume: 0.6,
}

/** 富士山の問題で、質問1件・不正解1件・正解1件まで進んで終えたゲーム */
const solvedBoard: ChatDeductionBoard = {
  game: { id: 1, category: 'place', startedAt: '2026-10-15T12:00:00.000Z', endedAt: '2026-10-15T12:05:00.000Z', endReason: 'solved', answer: '富士山' },
  cards: [
    { kind: 'question', id: 1, userName: '田中太郎', text: '日本にありますか？', verdict: 'yes', reply: '静岡県と山梨県にまたがっています。' },
    { kind: 'guess', id: 1, userName: '鈴木花子', text: '阿蘇山', correct: false },
    { kind: 'guess', id: 2, userName: '田中太郎', text: '富士山', correct: true },
  ],
  sound,
}

describe('readChatDeductionBoard', () => {
  it('ゲームとカードの一覧を読む', () => {
    expect(readChatDeductionBoard(structuredClone(solvedBoard))).toEqual(solvedBoard)
  })

  it('一度もゲームを始めていなければ、ゲームは null として読む', () => {
    expect(readChatDeductionBoard({ game: null, cards: [], sound })).toEqual({ game: null, cards: [], sound })
  })

  it('知らない区分・知らない答え・知らないカードの種類なら投げる（黙って映さない）', () => {
    expect(() => readChatDeductionBoard({ ...solvedBoard, game: { ...solvedBoard.game, category: 'animal' } })).toThrow('game')
    expect(() => readChatDeductionBoard({ ...solvedBoard, cards: [{ ...solvedBoard.cards[0], verdict: 'maybe' }] })).toThrow('cards')
    expect(() => readChatDeductionBoard({ ...solvedBoard, cards: [{ kind: 'hint', id: 1, userName: '田中太郎', text: 'ヒント' }] })).toThrow('cards')
  })

  it('音の設定が無い・枠が欠けていれば投げる（黙って無音にしない）', () => {
    expect(() => readChatDeductionBoard({ game: null, cards: [] })).toThrow('音の設定')
    expect(() => readChatDeductionBoard({ ...solvedBoard, sound: { ...sound, slots: { bgm: null } } })).toThrow('start')
  })
})

describe('parseChatDeductionBoardMessage', () => {
  it('押し出された文字列をカードの一覧として読む', () => {
    expect(parseChatDeductionBoardMessage(JSON.stringify(solvedBoard))).toEqual(solvedBoard)
  })

  it('JSONとして読めなければ投げる', () => {
    expect(() => parseChatDeductionBoardMessage('{壊れた')).toThrow('JSON')
  })
})
