// @vitest-environment jsdom
/**
 * VRMのカード（出す VRM の選択と試し再生）のテスト
 *
 * 確かめること:
 * - 選べるのは「選ばない」とアップロード済みの VRM だけで、保存してある VRM が選ばれていること
 * - 選んだ VRM をWorkerへ送って保存し、保存したことを知らせること
 * - 保存を断られたら、問題点を項目の名前に読み替えて1行ずつ出すこと
 * - 設定を読めなければ、選択欄を出さずに理由を出すこと
 * - 未保存の変更があるあいだと、VRM を選んでいないあいだは試し再生を押せないこと
 * （試し再生そのものは trigger-page.test.tsx が確かめる）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { VrmModel } from '@/vrm/model'
import type { MediaItem } from './api'
import { VrmCard, type VrmApi } from './vrm-card'

/** アップロード済みの素材。看板娘と魔法使いは VRM、拍手の動画はアラート用 */
const kanbanVrm: MediaItem = { id: 'media-kanban', name: '看板娘.vrm', kind: 'vrm', contentType: 'model/gltf-binary', size: 12 * 1024 * 1024, uploadedAt: '2026-10-13T00:00:00Z' }
const wizardVrm: MediaItem = { id: 'media-mahou', name: '魔法使い.vrm', kind: 'vrm', contentType: 'model/gltf-binary', size: 20 * 1024 * 1024, uploadedAt: '2026-10-13T00:00:00Z' }
const applauseVideo: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }
const media = [kanbanVrm, wizardVrm, applauseVideo]

/** 看板娘を選んで保存してある設定 */
const savedModel: VrmModel = { model: 'media-kanban' }

const fakeApi = (overrides: Partial<VrmApi> = {}): VrmApi => ({
  vrmModel: vi.fn(async () => savedModel),
  saveVrmModel: vi.fn(async (model: VrmModel) => model),
  playVrmDemo: vi.fn(async () => '試しID'),
  ...overrides,
})

const MODEL_LABEL = '出す VRM'

afterEach(cleanup)

describe('VrmCard', () => {
  test('選べるのは「選ばない」とアップロード済みの VRM だけで、保存してある VRM が選ばれている', async () => {
    render(<VrmCard api={fakeApi()} media={media} />)

    const select = await screen.findByLabelText(MODEL_LABEL)
    expect(select).toHaveValue('media-kanban')
    const options = within(select).getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['選ばない', '看板娘.vrm', '魔法使い.vrm'])
  })

  test('VRM を選び直して保存すると、選んだ VRM をWorkerへ送り、保存したことを知らせる', async () => {
    const api = fakeApi()
    render(<VrmCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(MODEL_LABEL), 'media-mahou')
    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'VRMを保存する' }))

    expect(api.saveVrmModel).toHaveBeenCalledWith({ model: 'media-mahou' })
    expect(await screen.findByText('VRMの演出で出す VRM を保存しました')).toBeInTheDocument()
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()
  })

  test('保存を断られたら、問題点を項目の名前に読み替えて1行ずつ出す', async () => {
    const api = fakeApi({
      saveVrmModel: vi.fn(async () => {
        throw new ApiError(400, 'invalid_config', '設定に問題があります', ['model: 素材「media-mahou」が存在しません'])
      }),
    })
    render(<VrmCard api={api} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(MODEL_LABEL), 'media-mahou')
    await userEvent.click(screen.getByRole('button', { name: 'VRMを保存する' }))

    expect(await screen.findByText(/・出す VRM: 素材「media-mahou」が存在しません/)).toBeInTheDocument()
  })

  test('設定を読めなければ、選択欄を出さずに理由を出す', async () => {
    const api = fakeApi({
      vrmModel: vi.fn(async () => {
        throw new Error('Workerにつながりません')
      }),
    })
    render(<VrmCard api={api} media={media} />)

    expect(await screen.findByText('Workerにつながりません')).toBeInTheDocument()
    expect(screen.queryByLabelText(MODEL_LABEL)).not.toBeInTheDocument()
  })

  test('未保存の変更があるあいだは試し再生を押せない（試し再生は保存済みの VRM で流れ、選び直した VRM と食い違うため）', async () => {
    render(<VrmCard api={fakeApi()} media={media} />)

    await userEvent.selectOptions(await screen.findByLabelText(MODEL_LABEL), 'media-mahou')

    expect(screen.getByRole('button', { name: 'VRMを試しに流す' })).toBeDisabled()
  })

  test('VRM を選んでいないあいだは試し再生を押せない（何も映らないため）', async () => {
    render(<VrmCard api={fakeApi({ vrmModel: vi.fn(async () => ({ model: null })) })} media={media} />)

    expect(await screen.findByLabelText(MODEL_LABEL)).toHaveValue('')
    expect(screen.getByRole('button', { name: 'VRMを試しに流す' })).toBeDisabled()
  })
})
