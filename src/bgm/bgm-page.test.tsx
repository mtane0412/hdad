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
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test } from 'vitest'
import type { MediaItem } from '@/admin/api'
import { ApiError } from '@/core/api'
import type { BgmApi, BgmPlayback, BgmTrack } from './api'
import { BgmPage } from './bgm-page'

afterEach(cleanup)

/** 雑談のときに流したい、落ち着いた曲 */
const 雑談の曲: BgmTrack = {
  mediaId: 'media-zatsudan',
  title: 'ひだまりの午後',
  credit: '音楽: 甘茶の音楽工房',
  creditUrl: 'https://amachamusic.chagasi.com/',
  mood: 'ゆったりしたアコースティック',
  scene: '雑談・作業配信',
}

/** ゲームで盛り上がったときに流したい曲 */
const 盛り上がる曲: BgmTrack = {
  mediaId: 'media-moriagari',
  title: '全力疾走',
  credit: '音楽: DOVA-SYNDROME',
  creditUrl: 'https://dova-s.jp/',
  mood: 'テンポの速いロック',
  scene: 'ボス戦・盛り上がったとき',
}

/** 上げてある素材。曲にしている2つの音声のほかに、まだ曲にしていない音声と画像がある */
const 上げてある素材: MediaItem[] = [
  { id: 'media-zatsudan', name: 'hidamari.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
  { id: 'media-moriagari', name: 'zenryoku.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
  { id: 'media-yuugure', name: '夕暮れの帰り道.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
  { id: 'media-gazou', name: 'kanpai.png', kind: 'image', contentType: 'image/png', size: 100, uploadedAt: '2026-09-29T00:00:00Z' },
]

/** 読み書きを記録する、BGMのAPI */
const bgmApi = (
  tracks: BgmTrack[] = [雑談の曲, 盛り上がる曲],
  playback: BgmPlayback = { mediaId: 雑談の曲.mediaId, volume: 0.3 },
): BgmApi & { 保存した曲: BgmTrack[][]; 送った再生: BgmPlayback[] } => {
  const 保存した曲: BgmTrack[][] = []
  const 送った再生: BgmPlayback[] = []
  return {
    保存した曲,
    送った再生,
    load: () => Promise.resolve({ tracks, playback }),
    saveTracks: (next) => {
      保存した曲.push([...next])
      return Promise.resolve([...next])
    },
    savePlayback: (next) => {
      送った再生.push(next)
      return Promise.resolve(next)
    },
  }
}

const mediaApi = { media: () => Promise.resolve(上げてある素材) }

const 描く = (api: BgmApi = bgmApi()) => render(<BgmPage api={api} mediaApi={mediaApi} />)

/** 曲の一覧が出るまで待つ */
const 読み込みを待つ = () => screen.findByRole('list', { name: '曲の一覧' })

/** 曲の行を、曲名で探す */
const 曲の行 = (title: string) => within(screen.getByRole('listitem', { name: title }))

/**
 * スライダーの入力要素を名前で探す。
 * Base UI の Slider は、つまみの位置を測り終えるまでつまみを隠す。jsdom は位置を測れず隠れたままなので、
 * 名前は外側の枠（role="group"）で確かめ、その中の入力要素を隠れた要素も含めて探す（trigger-page.test.tsx と同じ）
 */
const 音量のスライダー = () => within(screen.getByRole('group', { name: '音量' })).getByRole('slider', { hidden: true })

describe('BGMのページ', () => {
  test('保存済みの曲を並べ、いま流している曲を示す', async () => {
    描く()
    await 読み込みを待つ()

    expect(曲の行('ひだまりの午後').getByText('流しています')).toBeInTheDocument()
    expect(曲の行('全力疾走').queryByText('流しています')).not.toBeInTheDocument()
    expect(screen.getByText(/「ひだまりの午後」を流しています/)).toBeInTheDocument()
  })

  test('曲の「流す」を押すと、その曲を流すよう Worker へ送る', async () => {
    const api = bgmApi()
    描く(api)
    await 読み込みを待つ()

    await userEvent.click(曲の行('全力疾走').getByRole('button', { name: '「全力疾走」を流す' }))

    await waitFor(() => expect(api.送った再生).toEqual([{ mediaId: 盛り上がる曲.mediaId, volume: 0.3 }]))
    expect(await screen.findByText(/「全力疾走」を流しています/)).toBeInTheDocument()
  })

  test('「止める」を押すと、止めるよう Worker へ送る', async () => {
    const api = bgmApi()
    描く(api)
    await 読み込みを待つ()

    await userEvent.click(screen.getByRole('button', { name: '止める' }))

    await waitFor(() => expect(api.送った再生).toEqual([{ mediaId: null, volume: 0.3 }]))
    expect(await screen.findByText('BGMを止めています')).toBeInTheDocument()
  })

  test('何も流していなければ「止める」は押せない', async () => {
    描く(bgmApi([雑談の曲], { mediaId: null, volume: 0.3 }))
    await 読み込みを待つ()

    expect(screen.getByRole('button', { name: '止める' })).toBeDisabled()
  })

  test('音量を動かすと、流している曲のまま音量を Worker へ送る', async () => {
    const api = bgmApi()
    描く(api)
    await 読み込みを待つ()

    fireEvent.change(音量のスライダー(), { target: { value: '45' } })

    await waitFor(() => expect(api.送った再生.at(-1)).toEqual({ mediaId: 雑談の曲.mediaId, volume: 0.45 }))
  })

  test('上げた音声から曲を足し、クレジットを書いて保存できる', async () => {
    const api = bgmApi()
    描く(api)
    await 読み込みを待つ()

    // まだ曲にしていない音声だけが候補に並ぶ
    const 足す音声 = screen.getByRole('combobox', { name: '足す音声' })
    expect(within(足す音声).getAllByRole('option').map((option) => option.textContent)).toEqual(['夕暮れの帰り道.mp3'])
    await userEvent.click(screen.getByRole('button', { name: '曲を足す' }))

    // 曲名はファイル名から下書きされる。クレジットは書いてもらう
    const 足した曲 = 曲の行('夕暮れの帰り道')
    await userEvent.type(足した曲.getByLabelText('クレジット表記'), '音楽: 魔王魂')
    await userEvent.click(screen.getByRole('button', { name: '曲の一覧を保存' }))

    await waitFor(() => expect(api.保存した曲).toHaveLength(1))
    expect(api.保存した曲[0]?.at(-1)).toEqual({ mediaId: 'media-yuugure', title: '夕暮れの帰り道', credit: '音楽: 魔王魂', creditUrl: '', mood: '', scene: '' })
  })

  test('まだ保存していない曲は流せない（Worker の一覧に無いため）', async () => {
    描く()
    await 読み込みを待つ()

    await userEvent.click(screen.getByRole('button', { name: '曲を足す' }))

    expect(曲の行('夕暮れの帰り道').getByRole('button', { name: '「夕暮れの帰り道」を流す' })).toBeDisabled()
  })

  test('曲を外して保存できる。流している曲は外せない', async () => {
    const api = bgmApi()
    描く(api)
    await 読み込みを待つ()

    expect(曲の行('ひだまりの午後').getByRole('button', { name: '「ひだまりの午後」を外す' })).toBeDisabled()
    await userEvent.click(曲の行('全力疾走').getByRole('button', { name: '「全力疾走」を外す' }))
    await userEvent.click(screen.getByRole('button', { name: '曲の一覧を保存' }))

    await waitFor(() => expect(api.保存した曲).toEqual([[雑談の曲]]))
  })

  test('Worker が返した問題点を、画面に見えている名前で並べる', async () => {
    const api: BgmApi = {
      ...bgmApi(),
      saveTracks: () => Promise.reject(new ApiError(400, 'invalid-config', 'BGMの曲に問題があります', ['tracks[1].credit: 1〜200文字で指定してください'])),
    }
    描く(api)
    await 読み込みを待つ()

    await userEvent.click(screen.getByRole('button', { name: '曲の一覧を保存' }))

    expect(await screen.findByText(/2曲目のクレジット表記: 1〜200文字で指定してください/)).toBeInTheDocument()
  })

  test('読み込めなければ、空の一覧を出さずに理由を出す', async () => {
    const api: BgmApi = { ...bgmApi(), load: () => Promise.reject(new Error('通信が切れました')) }
    描く(api)

    expect(await screen.findByText(/通信が切れました/)).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: '曲の一覧' })).not.toBeInTheDocument()
  })
})
