// @vitest-environment jsdom
/**
 * 市町村紹介のカード（音の設定と試し再生）のテスト
 *
 * 確かめること:
 * - 場面ごとの枠が演出で鳴る順に並び、選べるのはアップロード済みの音声と「鳴らさない」だけであること
 * - 選んだ音と音量をWorkerへ送って保存し、保存したことを知らせること
 * - 未保存の変更があることを知らせること
 * - 保存を断られたら、問題点を枠の名前に読み替えて1行ずつ出すこと
 * - 設定を読めなければ、枠を出さずに理由を出すこと
 * - 試し再生を押すと、Workerに流させること
 * - ナレーション（issue #255）の設定を同じカードで選べ、その未保存の変更があるあいだも試し再生を押せないこと
 *   （ナレーションの区画そのものは town-tour-narration-section.test.tsx が確かめる）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { TownTourNarration } from '@/town-tour/narration'
import type { TownTourSound } from '@/town-tour/sound'
import type { MediaItem } from './api'
import { TownTourSoundCard, type TownTourSoundApi } from './town-tour-sound-card'

/** アップロード済みの素材。BGM と効果音は音声、拍手の動画はアラート用 */
const cookieBgm: MediaItem = { id: 'media-cookie', name: 'Cookie Cookie.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 3 * 1024 * 1024, uploadedAt: '2026-10-01T00:00:00Z' }
const jajeanSound: MediaItem = { id: 'media-jajean', name: 'ジャジャーン.mp3', kind: 'audio', contentType: 'audio/mpeg', size: 40 * 1024, uploadedAt: '2026-10-02T00:00:00Z' }
const applauseVideo: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }
const media = [cookieBgm, jajeanSound, applauseVideo]

/** BGM だけを選んで保存してある設定 */
const savedSound: TownTourSound = {
  slots: { bgm: 'media-cookie', opening: null, zoom: null, landing: null, item: null, closing: null },
  bgmVolume: 0.3,
  effectVolume: 0.6,
}

const fakeApi = (overrides: Partial<TownTourSoundApi> = {}): TownTourSoundApi => ({
  townTourSound: vi.fn(async () => savedSound),
  saveTownTourSound: vi.fn(async (sound: TownTourSound) => sound),
  playTownTourDemo: vi.fn(async () => '試し再生: 本日は北海道石狩郡当別町をご紹介します'),
  townTourNarration: vi.fn(async () => ({ enabled: false, speaker: 3, speed: 1 })),
  saveTownTourNarration: vi.fn(async (narration: TownTourNarration) => narration),
  ...overrides,
})

afterEach(cleanup)

