// @vitest-environment jsdom
/**
 * 下部バーのBGMのプレーヤーのテスト（issue #236）
 *
 * 確かめること:
 * - いま流している曲の名前を出し、押すと BGM のページ（/bgm/）へ移れること
 * - 再生・停止・次の曲・前の曲・音量を、すぐに Worker へ送ること
 * - 押し出された「いま流している曲」（曲の終わりで進んだ・Jev が切り替えた）をバーに映すこと
 * - リピート・シャッフル・Jev の自動切り替えは出さないこと（BGM のページだけに置く）
 * - 読めない・押し出しを受け取れていない・操作に失敗したときは、黙らずにバーに理由を出すこと（Fail-Fast）
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { BgmApi, BgmNowPlaying, BgmPlayback, BgmStep, BgmTrack } from './api'
import { BgmBar } from './bgm-bar'
import { BgmPlayerProvider, type BgmWatchHandlers } from './player-context'

afterEach(cleanup)

/** 雑談のときに流したい、落ち着いた曲 */
const chatTrack: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

/** ゲームで盛り上がったときに流したい曲 */
const hypeTrack: BgmTrack = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  mood: 'テンポの速いロック',
  scene: 'ボス戦・盛り上がったとき',
}

/** 雑談の曲を、リピートもシャッフルも切って流している */
const playingChat: BgmPlayback = { mediaId: chatTrack.mediaId, volume: 0.3, repeat: false, shuffle: false }

/** 送ったものを記録する、BGMのAPI。次の曲・前の曲へ進めると、Worker の代わりに全力疾走を流したことにする */
const bgmApi = (playback: BgmPlayback = playingChat): BgmApi & { sentPlayback: BgmPlayback[]; skipped: BgmStep[] } => {
  const sentPlayback: BgmPlayback[] = []
  const skipped: BgmStep[] = []
  return {
    sentPlayback,
    skipped,
    load: () => Promise.resolve({ tracks: [chatTrack, hypeTrack], playback, settings: { judgeWithJev: false } }),
    skip: (step) => {
      skipped.push(step)
      return Promise.resolve({ ...playback, mediaId: hypeTrack.mediaId })
    },
    savePlayback: (next) => {
      sentPlayback.push(next)
      return Promise.resolve(next)
    },
    saveTracks: (next) => Promise.resolve([...next]),
    saveSettings: (next) => Promise.resolve(next),
  }
}

/** 押し出しの接続の代役。渡された受け口を覚えておき、テストから押し出しや切断を届ける */
const fakeConnection = () => {
  let handlers: BgmWatchHandlers | null = null
  const getHandlers = (): BgmWatchHandlers => {
    if (handlers === null) throw new Error('まだ押し出しの接続をつないでいません')
    return handlers
  }
  return {
    connect: (_overlayKey: string, next: BgmWatchHandlers) => {
      handlers = next
      return { close: () => undefined }
    },
    push: (nowPlaying: BgmNowPlaying) => act(() => getHandlers().onMessage(JSON.stringify(nowPlaying))),
    disconnect: () => act(() => getHandlers().onStatus('disconnected')),
  }
}

const renderBar = (api: BgmApi = bgmApi(), connection = fakeConnection(), overlayKey: string | null = 'overlay-key') => {
  render(
    <BgmPlayerProvider api={api} overlayKey={overlayKey} connect={connection.connect}>
      <div role="region" aria-label="配信中の操作">
        <BgmBar />
      </div>
    </BgmPlayerProvider>,
  )
  return connection
}

const bar = () => within(screen.getByRole('region', { name: '配信中の操作' }))

