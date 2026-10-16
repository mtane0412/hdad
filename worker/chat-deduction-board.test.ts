/**
 * 合成ページの素材「チャットで推理」に映すもの（worker/chat-deduction-board.ts）のテスト
 *
 * 最後に始めたゲームの区分とカードの一覧を組み立てること、正解の表記はゲームを終えたあとにだけ載せること（開催中に答えを漏らさない）、
 * 組み立てたものを配送先へ押し出すことを、migrations/ を適用したメモリ上の SQLite で確かめる（issue #378）。
 * 場面ごとに鳴らす音の設定を、音声のURL（オーバーレイ用キーつき）にして一緒に載せることも確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { ChatDeductionProblem } from '../src/chat-deduction/problems'
import { pushLatestChatDeductionBoard, readChatDeductionBoard } from './chat-deduction-board'
import { DEFAULT_CHAT_DEDUCTION_SOUND } from './chat-deduction-sound'
import { answerQuestion, endGame, reserveQuestion, startGame } from './chat-deduction-store'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'

const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const LATER = NOW + 10 * 60 * 1000

/** テスト用の問題集（富士山の1問だけ） */
const problems: readonly ChatDeductionProblem[] = [
  { id: 'mount-fuji', category: 'place', answer: '富士山', aliases: ['富士山'], facts: ['日本でいちばん高い山。'] },
]

/** 田中太郎さんの質問「生き物ですか？」に「いいえ」と答えたゲーム */
const startGameWithOneAnswer = async () => {
  const db = createFakeDatabase()
  const game = await startGame(db, 'mount-fuji', NOW)
  const question = await reserveQuestion(
    db,
    { redemptionId: '交換ID-1', userId: '田中太郎のユーザーID', userLogin: 'tanaka_taro', userName: '田中太郎', question: '生き物ですか？' },
    { maxQuestionsPerGame: 30 },
    NOW,
  )
  await answerQuestion(db, question!.id, { verdict: 'no', reply: '生き物ではありません。' }, NOW + 1000)
  return { db, game: game! }
}

const OVERLAY_KEY = 'issued-overlay-key-0123456789abcdefghij'

/** オーバーレイ用キーを発行済みで、音の設定は未保存のストア */
const createStore = () => createFakeStore({ 'overlay-key': OVERLAY_KEY })

const card = { kind: 'question', id: 1, userName: '田中太郎', text: '生き物ですか？', verdict: 'no', reply: '生き物ではありません。' }

describe('readChatDeductionBoard', () => {
  it('一度もゲームを始めていなければ、ゲームもカードも無い', async () => {
    expect(await readChatDeductionBoard(createFakeDatabase(), createStore(), problems)).toEqual({ game: null, cards: [], sound: DEFAULT_CHAT_DEDUCTION_SOUND })
  })

  it('開催中のゲームは、区分とカードを載せ、正解の表記は載せない（答えを漏らさない）', async () => {
    const { db, game } = await startGameWithOneAnswer()

    expect(await readChatDeductionBoard(db, createStore(), problems)).toEqual({
      game: { id: game.id, category: 'place', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null, answer: null },
      cards: [card],
      sound: DEFAULT_CHAT_DEDUCTION_SOUND,
    })
  })

  it('終えたゲームは、正解の表記も載せる（「正解は富士山でした」を出すため）', async () => {
    const { db, game } = await startGameWithOneAnswer()
    await endGame(db, game.id, 'stopped', LATER)

    expect(await readChatDeductionBoard(db, createStore(), problems)).toEqual({
      game: { id: game.id, category: 'place', startedAt: '2026-10-15T12:00:00.000Z', endedAt: '2026-10-15T12:10:00.000Z', endReason: 'stopped', answer: '富士山' },
      cards: [card],
      sound: DEFAULT_CHAT_DEDUCTION_SOUND,
    })
  })

  it('最後のゲームの問題が問題集に無ければ、黙って空にせず投げる', async () => {
    const { db } = await startGameWithOneAnswer()

    await expect(readChatDeductionBoard(db, createStore(), [])).rejects.toThrow('問題集にありません')
  })

  it('音を選んだ枠は、オーバーレイ用キーつきの音声のURLにして載せる', async () => {
    // 前提: 回答の音に media-pon を選んで保存してある
    const store = createStore()
    await store.put('chat-deduction-sound', JSON.stringify({ ...DEFAULT_CHAT_DEDUCTION_SOUND, slots: { ...DEFAULT_CHAT_DEDUCTION_SOUND.slots, answered: 'media-pon' } }))

    const board = await readChatDeductionBoard(createFakeDatabase(), store, problems)

    expect(board.sound.slots.answered).toBe(`/api/media/media-pon?key=${OVERLAY_KEY}`)
  })
})

describe('pushLatestChatDeductionBoard', () => {
  it('最後に始めたゲームのカードの一覧を組み立てて、配送先へ押し出す', async () => {
    const { db } = await startGameWithOneAnswer()
    const store = createStore()
    const delivery = createFakeAlertChannel()

    await pushLatestChatDeductionBoard(db, store, delivery.namespace, problems)

    expect(delivery.pushedChatDeductions).toEqual([await readChatDeductionBoard(db, store, problems)])
  })

  it('配送先が失敗を返したら、黙って成功にせず投げる', async () => {
    const { db } = await startGameWithOneAnswer()

    await expect(pushLatestChatDeductionBoard(db, createStore(), createFakeAlertChannel({ shouldFail: true }).namespace, problems)).rejects.toThrow('チャットで推理')
  })
})
