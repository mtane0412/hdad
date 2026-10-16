/**
 * チャットで推理の Worker の呼び出し（api.ts）のテスト
 *
 * 実際の通信はせず、fetch を差し替える。アプリのページ（/chat-deduction/）が、報酬のIDと最後のゲームを読み、
 * 報酬を作り、ゲームを始め・終えられることを確かめる（issue #375）。
 * 合成ページの素材がオーバーレイ用キーでカードの一覧を読めることも確かめる（issue #378）。
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../core/api'
import { createChatDeductionApi, createChatDeductionOverlayApi, type ChatDeductionGame } from './api'

const rewards = { questionRewardId: '報酬ID-質問', answerRewardId: '報酬ID-解答' }
/** BGM と正解の音だけを選んだ設定（保存済みの形。枠ごとの値は素材のID） */
const sound = {
  slots: { bgm: 'media-thinking', start: null, answered: null, wrong: null, correct: 'media-pinpon', stopped: null },
  bgmVolume: 0.2,
  effectVolume: 0.6,
}
const game: ChatDeductionGame = { id: 1, problemId: 'mount-fuji', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null }

/** 呼ばれた内容を記録し、決めた応答を返す fetch */
const createFetchWithResponse = (status: number, body: unknown) => {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('createChatDeductionApi', () => {
  it('控えた報酬のIDと、最後に始めたゲームを読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, { rewards, game })

    expect(await createChatDeductionApi(fetchImpl).read()).toEqual({ rewards, game })
    expect(calls.map((call) => call.path)).toEqual(['/api/admin/chat-deduction'])
  })

  it('報酬を作っておらず、ゲームも始めていなければ、どちらも null として読む', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { rewards: null, game: null })

    expect(await createChatDeductionApi(fetchImpl).read()).toEqual({ rewards: null, game: null })
  })

  it('ゲームの形が違えば（終わり方が知らない値など）エラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { rewards, game: { ...game, endReason: 'timeout' } })

    await expect(createChatDeductionApi(fetchImpl).read()).rejects.toThrow()
  })

  it('報酬を作り、作った報酬のIDを返す', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(201, { rewards })

    expect(await createChatDeductionApi(fetchImpl).createRewards()).toEqual(rewards)
    expect(calls).toEqual([{ path: '/api/admin/chat-deduction/rewards', method: 'POST', body: null }])
  })

  it('問題を選んでゲームを始め、始めたゲームを返す', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(201, { game })

    expect(await createChatDeductionApi(fetchImpl).startGame('mount-fuji')).toEqual(game)
    expect(calls).toEqual([{ path: '/api/admin/chat-deduction/games', method: 'POST', body: { problemId: 'mount-fuji' } }])
  })

  it('ゲームを終え、終えたゲームを返す', async () => {
    const ended = { ...game, endedAt: '2026-10-15T12:10:00.000Z', endReason: 'stopped' }
    const { calls, fetchImpl } = createFetchWithResponse(200, { game: ended })

    expect(await createChatDeductionApi(fetchImpl).endGame(1)).toEqual(ended)
    expect(calls).toEqual([{ path: '/api/admin/chat-deduction/games/1/end', method: 'POST', body: null }])
  })

  it('保存済みの音の設定を読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, sound)

    expect(await createChatDeductionApi(fetchImpl).sound()).toEqual(sound)
    expect(calls.map((call) => call.path)).toEqual(['/api/admin/chat-deduction/sound'])
  })

  it('音の設定を PUT で保存し、Worker が保存したものを返す', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, sound)

    expect(await createChatDeductionApi(fetchImpl).saveSound(sound)).toEqual(sound)
    expect(calls).toEqual([{ path: '/api/admin/chat-deduction/sound', method: 'PUT', body: sound }])
  })

  it('Workerが失敗を返したら ApiError にする（報酬を切り替えられなかったなど）', async () => {
    const { fetchImpl } = createFetchWithResponse(502, { error: { code: 'chat-deduction-rewards-failed', message: '報酬を交換できるようにできなかったので、ゲームを始めませんでした' } })

    await expect(createChatDeductionApi(fetchImpl).startGame('mount-fuji')).rejects.toThrow(ApiError)
  })
})

describe('createChatDeductionOverlayApi', () => {
  const OVERLAY_KEY = 'overlay-key_0123456789abcdefghij'
  const board = {
    game: { id: 1, category: 'place', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null, answer: null },
    cards: [{ kind: 'question', id: 1, userName: '田中太郎', text: '日本にありますか？', verdict: 'yes', reply: '静岡県と山梨県にまたがっています。' }],
    sound: { ...sound, slots: { ...sound.slots, bgm: '/api/media/media-thinking?key=overlay-key', correct: '/api/media/media-pinpon?key=overlay-key' } },
  }

  it('オーバーレイ用キー付きの経路から、カードの一覧を読む', async () => {
    const { calls, fetchImpl } = createFetchWithResponse(200, board)

    expect(await createChatDeductionOverlayApi(fetchImpl, OVERLAY_KEY).read()).toEqual(board)
    expect(calls.map((call) => call.path)).toEqual([`/api/overlay/chat-deduction?key=${encodeURIComponent(OVERLAY_KEY)}`])
  })

  it('カードの形が違えばエラーにする', async () => {
    const { fetchImpl } = createFetchWithResponse(200, { ...board, cards: [{ kind: 'question', id: 1 }] })

    await expect(createChatDeductionOverlayApi(fetchImpl, OVERLAY_KEY).read()).rejects.toThrow('cards')
  })
})
