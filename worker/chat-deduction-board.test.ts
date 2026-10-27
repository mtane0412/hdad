/**
 * 合成ページの素材「チャットで推理」に映すもの（worker/chat-deduction-board.ts）のテスト
 *
 * 最後に始めたゲームの区分とカードの一覧を組み立てること、正解の表記はゲームを終えたあとにだけ載せること（開催中に答えを漏らさない）、
 * 組み立てたものを配送先へ押し出すことを、migrations/ を適用したメモリ上の SQLite で確かめる（issue #378）。
 * 場面ごとに鳴らす音の設定を、音声のURL（オーバーレイ用キーつき）にして一緒に載せることも確かめる。
 * 解説に添える画像（images.json）も、解説と同じくゲームを終えたあとにだけ載せることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { ChatDeductionImage } from '../src/chat-deduction/images'
import type { ChatDeductionProblemSet } from '../src/chat-deduction/problems'
import { pushLatestChatDeductionBoard, readChatDeductionBoard } from './chat-deduction-board'
import { DEFAULT_CHAT_DEDUCTION_SOUND } from './chat-deduction-sound'
import { answerQuestion, endGame, reserveQuestion, startGame } from './chat-deduction-store'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeStore } from './fake-store'

const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const LATER = NOW + 10 * 60 * 1000

/** テスト用の問題集の一覧（括りのない「いろいろ」に富士山、括りが「古代史」の問題集に卑弥呼） */
const problems: readonly ChatDeductionProblemSet[] = [
  { id: 'misc', name: 'いろいろ', problems: [{ id: 'mount-fuji', category: 'place', answer: '富士山', aliases: ['富士山'], facts: ['日本でいちばん高い山。'], explanation: '静岡県と山梨県にまたがる日本一の山。', wikipedia: '富士山' }] },
  {
    id: 'ancient-people',
    name: '古代史の人物',
    topic: '古代史',
    problems: [{ id: 'himiko', category: 'person', answer: '卑弥呼', aliases: ['卑弥呼'], facts: ['3世紀前半の倭の女王。'], explanation: '3世紀前半の倭の女王。', wikipedia: '卑弥呼' }],
  },
]

/** 富士山の記事の代表画像 */
const fujiImage: ChatDeductionImage = { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Mt.Fuji.jpg/1280px-Mt.Fuji.jpg', artist: '山田花子', license: 'CC0' }

/** テスト用の画像（富士山は画像あり、卑弥呼は出せる画像なし） */
const images: ReadonlyMap<string, ChatDeductionImage | null> = new Map([
  ['mount-fuji', fujiImage],
  ['himiko', null],
])

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
    expect(await readChatDeductionBoard(createFakeDatabase(), createStore(), problems, images)).toEqual({ game: null, cards: [], sound: DEFAULT_CHAT_DEDUCTION_SOUND })
  })

  it('開催中のゲームは、区分とカードを載せ、正解の表記と解説は載せない（答えを漏らさない）', async () => {
    const { db, game } = await startGameWithOneAnswer()

    expect(await readChatDeductionBoard(db, createStore(), problems, images)).toEqual({
      game: { id: game.id, category: 'place', topic: null, startedAt: '2026-10-15T12:00:00.000Z', closesAt: null, endedAt: null, endReason: null, answer: null, explanation: null, image: null },
      cards: [card],
      sound: DEFAULT_CHAT_DEDUCTION_SOUND,
    })
  })

  it('終えたゲームは、正解の表記と解説と画像も載せる（「正解は富士山でした」と解説を出すため）', async () => {
    const { db, game } = await startGameWithOneAnswer()
    await endGame(db, game.id, 'stopped', LATER)

    expect(await readChatDeductionBoard(db, createStore(), problems, images)).toEqual({
      game: { id: game.id, category: 'place', topic: null, startedAt: '2026-10-15T12:00:00.000Z', closesAt: null, endedAt: '2026-10-15T12:10:00.000Z', endReason: 'stopped', answer: '富士山', explanation: '静岡県と山梨県にまたがる日本一の山。', image: fujiImage },
      cards: [card],
      sound: DEFAULT_CHAT_DEDUCTION_SOUND,
    })
  })

  it('括りを持つ問題集の問題なら、括りも載せる（お題を「古代史の人物」と出すため）', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'himiko', NOW)

    expect((await readChatDeductionBoard(db, createStore(), problems, images)).game).toEqual({
      id: game!.id,
      category: 'person',
      topic: '古代史',
      startedAt: '2026-10-15T12:00:00.000Z',
      closesAt: null,
      endedAt: null,
      endReason: null,
      answer: null,
      explanation: null,
      image: null,
    })
  })

  it('制限時間のあるゲームなら、締め切りの時刻を載せる（合成ページが残り時間を出すため）', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW, null, LATER)

    const board = await readChatDeductionBoard(db, createStore(), problems, images)

    expect(board.game?.closesAt).toBe('2026-10-15T12:10:00.000Z')
  })

  it('終えたゲームの問題に出せる画像が無ければ、画像は null にする', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'himiko', NOW)
    await endGame(db, game!.id, 'stopped', LATER)

    expect((await readChatDeductionBoard(db, createStore(), problems, images)).game?.image).toBeNull()
  })

  it('最後のゲームの問題が画像の表に無ければ、黙って画像なしにせず投げる（images.json の作り直し忘れ）', async () => {
    const { db } = await startGameWithOneAnswer()

    await expect(readChatDeductionBoard(db, createStore(), problems, new Map())).rejects.toThrow('images.json')
  })

  it('最後のゲームの問題が問題集に無ければ、黙って空にせず投げる', async () => {
    const { db } = await startGameWithOneAnswer()

    await expect(readChatDeductionBoard(db, createStore(), [], images)).rejects.toThrow('問題集にありません')
  })

  it('音を選んだ枠は、オーバーレイ用キーつきの音声のURLにして載せる', async () => {
    // 前提: 回答の音に media-pon を選んで保存してある
    const store = createStore()
    await store.put('chat-deduction-sound', JSON.stringify({ ...DEFAULT_CHAT_DEDUCTION_SOUND, slots: { ...DEFAULT_CHAT_DEDUCTION_SOUND.slots, answered: 'media-pon' } }))

    const board = await readChatDeductionBoard(createFakeDatabase(), store, problems, images)

    expect(board.sound.slots.answered).toBe(`/api/media/media-pon?key=${OVERLAY_KEY}`)
  })
})

describe('pushLatestChatDeductionBoard', () => {
  it('最後に始めたゲームのカードの一覧を組み立てて、配送先へ押し出す', async () => {
    const { db } = await startGameWithOneAnswer()
    const store = createStore()
    const delivery = createFakeAlertChannel()

    await pushLatestChatDeductionBoard(db, store, delivery.namespace, problems, images)

    expect(delivery.pushedChatDeductions).toEqual([await readChatDeductionBoard(db, store, problems, images)])
  })

  it('配送先が失敗を返したら、黙って成功にせず投げる', async () => {
    const { db } = await startGameWithOneAnswer()

    await expect(pushLatestChatDeductionBoard(db, createStore(), createFakeAlertChannel({ shouldFail: true }).namespace, problems, images)).rejects.toThrow('チャットで推理')
  })
})
