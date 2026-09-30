// @vitest-environment jsdom
/**
 * BGMのページのテスト
 *
 * 確かめること:
 * - 保存済みの曲を並べ、いま流している曲が分かること
 * - 曲を流す・止める・音量を変えると、すぐに Worker へ送ること（配信中に切り替えるため）
 * - 上げた音声から曲を足し、情報を書いて保存できること
 * - Workerが返した問題点を、画面に見えている名前で並べること（検証はWorkerだけが持つ）
 * - 読み込めなかったときは、黙って空の一覧に倒さず理由を出すこと
 * - Jev に話題に合う曲へ切り替えさせるかを、その場で入れたり切ったりできること（既定はオフ。issue #153）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { MediaItem } from '@/admin/api'
import { ApiError } from '@/core/api'
import type { BgmApi, BgmPlayback, BgmSettings, BgmTrack } from './api'
import { BgmPage } from './bgm-page'

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

/** 上げてある素材。曲にしている2つの音声のほかに、まだ曲にしていない音声と画像がある */
const uploadedMaterial: MediaItem[] = [
  { id: 'media-zatsudan', name: 'hidamari.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
  { id: 'media-moriagari', name: 'zenryoku.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
  { id: 'media-yuugure', name: '夕暮れの帰り道.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
  { id: 'media-gazou', name: 'kanpai.png', kind: 'image', contentType: 'image/png', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
]

/** 読み書きを記録する、BGMのAPI */
const bgmApi = (
  tracks: BgmTrack[] = [chatTrack, hypeTrack],
  playback: BgmPlayback = { mediaId: chatTrack.mediaId, volume: 0.3 },
): BgmApi & { savedTracks: BgmTrack[][]; sentPlayback: BgmPlayback[]; savedSettings: BgmSettings[] } => {
  const savedTracks: BgmTrack[][] = []
  const sentPlayback: BgmPlayback[] = []
  const savedSettings: BgmSettings[] = []
  return {
    savedTracks,
    sentPlayback,
    savedSettings,
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

const renderPage = (api: BgmApi = bgmApi()) => render(<BgmPage api={api} mediaApi={mediaApi} />)

/** 曲の一覧が出るまで待つ */
const waitForLoad = () => screen.findByRole('list', { name: '曲の一覧' })

/** 曲の行を、曲名で探す */
const trackRow = (title: string) => within(screen.getByRole('listitem', { name: title }))

/**
 * スライダーの入力要素を名前で探す。
 * Base UI の Slider は、つまみの位置を測り終えるまでつまみを隠す。jsdom は位置を測れず隠れたままなので、
 * 名前は外側の枠（role="group"）で確かめ、その中の入力要素を隠れた要素も含めて探す（trigger-page.test.tsx と同じ）
 */
const volumeSlider = () => within(screen.getByRole('group', { name: '音量' })).getByRole('slider', { hidden: true })

describe('BGMのページ', () => {
  test('保存済みの曲を並べ、いま流している曲を示す', async () => {
    renderPage()
    await waitForLoad()

    expect(trackRow('ひだまりの午後').getByText('流しています')).toBeInTheDocument()
    expect(trackRow('全力疾走').queryByText('流しています')).not.toBeInTheDocument()
    expect(screen.getByText(/「ひだまりの午後」を流しています/)).toBeInTheDocument()
  })

  test('曲の「流す」を押すと、その曲を流すよう Worker へ送る', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    await userEvent.click(trackRow('全力疾走').getByRole('button', { name: '「全力疾走」を流す' }))

    await waitFor(() => expect(api.sentPlayback).toEqual([{ mediaId: hypeTrack.mediaId, volume: 0.3 }]))
    expect(await screen.findByText(/「全力疾走」を流しています/)).toBeInTheDocument()
  })

  test('「止める」を押すと、止めるよう Worker へ送る', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    await userEvent.click(screen.getByRole('button', { name: '止める' }))

    await waitFor(() => expect(api.sentPlayback).toEqual([{ mediaId: null, volume: 0.3 }]))
    expect(await screen.findByText('BGMを止めています')).toBeInTheDocument()
  })

  test('何も流していなければ「止める」は押せない', async () => {
    renderPage(bgmApi([chatTrack], { mediaId: null, volume: 0.3 }))
    await waitForLoad()

    expect(screen.getByRole('button', { name: '止める' })).toBeDisabled()
  })

  test('音量を動かすと、流している曲のまま音量を Worker へ送る', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    fireEvent.change(volumeSlider(), { target: { value: '45' } })

    await waitFor(() => expect(api.sentPlayback.at(-1)).toEqual({ mediaId: chatTrack.mediaId, volume: 0.45 }))
  })

  test('上げた音声から曲を足し、クレジットを書いて保存できる', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    // まだ曲にしていない音声だけが候補に並ぶ
    const audioToAdd = screen.getByRole('combobox', { name: '足す音声' })
    expect(within(audioToAdd).getAllByRole('option').map((option) => option.textContent)).toEqual(['夕暮れの帰り道.mp3'])
    await userEvent.click(screen.getByRole('button', { name: '曲を足す' }))

    // 曲名はファイル名から下書きされる。クレジットは書いてもらう
    const addedTrack = trackRow('夕暮れの帰り道')
    await userEvent.type(addedTrack.getByLabelText('クレジット表記'), '音楽: 魔王魂')
    await userEvent.click(screen.getByRole('button', { name: '曲の一覧を保存' }))

    await waitFor(() => expect(api.savedTracks).toHaveLength(1))
    expect(api.savedTracks[0]?.at(-1)).toEqual({ mediaId: 'media-yuugure', title: '夕暮れの帰り道', credit: '音楽: 魔王魂', creditUrl: '', mood: '', scene: '' })
  })

  test('まだ保存していない曲は流せない（Worker の一覧に無いため）', async () => {
    renderPage()
    await waitForLoad()

    await userEvent.click(screen.getByRole('button', { name: '曲を足す' }))

    expect(trackRow('夕暮れの帰り道').getByRole('button', { name: '「夕暮れの帰り道」を流す' })).toBeDisabled()
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

  test('話題に合う曲へ Jev に切り替えさせるかを、その場で保存する（既定はオフ）', async () => {
    const api = bgmApi()
    renderPage(api)
    await waitForLoad()

    const autoSwitch = screen.getByRole('checkbox', { name: '配信の話題に合う曲へ自動で切り替える（Jev）' })
    expect(autoSwitch).not.toBeChecked()
    await userEvent.click(autoSwitch)

    await waitFor(() => expect(api.savedSettings).toEqual([{ judgeWithJev: true }]))
    expect(autoSwitch).toBeChecked()
  })

  test('読み込めなければ、空の一覧を出さずに理由を出す', async () => {
    const api: BgmApi = { ...bgmApi(), load: () => Promise.reject(new Error('通信が切れました')) }
    renderPage(api)

    expect(await screen.findByText(/通信が切れました/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '曲の一覧' })).not.toBeInTheDocument()
  })
})
