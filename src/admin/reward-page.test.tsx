// @vitest-environment jsdom
/**
 * チャンネルポイント報酬のページ（一覧・追加・編集・削除）のテスト
 *
 * 確かめること:
 * - 報酬の一覧を出し、HDADから変更できる報酬だけに編集欄と削除のボタンを出すこと
 * - 報酬を追加できること（Workerが返した問題点を欄の名前で並べること）
 * - 報酬を編集して保存できること
 * - 削除は確認してから行うこと
 * - 失敗は黙って無視せず、理由を出すこと
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '@/core/api'
import type { AdminApi, Reward, RewardInput } from './api'
import { RewardPage } from './reward-page'

/** HDADが作った報酬（編集・削除できる） */
const toastReward: Reward = {
  id: '報酬ID-乾杯',
  title: '乾杯する',
  cost: 500,
  prompt: 'おつまみも添えて',
  isEnabled: true,
  isUserInputRequired: false,
  imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/12345/kanpai-2.png',
  manageable: true,
}

/** Twitchのダッシュボードで作った報酬（HDADからは変更できない） */
const hydrateReward: Reward = {
  id: '報酬ID-水分補給',
  title: '水分補給させる',
  cost: 100,
  prompt: '',
  isEnabled: true,
  isUserInputRequired: false,
  imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png',
  manageable: false,
}

/** 報酬2つがある状態のWorkerの代役。報酬の操作以外は使わないので、呼ばれたら失敗させる */
const fakeApi = (overrides: Partial<AdminApi> = {}): AdminApi => {
  const unused = async (): Promise<never> => {
    throw new Error('このテストでは使いません')
  }
  return {
    me: vi.fn(unused),
    logout: vi.fn(unused),
    config: vi.fn(unused),
    saveConfig: vi.fn(unused),
    media: vi.fn(unused),
    upload: vi.fn(unused),
    removeMedia: vi.fn(unused),
    rotateOverlayKey: vi.fn(unused),
    playTownTourDemo: vi.fn(unused),
    townTourSound: vi.fn(unused),
    saveTownTourSound: vi.fn(unused),
    rewards: vi.fn(async () => [toastReward, hydrateReward]),
    createReward: vi.fn(async (input: RewardInput) => ({ ...input, id: '報酬ID-新しい', imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', manageable: true })),
    updateReward: vi.fn(async (id: string, input: RewardInput) => ({ ...input, id, imageUrl: toastReward.imageUrl, manageable: true })),
    removeReward: vi.fn(async () => {}),
    ...overrides,
  }
}

/** 一覧のうち、その名前の報酬の項目 */
const findRewardItem = async (title: string): Promise<HTMLElement> => {
  const list = await screen.findByRole('list', { name: '報酬の一覧' })
  const item = within(list)
    .getAllByRole('listitem')
    .find((candidate) => within(candidate).queryByText(title) !== null || within(candidate).queryByDisplayValue(title) !== null)
  if (item === undefined) throw new Error(`一覧に「${title}」がありません`)
  return item
}

/** 報酬を追加する欄 */
const findAddForm = async (): Promise<HTMLElement> => screen.findByRole('form', { name: '報酬を追加する' })

afterEach(cleanup)

describe('報酬の一覧', () => {
  test('HDADが作った報酬には、編集欄と削除のボタンを出す', async () => {
    render(<RewardPage api={fakeApi()} />)

    const item = await findRewardItem('乾杯する')
    expect(within(item).getByRole('textbox', { name: '名前' })).toHaveValue('乾杯する')
    expect(within(item).getByRole('spinbutton', { name: '必要ポイント' })).toHaveValue(500)
    expect(within(item).getByRole('textbox', { name: '説明' })).toHaveValue('おつまみも添えて')
    expect(within(item).getByRole('button', { name: '乾杯する を削除' })).toBeInTheDocument()
  })

  test('Twitchで作った報酬は、変更できないことを示し、編集欄も削除のボタンも出さない', async () => {
    render(<RewardPage api={fakeApi()} />)

    const item = await findRewardItem('水分補給させる')
    expect(within(item).getByText(/ここでは変更できません/)).toBeInTheDocument()
    expect(within(item).getByText(/100/)).toBeInTheDocument()
    expect(within(item).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(item).queryByRole('button')).not.toBeInTheDocument()
  })

  test('どの報酬にも、Twitchの報酬の画像を出す（HDADから作った報酬・Twitchで作った報酬の両方）', async () => {
    render(<RewardPage api={fakeApi()} />)

    // 画像は名前の横に添える飾りなので、読み上げには出さない（alt は空）
    expect((await findRewardItem('乾杯する')).querySelector('img')).toHaveAttribute('src', toastReward.imageUrl)
    expect((await findRewardItem('水分補給させる')).querySelector('img')).toHaveAttribute('src', hydrateReward.imageUrl)
    expect((await findRewardItem('水分補給させる')).querySelector('img')).toHaveAttribute('alt', '')
  })

  test('報酬が1件もなければ、その旨を出す', async () => {
    render(<RewardPage api={fakeApi({ rewards: vi.fn(async () => []) })} />)

    expect(await screen.findByText(/報酬はまだありません/)).toBeInTheDocument()
  })

  test('一覧の取得に失敗したら、理由を出す（黙って空の一覧にしない）', async () => {
    render(
      <RewardPage
        api={fakeApi({
          rewards: vi.fn(async () => {
            throw new Error('channel points are not available')
          }),
        })}
      />,
    )

    expect(await screen.findByText(/channel points are not available/)).toBeInTheDocument()
    expect(screen.queryByRole('form', { name: '報酬を追加する' })).not.toBeInTheDocument()
  })
})

describe('報酬の追加', () => {
  test('入力した内容で報酬を作り、一覧に加えて入力欄を空に戻す', async () => {
    const user = userEvent.setup()
    const api = fakeApi()
    render(<RewardPage api={api} />)

    const form = await findAddForm()
    await user.type(within(form).getByRole('textbox', { name: '名前' }), 'おみくじを引く')
    await user.type(within(form).getByRole('spinbutton', { name: '必要ポイント' }), '300')
    await user.type(within(form).getByRole('textbox', { name: '説明' }), '今日の運勢を占います')
    await user.click(within(form).getByRole('checkbox', { name: 'メッセージの入力を求める' }))
    await user.click(within(form).getByRole('button', { name: '報酬を追加する' }))

    expect(api.createReward).toHaveBeenCalledWith({
      title: 'おみくじを引く',
      cost: 300,
      prompt: '今日の運勢を占います',
      isEnabled: true,
      isUserInputRequired: true,
    })
    expect(await screen.findByText(/おみくじを引く を追加しました/)).toBeInTheDocument()
    expect(await findRewardItem('おみくじを引く')).toBeInTheDocument()
    expect(within(form).getByRole('textbox', { name: '名前' })).toHaveValue('')
  })

  test('Workerが入力の問題点を返したら、欄の名前で並べて出し、入力は残す', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      createReward: vi.fn(async () => {
        throw new ApiError(400, 'invalid-config', 'チャンネルポイント報酬に問題があります', [
          'title: 名前は空でない45文字までの文字列で指定してください',
          'cost: 必要ポイントは1以上の整数で指定してください',
        ])
      }),
    })
    render(<RewardPage api={api} />)

    const form = await findAddForm()
    await user.type(within(form).getByRole('textbox', { name: '説明' }), '名前を忘れた')
    await user.click(within(form).getByRole('button', { name: '報酬を追加する' }))

    expect(await screen.findByText(/名前: 名前は空でない45文字まで/)).toBeInTheDocument()
    expect(screen.getByText(/必要ポイント: 必要ポイントは1以上の整数/)).toBeInTheDocument()
    expect(within(form).getByRole('textbox', { name: '説明' })).toHaveValue('名前を忘れた')
  })

  test('問題点を持たない失敗（ログインし直しが要るなど）は、Workerのメッセージをそのまま出す', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      createReward: vi.fn(async () => {
        throw new ApiError(401, 'missing-scope', '配信者のトークンに channel:manage:redemptions がありません。ログインし直してください', [])
      }),
    })
    render(<RewardPage api={api} />)

    const form = await findAddForm()
    await user.click(within(form).getByRole('button', { name: '報酬を追加する' }))

    expect(await screen.findByText(/ログインし直してください/)).toBeInTheDocument()
  })
})

