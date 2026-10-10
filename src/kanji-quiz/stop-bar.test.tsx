// @vitest-environment jsdom
/**
 * 下部バーの「配信の停止の取り消し」（stop-bar.tsx）のテスト（issue #302）
 *
 * 確かめること:
 * - ふだんは何も出さず、漢字クイズの時間切れで猶予が届いたら、残り秒数つきの取り消しボタンを出すこと
 * - 押すと Worker に取り消してもらい、ボタンを消すこと。断られたら理由を出すこと（Fail-Fast）
 * - 別の窓で取り消された（取り消しの知らせが届いた）・猶予が尽きたら、ボタンを消すこと
 * - 試し再生の猶予は、試し再生と分かるようにすること
 * - 押し出しを受け取れていないときは、理由を出すこと（取り消せないことに気づけるように）
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import { ApiError } from '@/core/api'
import { KanjiQuizStopBar, type KanjiQuizStopWatchHandlers } from './stop-bar'

afterEach(cleanup)

const overlayKey = 'overlay-key_0123456789abcdefghij'

/** 押し出しの接続の代役。受け取り口を覚えておき、テストから知らせを届ける */
const createDeps = ({ failCancel = null as ApiError | null } = {}) => {
  let handlers: KanjiQuizStopWatchHandlers | null = null
  const connectedKeys: string[] = []
  let cancels = 0
  return {
    deps: {
      connect: (key: string, received: KanjiQuizStopWatchHandlers) => {
        connectedKeys.push(key)
        handlers = received
        return { close: () => undefined }
      },
      cancel: async () => {
        cancels += 1
        if (failCancel !== null) throw failCancel
        return ['quiz-keidai']
      },
    },
    connectedKeys,
    cancels: () => cancels,
    /** Worker から押し出されたものを届ける */
    deliver: (message: unknown) => act(() => handlers?.onMessage(JSON.stringify(message))),
    status: (status: 'disconnected' | 'reconnected') => act(() => handlers?.onStatus(status)),
  }
}

const cancelButton = () => screen.queryByRole('button', { name: /配信の停止を取り消す/ })

describe('KanjiQuizStopBar', () => {
  test('ふだんは何も出さず、出題や正解者の知らせでも出さない', () => {
    const { deps, deliver, connectedKeys } = createDeps()
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)

    deliver({ type: 'answer', quizId: 'quiz-keidai', userName: '山田花子' })

    expect(connectedKeys).toEqual([overlayKey])
    expect(cancelButton()).not.toBeInTheDocument()
  })

  test('猶予が届いたら、残り秒数つきの取り消しボタンを出す', () => {
    const { deps, deliver } = createDeps()
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)

    deliver({ type: 'stopping', quizId: 'quiz-keidai', graceMs: 10_000, rehearsal: false })

    expect(cancelButton()).toHaveTextContent(/残り\s*10秒/)
  })

  test('押すと Worker に取り消してもらい、ボタンを消す', async () => {
    const { deps, deliver, cancels } = createDeps()
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)
    deliver({ type: 'stopping', quizId: 'quiz-keidai', graceMs: 10_000, rehearsal: false })

    await userEvent.click(cancelButton() as HTMLElement)

    expect(cancels()).toBe(1)
    expect(cancelButton()).not.toBeInTheDocument()
  })

  test('取り消しを断られたら、理由を出す', async () => {
    const { deps, deliver } = createDeps({ failCancel: new ApiError(409, 'kanji-quiz-stop-not-pending', '取り消せる配信の停止がありません', []) })
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)
    deliver({ type: 'stopping', quizId: 'quiz-keidai', graceMs: 10_000, rehearsal: false })

    await userEvent.click(cancelButton() as HTMLElement)

    expect(screen.getByRole('alert')).toHaveTextContent('取り消せる配信の停止がありません')
  })

  test('取り消しの知らせが届いたら（別の窓で取り消した）、ボタンを消す', () => {
    const { deps, deliver } = createDeps()
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)
    deliver({ type: 'stopping', quizId: 'quiz-keidai', graceMs: 10_000, rehearsal: false })

    deliver({ type: 'stopCancelled', quizId: 'quiz-keidai' })

    expect(cancelButton()).not.toBeInTheDocument()
  })

  test('猶予が尽きたら、ボタンを消す', async () => {
    const { deps, deliver } = createDeps()
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)

    deliver({ type: 'stopping', quizId: 'quiz-keidai', graceMs: 50, rehearsal: false })

    await waitFor(() => expect(cancelButton()).not.toBeInTheDocument())
  })

  test('猶予が重なったら、先に尽きるほうの残り秒数を出し、本番が1つでもあれば試し再生とは出さない', () => {
    const { deps, deliver } = createDeps()
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)

    deliver({ type: 'stopping', quizId: 'quiz-keidai', graceMs: 5_000, rehearsal: false })
    deliver({ type: 'stopping', quizId: 'quiz-naya', graceMs: 10_000, rehearsal: true })

    expect(cancelButton()).toHaveTextContent(/残り\s*5秒/)
    expect(cancelButton()).not.toHaveTextContent('試し再生')
  })

  test('猶予が重なったとき、先に尽きた猶予だけを外し、残った本番の取り消しボタンは出し続ける', async () => {
    const { deps, deliver } = createDeps()
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)

    // 試し再生の猶予がすぐ尽き、本番の猶予が残る
    deliver({ type: 'stopping', quizId: 'quiz-demo', graceMs: 50, rehearsal: true })
    deliver({ type: 'stopping', quizId: 'quiz-keidai', graceMs: 10_000, rehearsal: false })

    await waitFor(() => expect(cancelButton()).toHaveTextContent(/残り\s*(10|9)秒/))
    expect(cancelButton()).not.toHaveTextContent('試し再生')
  })

  test('試し再生の猶予は、試し再生と分かるようにする', () => {
    const { deps, deliver } = createDeps()
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)

    deliver({ type: 'stopping', quizId: 'quiz-keidai', graceMs: 10_000, rehearsal: true })

    expect(cancelButton()).toHaveTextContent('試し再生')
  })

  test('押し出しが切れたら理由を出し、つなぎ直したら消す', () => {
    const { deps, status } = createDeps()
    render(<KanjiQuizStopBar overlayKey={overlayKey} deps={deps} />)

    status('disconnected')
    expect(screen.getByRole('alert')).toHaveTextContent('漢字クイズ')

    status('reconnected')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('オーバーレイ用キーが無ければつながない', () => {
    const { deps, connectedKeys } = createDeps()
    render(<KanjiQuizStopBar overlayKey={null} deps={deps} />)

    expect(connectedKeys).toEqual([])
  })
})