describe('TownTourSoundCard', () => {
  test('枠が演出で鳴る順に並び、保存してある音が選ばれている', async () => {
    render(<TownTourSoundCard api={fakeApi()} media={media} />)

    // 選択欄に結び付いた見出し（label 要素）を、並んでいる順に読む
    const selects = await screen.findAllByRole('combobox')
    const labels = selects.map((select) => document.querySelector(`label[for="${select.id}"]`)?.textContent)
    expect(labels).toEqual([
      'BGM（紹介のあいだ流す）',
      '始まり（日本全体を映したとき）',
      'ズーム（市町村へ寄り始めたとき）',
      '着地（形を塗り終えたとき）',
      '項目ごと（大見出しと各項目が出るたび）',
      '締め（配信者への振りが出たとき）',
    ])
    expect(screen.getByLabelText('BGM（紹介のあいだ流す）')).toHaveValue('media-cookie')
    expect(screen.getByLabelText('始まり（日本全体を映したとき）')).toHaveValue('')
  })

  test('選べるのは「鳴らさない」とアップロード済みの音声だけで、動画や画像は出さない', async () => {
    render(<TownTourSoundCard api={fakeApi()} media={media} />)

    const opening = await screen.findByLabelText('始まり（日本全体を映したとき）')
    const options = within(opening).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['鳴らさない', 'Cookie Cookie.mp3', 'ジャジャーン.mp3'])
  })

  test('音を選んで保存すると、選んだ音と音量をWorkerへ送り、保存したことを知らせる', async () => {
    const api = fakeApi()
    render(<TownTourSoundCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText('始まり（日本全体を映したとき）'), 'media-jajean')
    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '音を保存' }))

    expect(api.saveTownTourSound).toHaveBeenCalledWith({ ...savedSound, slots: { ...savedSound.slots, opening: 'media-jajean' } })
    expect(await screen.findByText('市町村紹介の音を保存しました')).toBeInTheDocument()
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()
  })

  test('保存を断られたら、問題点を枠の名前に読み替えて1行ずつ出す', async () => {
    const api = fakeApi({
      saveTownTourSound: vi.fn(async () => {
        throw new ApiError(400, 'invalid_config', '設定に問題があります', [
          'slots.zoom: 素材「media-kesareta」が存在しません',
          'effectVolume: 0〜1 の数で指定してください',
        ])
      }),
    })
    render(<TownTourSoundCard api={api} media={media} />)

    await userEvent.click(await screen.findByRole('button', { name: '音を保存' }))

    expect(await screen.findByText(/・ズーム（市町村へ寄り始めたとき）: 素材「media-kesareta」が存在しません/)).toBeInTheDocument()
    expect(screen.getByText(/・効果音の音量: 0〜1 の数で指定してください/)).toBeInTheDocument()
  })

  test('設定を読めなければ、枠を出さずに理由を出す', async () => {
    const api = fakeApi({
      townTourSound: vi.fn(async () => {
        throw new Error('Workerにつながりません')
      }),
    })
    render(<TownTourSoundCard api={api} media={media} />)

    expect(await screen.findByText(/Workerにつながりません/)).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  test('試し再生を押すと、Workerに流させ、送った一文を知らせる', async () => {
    const api = fakeApi()
    render(<TownTourSoundCard api={api} media={media} />)

    await userEvent.click(await screen.findByRole('button', { name: '市町村紹介を試しに流す' }))

    // ユーザー名を入れていなければ、空のまま送る（Worker は見本の名前で流す）
    expect(api.playTownTourDemo).toHaveBeenCalledWith('', null)
    expect(await screen.findByText(/北海道石狩郡当別町/)).toBeInTheDocument()
  })

  test('レイド元とみなすユーザー名を入れて試し再生を押すと、その名前を送る（issue #275）', async () => {
    const api = fakeApi()
    render(<TownTourSoundCard api={api} media={media} />)

    await userEvent.type(await screen.findByLabelText('レイド元とみなすユーザー名（任意）'), 'hoshino_yu')
    await userEvent.click(screen.getByRole('button', { name: '市町村紹介を試しに流す' }))

    expect(api.playTownTourDemo).toHaveBeenCalledWith('hoshino_yu', null)
  })

  test('ユーザー名が空のあいだは、レイドの人数を入れられない（連れてきた相手がいないため）', async () => {
    render(<TownTourSoundCard api={fakeApi()} media={media} />)

    expect(await screen.findByLabelText('レイドの人数（任意）')).toBeDisabled()
    await userEvent.type(screen.getByLabelText('レイド元とみなすユーザー名（任意）'), 'hoshino_yu')
    expect(screen.getByLabelText('レイドの人数（任意）')).toBeEnabled()
  })

  test('レイドの人数も入れて試し再生を押すと、人数を数にして送る', async () => {
    const api = fakeApi()
    render(<TownTourSoundCard api={api} media={media} />)

    await userEvent.type(await screen.findByLabelText('レイド元とみなすユーザー名（任意）'), 'hoshino_yu')
    await userEvent.type(screen.getByLabelText('レイドの人数（任意）'), '7')
    await userEvent.click(screen.getByRole('button', { name: '市町村紹介を試しに流す' }))

    expect(api.playTownTourDemo).toHaveBeenCalledWith('hoshino_yu', 7)
  })

  test('未保存の変更があるあいだは試し再生を押せない（試し再生は保存済みの音で鳴り、選び直した音と食い違うため）', async () => {
    render(<TownTourSoundCard api={fakeApi()} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText('始まり（日本全体を映したとき）'), 'media-jajean')

    expect(screen.getByRole('button', { name: '市町村紹介を試しに流す' })).toBeDisabled()
  })

  test('ナレーションの設定に未保存の変更があるあいだも試し再生を押せない（試し再生は保存済みの声で読み上げるため）', async () => {
    render(<TownTourSoundCard api={fakeApi()} media={media} />)

    await userEvent.click(await screen.findByRole('checkbox', { name: 'ナレーションで読み上げる' }))

    expect(screen.getByRole('button', { name: '市町村紹介を試しに流す' })).toBeDisabled()
  })
})
