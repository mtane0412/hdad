/**
 * チャットで推理のゲームの読み書き（worker/chat-deduction-store.ts）のテスト
 *
 * 開催中のゲームは1つだけで、開始の確かめを1つの文で行うこと、終えたゲームは二度と終えられないこと、
 * 報酬をONにできなかったときに開始を取り消せることを、migrations/ を適用したメモリ上の SQLite で確かめる（issue #375）。
 */
import { describe, expect, it } from 'vitest'
import { cancelGame, endGame, readCurrentGame, readLatestGame, startGame } from './chat-deduction-store'
import { createFakeDatabase } from './fake-database'

const NOW = Date.parse('2026-10-15T12:00:00.000Z')
const LATER = NOW + 10 * 60 * 1000

describe('ゲームの開始（startGame）', () => {
  it('問題のIDと開始の時刻を持つ、開催中のゲームを作る', async () => {
    const db = createFakeDatabase()

    const game = await startGame(db, 'mount-fuji', NOW)

    expect(game).toEqual({ id: 1, problemId: 'mount-fuji', startedAt: '2026-10-15T12:00:00.000Z', endedAt: null, endReason: null })
    expect(await readCurrentGame(db)).toEqual(game)
  })

  it('ほかのゲームが開催中なら作らず null を返す（開催中のゲームは1つだけ）', async () => {
    const db = createFakeDatabase()
    await startGame(db, 'mount-fuji', NOW)

    expect(await startGame(db, 'natsume-soseki', LATER)).toBeNull()
    expect((await readCurrentGame(db))?.problemId).toBe('mount-fuji')
  })

  it('前のゲームを終えていれば、次のゲームを作れる', async () => {
    const db = createFakeDatabase()
    const first = await startGame(db, 'mount-fuji', NOW)
    await endGame(db, first!.id, 'stopped', LATER)

    expect((await startGame(db, 'natsume-soseki', LATER))?.problemId).toBe('natsume-soseki')
  })
})

describe('ゲームの終了（endGame）', () => {
  it('開催中のゲームを終わり方と時刻をつけて終え、開催中のゲームを無くす', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)

    const ended = await endGame(db, game!.id, 'stopped', LATER)

    expect(ended).toEqual({ ...game, endedAt: '2026-10-15T12:10:00.000Z', endReason: 'stopped' })
    expect(await readCurrentGame(db)).toBeNull()
    expect(await readLatestGame(db)).toEqual(ended)
  })

  it('もう終えたゲーム・無いゲームなら何も書かず null を返す', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)
    await endGame(db, game!.id, 'stopped', LATER)

    expect(await endGame(db, game!.id, 'stopped', LATER + 1000)).toBeNull()
    expect(await endGame(db, 999, 'stopped', LATER)).toBeNull()
    expect((await readLatestGame(db))?.endedAt).toBe('2026-10-15T12:10:00.000Z')
  })
})

describe('開始の取り消し（cancelGame）', () => {
  it('開催中のゲームの行を消し、何も始まらなかったことにする（報酬をONにできなかったとき）', async () => {
    const db = createFakeDatabase()
    const game = await startGame(db, 'mount-fuji', NOW)

    await cancelGame(db, game!.id)

    expect(await readCurrentGame(db)).toBeNull()
    expect(await readLatestGame(db)).toBeNull()
  })
})

describe('最後のゲームの読み取り（readLatestGame）', () => {
  it('一度もゲームを開いていなければ null を返す', async () => {
    expect(await readLatestGame(createFakeDatabase())).toBeNull()
  })
})