describe('報酬の編集', () => {
  test('書き換えた内容で報酬を保存し、保存したことを知らせる', async () => {
    const user = userEvent.setup()
    const api = fakeApi()
    render(<RewardPage api={api} />)

    const item = await findRewardItem('乾杯する')
    const cost = within(item).getByRole('spinbutton', { name: '必要ポイント' })
    await user.clear(cost)
    await user.type(cost, '800')
    await user.click(within(item).getByRole('checkbox', { name: '交換できる' }))
    await user.click(within(item).getByRole('button', { name: '乾杯する を保存する' }))

    expect(api.updateReward).toHaveBeenCalledWith('報酬ID-乾杯', {
      title: '乾杯する',
      cost: 800,
      prompt: 'おつまみも添えて',
      isEnabled: false,
      isUserInputRequired: false,
    })
    expect(await screen.findByText(/乾杯する を保存しました/)).toBeInTheDocument()
  })
})

describe('報酬の削除', () => {
  test('確認してから削除し、一覧から外す', async () => {
    const user = userEvent.setup()
    const api = fakeApi()
    render(<RewardPage api={api} />)

    const item = await findRewardItem('乾杯する')
    await user.click(within(item).getByRole('button', { name: '乾杯する を削除' }))
    expect(api.removeReward).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: '削除する' }))

    expect(api.removeReward).toHaveBeenCalledWith('報酬ID-乾杯')
    expect(await screen.findByText(/乾杯する を削除しました/)).toBeInTheDocument()
    expect(screen.queryByDisplayValue('乾杯する')).not.toBeInTheDocument()
  })

  test('トリガーに使われていて断られたら、理由を出して一覧に残す', async () => {
    const user = userEvent.setup()
    const api = fakeApi({
      removeReward: vi.fn(async () => {
        throw new ApiError(409, 'reward-in-use', 'この報酬はトリガーに使われています。先にトリガーの設定から外してください', [])
      }),
    })
    render(<RewardPage api={api} />)

    const item = await findRewardItem('乾杯する')
    await user.click(within(item).getByRole('button', { name: '乾杯する を削除' }))
    await user.click(await screen.findByRole('button', { name: '削除する' }))

    expect(await screen.findByText(/トリガーに使われています/)).toBeInTheDocument()
    expect(await findRewardItem('乾杯する')).toBeInTheDocument()
  })
})
