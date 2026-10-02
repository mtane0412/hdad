// @vitest-environment jsdom
/**
 * BGMのページのテスト
 *
 * 確かめること:
 * - 保存済みの曲を表（曲の一覧）に並べ、いま流している曲が分かること
 * - プレーヤーで再生・停止・次の曲・前の曲・リピート・シャッフル・音量を操作すると、すぐに Worker へ送ること（配信中に切り替えるため）
 * - 押し出された「いま流している曲」（曲の終わりで進んだ・Jev が切り替えた）をプレーヤーと表に映すこと
 * - 上げた音声から曲を追加し、表の中で情報を書いて保存できること
 * - Workerが返した問題点を、画面に見えている名前で並べること（検証はWorkerだけが持つ）
 * - 読み込めなかったときは、黙って空の一覧に倒さず理由を出すこと
 * - Jev に話題に合う曲へ切り替えさせるかを、その場で入れたり切ったりできること（既定はオフ。issue #153）
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { MediaItem } from '@/admin/api'
import { ApiError } from '@/core/api'
import type { BgmApi, BgmNowPlaying, BgmPlayback, BgmSettings, BgmStep, BgmTrack } from './api'
import { BgmPage, type BgmWatchHandlers } from './bgm-page'

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

/** 上げてある素材。曲にしている2つの音声のほかに、まだ曲にしていない音声と画像がある */
const uploadedMaterial: MediaItem[] = [
  { id: 'media-zatsudan', name: 'hidamari.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
  { id: 'media-moriagari', name: 'zenryoku.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
  { id: 'media-yuugure', name: '夕暮れの帰り道.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
  { id: 'media-gazou', name: 'kanpai.png', kind: 'image', contentType: 'image/png', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
]

/** 読み書きを記録する、BGMのAPI。次の曲・前の曲へ進めると、Worker の代わりに全力疾走を流したことにする */
const bgmApi = (
  tracks: BgmTrack[] = [chatTrack, hypeTrack],
  playback: BgmPlayback = playingChat,
): BgmApi & { savedTracks: BgmTrack[][]; sentPlayback: BgmPlayback[]; savedSettings: BgmSettings[]; skipped: BgmStep[] } => {
  const savedTracks: BgmTrack[][] = []
  const sentPlayback: BgmPlayback[] = []
  const savedSettings: BgmSettings[] = []
  const skipped: BgmStep[] = []
  return {
    savedTracks,
    sentPlayback,
    savedSettings,
    skipped,
    skip: (step) => {
      skipped.push(step)
      return Promise.resolve({ ...playback, mediaId: hypeTrack.mediaId })
    },
    load: () => Promise.resolve({ tracks, playback, settings: { judgeWithJev: false } }),
    saveSettings: (next) => {
      savedSettings.push(next)
      return Promise.resolve(next)
    },
    saveTracks: (next) => {
      savedTracks.push([...next])
      return Promise.resolve([...next])
    },
    savePlayback: (next) => {
      sentPlayback.push(next)
      return Promise.resolve(next)
    },
  }
}

const mediaApi = { media: () => Promise.resolve(uploadedMaterial) }

/** 押し出しの接続の代役。ページが渡した受け口を覚えておき、テストから押し出しを届ける */
const fakeConnection = () => {
  let handlers: BgmWatchHandlers | null = null
  const connect = (_overlayKey: string, next: BgmWatchHandlers) => {
    handlers = next
    return { close: () => undefined }
  }
  const getHandlers = (): BgmWatchHandlers => {
    if (handlers === null) throw new Error('ページがまだ押し出しの接続をつないでいません')
    return handlers
  }
  return {
    connect,
    /** Worker から「いま流している曲」が押し出されてきた */
    push: (nowPlaying: BgmNowPlaying) => act(() => getHandlers().onMessage(JSON.stringify(nowPlaying))),
    /** 切れていた接続がつながり直した */
    reconnect: () => act(() => getHandlers().onStatus('reconnected')),
  }
}

const renderPage = (api: BgmApi = bgmApi(), connection = fakeConnection()) => {
  render(<BgmPage api={api} mediaApi={mediaApi} overlayKey="overlay-key" connect={connection.connect} />)
  return connection
}

/** 曲の表が出るまで待つ */
const waitForLoad = () => screen.findByRole('table', { name: '曲の一覧' })

/** 曲の行を、曲名で探す */
const trackRow = (title: string) => within(screen.getByRole('row', { name: title }))

/** プレーヤー */
const player = () => within(screen.getByRole('region', { name: 'プレーヤー' }))

/**
 * スライダーの入力要素を名前で探す。
 * Base UI の Slider は、つまみの位置を測り終えるまでつまみを隠す。jsdom は位置を測れず隠れたままなので、
 * 名前は外側の枠（role="group"）で確かめ、その中の入力要素を隠れた要素も含めて探す（trigger-page.test.tsx と同じ）
 */
const volumeSlider = () => within(screen.getByRole('group', { name: '音量' })).getByRole('slider', { hidden: true })

describe('BGMのページ', () => {
  test('保存済みの曲を表に並べ、いま流している曲をプレーヤーと表の両方に示す', async () => {
    renderPage()
    await waitForLoad()

    expect(trackRow('ひだまりの午後').getByText('流しています')).toBeInTheDocument()
    expect(trackRow('全力疾走').queryByText('流しています')).not.toBeInTheDocument()
    expect(player().getByText('ひだまりの午後')).toBeInTheDocument()
    expect(player().getByText('音楽: 甘茶の音楽工房')).toBeInTheDocument()
  })

  test('表の「流す」を押すと、その曲を流すよう Worker へ送る', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    await userEvent.click(trackRow('全力疾走').getByRole('button', { name: '「全力疾走」を流す' }))

    await waitFor(() => expect(api.sentPlayback).toEqual([{ ...playingChat, mediaId: hypeTrack.mediaId }]))
    expect(await player().findByText('全力疾走')).toBeInTheDocument()
  })

  test('プレーヤーの「停止」を押すと、止めるよう Worker へ送る', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    await userEvent.click(player().getByRole('button', { name: '停止' }))

    await waitFor(() => expect(api.sentPlayback).toEqual([{ ...playingChat, mediaId: null }]))
    expect(await player().findByText('BGMを止めています')).toBeInTheDocument()
  })

  test('止めているときは「再生」を押すと、次の曲から流してもらう（どの曲にするかは Worker が決める）', async () => {
    const api = bgmApi([chatTrack, hypeTrack], { ...playingChat, mediaId: null })
    renderPage(api)
    await waitForLoad()

    await userEvent.click(player().getByRole('button', { name: '再生' }))

    await waitFor(() => expect(api.skipped).toEqual(['next']))
    expect(await player().findByText('全力疾走')).toBeInTheDocument()
  })

  test('「次の曲」「前の曲」を押すと、その向きへ進めてもらう', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    await userEvent.click(player().getByRole('button', { name: '次の曲' }))
    await waitFor(() => expect(api.skipped).toEqual(['next']))
    await userEvent.click(player().getByRole('button', { name: '前の曲' }))

    await waitFor(() => expect(api.skipped).toEqual(['next', 'previous']))
  })

  test('曲がまだ1つも無ければ、再生も次の曲・前の曲も押せない', async () => {
    renderPage(bgmApi([], { ...playingChat, mediaId: null }))
    await screen.findByText('曲はまだありません。')

    expect(player().getByRole('button', { name: '再生' })).toBeDisabled()
    expect(player().getByRole('button', { name: '次の曲' })).toBeDisabled()
    expect(player().getByRole('button', { name: '前の曲' })).toBeDisabled()
  })

  test('「リピート」を押すと、流している曲を繰り返すよう Worker へ送る', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    const repeat = player().getByRole('button', { name: 'リピート' })
    expect(repeat).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(repeat)

    await waitFor(() => expect(api.sentPlayback).toEqual([{ ...playingChat, repeat: true }]))
    expect(repeat).toHaveAttribute('aria-pressed', 'true')
  })

  test('「シャッフル」を押すと、次の曲をでたらめに選ぶよう Worker へ送る', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    const shuffle = player().getByRole('button', { name: 'シャッフル' })
    expect(shuffle).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(shuffle)

    await waitFor(() => expect(api.sentPlayback).toEqual([{ ...playingChat, shuffle: true }]))
    expect(shuffle).toHaveAttribute('aria-pressed', 'true')
  })

  test('音量を動かすと、流している曲のまま音量を Worker へ送る', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    fireEvent.change(volumeSlider(), { target: { value: '45' } })

    await waitFor(() => expect(api.sentPlayback.at(-1)).toEqual({ ...playingChat, volume: 0.45 }))
  })

  test('曲の終わりで次の曲へ進んだ（押し出された）ら、プレーヤーと表をその曲に合わせる', async () => {
    const connection = renderPage()
    await waitForLoad()

    connection.push({
      track: { mediaId: hypeTrack.mediaId, title: hypeTrack.title, credit: hypeTrack.credit, creditUrl: hypeTrack.creditUrl, url: '/api/media/media-moriagari?key=k' },
      volume: 0.5,
      repeat: true,
      shuffle: false,
    })

    expect(await player().findByText('全力疾走')).toBeInTheDocument()
    expect(trackRow('全力疾走').getByText('流しています')).toBeInTheDocument()
    expect(player().getByRole('button', { name: 'リピート' })).toHaveAttribute('aria-pressed', 'true')
    expect(player().getByRole('status', { name: '音量' })).toHaveTextContent('50%')
  })

  test('つなぎ直したら読み直し、切れているあいだに別の画面で足された曲を流していても、プレーヤーにその曲を出す', async () => {
    // 開いたときは2曲。切れているあいだに別の画面で「夕暮れの帰り道」が足され、それに切り替わった
    const eveningTrack: BgmTrack = { ...chatTrack, mediaId: 'media-yuugure', title: '夕暮れの帰り道', credit: '音楽: 魔王魂' }
    const api = bgmApi()
    let loads = 0
    const reloadingApi: BgmApi = {
      ...api,
      load: () => {
        loads += 1
        return loads === 1
          ? api.load()
          : Promise.resolve({ tracks: [chatTrack, hypeTrack, eveningTrack], playback: { ...playingChat, mediaId: eveningTrack.mediaId }, settings: { judgeWithJev: false } })
      },
    }
    const connection = renderPage(reloadingApi)
    await waitForLoad()

    await connection.reconnect()

    expect(await player().findByText('夕暮れの帰り道')).toBeInTheDocument()
  })

  test('上げた音声から曲を追加し、クレジットを書いて保存できる', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    // まだ曲にしていない音声だけが候補に並ぶ
    const audioToAdd = screen.getByRole('combobox', { name: '追加する音声' })
    expect(within(audioToAdd).getAllByRole('option').map((option) => option.textContent)).toEqual(['夕暮れの帰り道.mp3'])
    await userEvent.click(screen.getByRole('button', { name: '曲を追加する' }))

    // 曲名はファイル名から下書きされる。クレジットは書いてもらう
    const addedTrack = trackRow('夕暮れの帰り道')
    await userEvent.type(addedTrack.getByRole('textbox', { name: 'クレジット表記' }), '音楽: 魔王魂')
    await userEvent.click(screen.getByRole('button', { name: '曲の一覧を保存' }))

    await waitFor(() => expect(api.savedTracks).toHaveLength(1))
    expect(api.savedTracks[0]?.at(-1)).toEqual({ mediaId: 'media-yuugure', title: '夕暮れの帰り道', credit: '音楽: 魔王魂', creditUrl: '', mood: '', scene: '' })
  })

  test('まだ保存していない曲は流せない（Worker の一覧に無いため）', async () => {
    renderPage()
    await waitForLoad()

    await userEvent.click(screen.getByRole('button', { name: '曲を追加する' }))

    expect(trackRow('夕暮れの帰り道').getByRole('button', { name: '「夕暮れの帰り道」を流す' })).toBeDisabled()
  })

  test('曲の追加はアイコンだけのボタンにし、名前は読み上げとホバー（title）に残す', async () => {
    renderPage()
    await waitForLoad()

    const addButton = screen.getByRole('button', { name: '曲を追加する' })
    expect(addButton).toHaveTextContent('')
    expect(addButton).toHaveAttribute('title', '曲を追加する')
  })

  test('曲を外して保存できる。流している曲は外せない', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    expect(trackRow('ひだまりの午後').getByRole('button', { name: '「ひだまりの午後」を外す' })).toBeDisabled()
    await userEvent.click(trackRow('全力疾走').getByRole('button', { name: '「全力疾走」を外す' }))
    await userEvent.click(screen.getByRole('button', { name: '曲の一覧を保存' }))

    await waitFor(() => expect(api.savedTracks).toEqual([[chatTrack]]))
  })

  test('Worker が返した問題点を、画面に見えている名前で並べる', async () => {
    const api: BgmApi = {
      ...bgmApi(),
      saveTracks: () => Promise.reject(new ApiError(400, 'invalid-config', 'BGMの曲に問題があります', ['tracks[1].credit: 1〜200文字で指定してください'])),
    }
    renderPage(api)
    await waitForLoad()

    await userEvent.click(screen.getByRole('button', { name: '曲の一覧を保存' }))

    expect(await screen.findByText(/2曲目のクレジット表記: 1〜200文字で指定してください/)).toBeInTheDocument()
  })

  test('プレーヤーの Jev のボタンで、話題に合う曲へ自動で切り替えさせるかをその場で保存する（既定はオフ）', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    const autoSwitch = player().getByRole('button', { name: '配信の話題に合う曲へ自動で切り替える（Jev）' })
    expect(autoSwitch).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(autoSwitch)

    await waitFor(() => expect(api.savedSettings).toEqual([{ judgeWithJev: true }]))
    expect(autoSwitch).toHaveAttribute('aria-pressed', 'true')
  })

  test('読み込めなければ、空の一覧を出さずに理由を出す', async () => {
    const api: BgmApi = { ...bgmApi(), load: () => Promise.reject(new Error('通信が切れました')) }
    renderPage(api)

    expect(await screen.findByText(/通信が切れました/)).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: '曲の一覧' })).not.toBeInTheDocument()
  })
})
