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
  game: {
    id: 1,
    category: 'place',
    topic: null,
    startedAt: '2026-10-15T12:00:00.000Z',
    closesAt: '2026-10-15T12:10:00.000Z',
    endedAt: '2026-10-15T12:05:00.000Z',
    endReason: 'solved',
    answer: '富士山',
    explanation: '静岡県と山梨県にまたがる日本一の山。',
    image: { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Mt.Fuji.jpg/1280px-Mt.Fuji.jpg', artist: '山田花子', license: 'CC0' },
  },
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

  it('時間切れで終えたゲームと、締め切りの無いゲームを読む', () => {
    const timedOut = { ...solvedBoard, game: { ...solvedBoard.game!, endReason: 'timeout' as const } }
    const unlimited = { ...solvedBoard, game: { ...solvedBoard.game!, closesAt: null } }

    expect(readChatDeductionBoard(structuredClone(timedOut))).toEqual(timedOut)
    expect(readChatDeductionBoard(structuredClone(unlimited))).toEqual(unlimited)
  })

  it('締め切りが文字列でも null でもなければ投げる', () => {
    expect(() => readChatDeductionBoard({ ...solvedBoard, game: { ...solvedBoard.game, closesAt: 600 } })).toThrow('game')
  })

  it('知らない区分・知らない答え・知らないカードの種類なら投げる（黙って映さない）', () => {
    expect(() => readChatDeductionBoard({ ...solvedBoard, game: { ...solvedBoard.game, category: 'animal' } })).toThrow('game')
    expect(() => readChatDeductionBoard({ ...solvedBoard, game: { ...solvedBoard.game, explanation: 1 } })).toThrow('game')
    expect(() => readChatDeductionBoard({ ...solvedBoard, game: { ...solvedBoard.game, image: { url: 'https://upload.wikimedia.org/a.jpg', artist: '山田花子' } } })).toThrow('game')
    expect(() => readChatDeductionBoard({ ...solvedBoard, cards: [{ ...solvedBoard.cards[0], verdict: 'maybe' }] })).toThrow('cards')
    expect(() => readChatDeductionBoard({ ...solvedBoard, cards: [{ kind: 'hint', id: 1, userName: '田中太郎', text: 'ヒント' }] })).toThrow('cards')
  })

  it('時代などの括りを読む（括りが無ければ null）', () => {
    const ancientBoard = { ...solvedBoard, game: { ...solvedBoard.game, category: 'person', topic: '古代史' } }
    expect(readChatDeductionBoard(structuredClone(ancientBoard))).toEqual(ancientBoard)
  })

  it('括りが文字列でも null でもなければ投げる', () => {
    expect(() => readChatDeductionBoard({ ...solvedBoard, game: { ...solvedBoard.game, topic: 1 } })).toThrow('game')
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