describe('下部バーのBGMのプレーヤー', () => {
  test('いま流している曲の名前とクレジットを出し、曲名から BGM のページへ移れる', async () => {
    renderBar()

    expect(await bar().findByRole('link', { name: /ひだまりの午後/ })).toHaveAttribute('href', '/bgm/')
    expect(bar().getByText('音楽: 甘茶の音楽工房')).toBeInTheDocument()
  })

  test('止めているときは止めていると出し、「再生」を押すと次の曲から流してもらう', async () => {
    const api = bgmApi({ ...playingChat, mediaId: null })
    renderBar(api)

    expect(await bar().findByRole('link', { name: /BGMを止めています/ })).toHaveAttribute('href', '/bgm/')
    await userEvent.click(bar().getByRole('button', { name: '再生' }))

    await waitFor(() => expect(api.skipped).toEqual(['next']))
    expect(await bar().findByRole('link', { name: /全力疾走/ })).toBeInTheDocument()
  })

  test('「停止」を押すと、止めるよう Worker へ送る', async () => {
    const api = bgmApi()
    renderBar(api)

    await userEvent.click(await bar().findByRole('button', { name: '停止' }))

    await waitFor(() => expect(api.sentPlayback).toEqual([{ ...playingChat, mediaId: null }]))
    expect(await bar().findByRole('link', { name: /BGMを止めています/ })).toBeInTheDocument()
  })

  test('「次の曲」「前の曲」を押すと、その向きへ進めてもらう', async () => {
    const api = bgmApi()
    renderBar(api)

    await userEvent.click(await bar().findByRole('button', { name: '次の曲' }))
    await waitFor(() => expect(api.skipped).toEqual(['next']))
    await userEvent.click(bar().getByRole('button', { name: '前の曲' }))

    await waitFor(() => expect(api.skipped).toEqual(['next', 'previous']))
  })

  test('音量を動かすと、流している曲のまま音量を Worker へ送る', async () => {
    const api = bgmApi()
    renderBar(api)
    await bar().findByRole('link', { name: /ひだまりの午後/ })

    // jsdom では Slider のつまみが隠れたままなので、外枠の名前から中の入力欄を探す
    const slider = within(bar().getByRole('group', { name: '音量' })).getByRole('slider', { hidden: true })
    fireEvent.change(slider, { target: { value: '45' } })

    await waitFor(() => expect(api.sentPlayback.at(-1)).toEqual({ ...playingChat, volume: 0.45 }))
  })

  test('リピート・シャッフル・Jev の自動切り替えはバーに出さない（BGM のページだけに置く）', async () => {
    renderBar()
    await bar().findByRole('link', { name: /ひだまりの午後/ })

    for (const name of ['リピート', 'シャッフル', '配信の話題に合う曲へ自動で切り替える（Jev）']) {
      expect(bar().queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  test('曲の終わりで次の曲へ進んだ（押し出された）ら、バーの曲名をその曲に合わせる', async () => {
    const connection = renderBar()
    await bar().findByRole('link', { name: /ひだまりの午後/ })

    await connection.push({
      track: { mediaId: hypeTrack.mediaId, title: hypeTrack.title, credit: hypeTrack.credit, creditUrl: hypeTrack.creditUrl, url: '/api/media/media-moriagari?key=k' },
      volume: 0.5,
      repeat: false,
      shuffle: false,
    })

    expect(bar().getByRole('link', { name: /全力疾走/ })).toBeInTheDocument()
    expect(bar().getByRole('status', { name: '音量' })).toHaveTextContent('50%')
  })

  test('押し出しが切れたら、切り替えを受け取れていないとバーに出す', async () => {
    const connection = renderBar()
    await bar().findByRole('link', { name: /ひだまりの午後/ })

    await connection.disconnect()

    expect(bar().getByText(/BGMの切り替えを受け取れていません/)).toBeInTheDocument()
  })

  test('オーバーレイ用キーが未発行なら、切り替えを映せないとバーに出す', async () => {
    renderBar(bgmApi(), fakeConnection(), null)

    expect(await bar().findByText(/オーバーレイ用キーが未発行/)).toBeInTheDocument()
  })

  test('操作に失敗したら、理由をバーに出す', async () => {
    const api: BgmApi = { ...bgmApi(), skip: () => Promise.reject(new Error('Workerに届きませんでした')) }
    renderBar(api)

    await userEvent.click(await bar().findByRole('button', { name: '次の曲' }))

    expect(await bar().findByText(/Workerに届きませんでした/)).toBeInTheDocument()
  })

  test('BGMを読めなければ理由を出し、操作は押せなくする', async () => {
    const api: BgmApi = { ...bgmApi(), load: () => Promise.reject(new Error('通信が切れました')) }
    renderBar(api)

    expect(await bar().findByText(/通信が切れました/)).toBeInTheDocument()
    for (const name of ['前の曲', '再生', '次の曲']) {
      expect(bar().getByRole('button', { name })).toBeDisabled()
    }
  })
})
