// @vitest-environment jsdom
/**
 * トリガーのページ（OBS用のURL・トリガー）のテスト
 *
 * 確かめること:
 * - OBS用のURLを伏せ字で出し、コピーとキーの再発行ができること（再発行は確認してから）
 * - トリガーを足し、入力欄の値をWorkerへ送る形にして保存できること
 * - 素材は一覧から選ぶだけで、ここでは足せないこと（アップロードのページへ案内する）
 * - 失敗は黙って無視せず、理由を出すこと（報酬の一覧だけ取れないときは、画面は出したまま理由を出す）
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TriggerPage } from './trigger-page'
import { ApiError } from '@/core/api'
import { type AdminApi, type MediaItem, type Reward, type StoredTrigger } from './api'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

const 拍手の動画: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }
const 花火の画像: MediaItem = { id: 'media-hanabi', name: '花火.png', kind: 'image', contentType: 'image/png', size: 2048, uploadedAt: '2026-09-02T00:00:00Z' }
const 拍手の報酬: Reward = { id: 'reward-hakushu', title: '拍手を送る', cost: 100 }
const 拍手のトリガー: StoredTrigger = {
  event: REDEMPTION,
  rewardId: 'reward-hakushu',
  actions: [{ type: 'alert', mediaId: 'media-hakushu', mediaKind: 'video', durationSeconds: 8, volume: 0.5, message: '{user} さんが拍手を送りました' }],
}

/** 素材2つ・報酬1つ・トリガー1つが保存されている状態のWorkerの代役 */
const 代役のAPI = (overrides: Partial<AdminApi> = {}): AdminApi => ({
  me: vi.fn(async () => null),
  logout: vi.fn(async () => {}),
  config: vi.fn(async () => [拍手のトリガー]),
  saveConfig: vi.fn(async () => [拍手のトリガー]),
  media: vi.fn(async () => [拍手の動画, 花火の画像]),
  upload: vi.fn(async () => 花火の画像),
  removeMedia: vi.fn(async () => {}),
  rotateOverlayKey: vi.fn(async () => 'atarashii-key'),
  rewards: vi.fn(async () => [拍手の報酬]),
  ...overrides,
})

const トリガーのページ = (api: AdminApi, props: Partial<React.ComponentProps<typeof TriggerPage>> = {}) => (
  <TriggerPage api={api} overlayKey="ima-no-key" onOverlayKeyChange={() => {}} {...props} />
)

const URL欄 = (): HTMLElement => screen.getByLabelText('OBSのブラウザソースに貼るURL')
/** 操作の結果のお知らせ。音量の表示（output 要素）も role="status" を持つので、役割ではなく文言で探す */
const お知らせ = (text: string): Promise<HTMLElement> => screen.findByText(new RegExp(text))
const アラートのURL = (key: string): string => `${window.location.origin}/alerts/?key=${key}`

/**
 * スライダーの入力要素を名前で探す。
 * Base UI の Slider は、つまみの位置を測り終えるまでつまみを visibility: hidden にする。jsdom は位置を測れず隠れたままなので、
 * 名前は外側の枠（role="group"）で確かめ、その中の入力要素を隠れた要素も含めて探す
 */
const スライダー = (name: string, scope: Pick<typeof screen, 'getByRole'> = screen): HTMLElement =>
  within(scope.getByRole('group', { name })).getByRole('slider', { hidden: true })

afterEach(cleanup)

describe('OBS用のURL', () => {
  test('キーが配信画面に映り込んでも読めないよう、伏せ字で出す', async () => {
    render(トリガーのページ(代役のAPI()))

    expect(await screen.findByLabelText('OBSのブラウザソースに貼るURL')).toHaveValue(アラートのURL('ima-no-key'))
    expect(URL欄()).toHaveAttribute('type', 'password')
    expect(URL欄()).toHaveAttribute('readonly')
  })

  test('URLをコピーできる', async () => {
    const user = userEvent.setup()
    render(トリガーのページ(代役のAPI()))

    await user.click(await screen.findByRole('button', { name: 'URLをコピー' }))

    expect(await お知らせ('OBS用のURLをコピーしました')).toBeInTheDocument()
    expect(await window.navigator.clipboard.readText()).toBe(アラートのURL('ima-no-key'))
  })

  test('キーの再発行は確認してから行い、新しいキーを呼び出し元へ知らせる', async () => {
    const api = 代役のAPI()
    const onOverlayKeyChange = vi.fn()
    render(トリガーのページ(api, { onOverlayKeyChange }))

    await userEvent.click(await screen.findByRole('button', { name: 'キーを再発行する' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('今のURLは使えなくなります')
    expect(api.rotateOverlayKey).not.toHaveBeenCalled()

    await userEvent.click(within(dialog).getByRole('button', { name: '再発行する' }))

    expect(await お知らせ('キーを再発行しました')).toBeInTheDocument()
    expect(onOverlayKeyChange).toHaveBeenCalledWith('atarashii-key')
  })

  test('確認でやめたら、キーは再発行しない', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    await userEvent.click(await screen.findByRole('button', { name: 'キーを再発行する' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'やめる' }))

    expect(api.rotateOverlayKey).not.toHaveBeenCalled()
  })

  test('キーが発行されていなければ、操作盤を出さずに理由を出す', async () => {
    render(トリガーのページ(代役のAPI(), { overlayKey: null }))

    expect(await screen.findByRole('alert')).toHaveTextContent('オーバーレイ用キーが発行されていません')
    expect(screen.queryByLabelText('OBSのブラウザソースに貼るURL')).not.toBeInTheDocument()
  })
})

describe('トリガー', () => {
  test('保存済みのトリガーを入力欄に出す（音量は百分率）', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = within((await screen.findAllByRole('listitem', { name: /番目のトリガー/ }))[0]!)
    expect(await row.findByRole('option', { name: '拍手を送る（100pt）' })).toBeInTheDocument()
    expect(row.getByLabelText('報酬')).toHaveValue('reward-hakushu')
    expect(row.getByLabelText('素材')).toHaveValue('media-hakushu')
    expect(row.getByLabelText('表示時間（1〜60秒）')).toHaveValue(8)
    expect(スライダー('音量', row)).toHaveValue('50')
    expect(row.getByLabelText('文言（空欄なら出さない）')).toHaveValue('{user} さんが拍手を送りました')
  })

  test('イベントを切り替えると、報酬の選択欄はチャンネルポイント交換のときだけ出る', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = within((await screen.findAllByRole('listitem', { name: /番目のトリガー/ }))[0]!)
    expect(row.getByLabelText('報酬')).toBeInTheDocument()

    await userEvent.selectOptions(row.getByLabelText('イベント'), 'channel.follow')
    expect(row.queryByLabelText('報酬')).not.toBeInTheDocument()

    await userEvent.selectOptions(row.getByLabelText('イベント'), REDEMPTION)
    expect(row.getByLabelText('報酬')).toBeInTheDocument()
  })

  test('選んだイベントで使える差し込み語を、文言欄のそばに出す', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = within((await screen.findAllByRole('listitem', { name: /番目のトリガー/ }))[0]!)
    expect(row.getByText(/\{user\}/)).toHaveTextContent('{reward}')

    await userEvent.selectOptions(row.getByLabelText('イベント'), 'channel.raid')
    const 差し込み語 = row.getByText(/\{user\}/)
    expect(差し込み語).toHaveTextContent('{viewers}')
    expect(差し込み語).not.toHaveTextContent('{reward}')
  })

  test('チャンネルポイント交換以外のイベントのトリガーは、報酬IDを付けずに保存する', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = within((await screen.findAllByRole('listitem', { name: /番目のトリガー/ }))[0]!)
    await userEvent.selectOptions(row.getByLabelText('イベント'), 'channel.raid')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        event: 'channel.raid',
        actions: [{ type: 'alert', mediaId: 'media-hakushu', durationSeconds: 8, volume: 0.5, message: '{user} さんが拍手を送りました' }],
      },
    ])
  })

  test('トリガーを足して書き換え、Workerへ送る形で保存する', async () => {
    const api = 代役のAPI({ config: vi.fn(async () => []) })
    render(トリガーのページ(api))

    await userEvent.click(await screen.findByRole('button', { name: 'トリガーを足す' }))
    const row = within(screen.getByRole('listitem', { name: '1番目のトリガー' }))
    await userEvent.selectOptions(row.getByLabelText('素材'), 'media-hanabi')
    fireEvent.change(row.getByLabelText('表示時間（1〜60秒）'), { target: { value: '12' } })
    fireEvent.change(スライダー('音量', row), { target: { value: '30' } })
    await userEvent.type(row.getByLabelText('文言（空欄なら出さない）'), 'ありがとう')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      { event: REDEMPTION, rewardId: null, actions: [{ type: 'alert', mediaId: 'media-hanabi', durationSeconds: 12, volume: 0.3, message: 'ありがとう' }] },
    ])
  })

  test('素材が1つもなければ、チャットに送るだけのトリガーとして足す', async () => {
    render(トリガーのページ(代役のAPI({ media: async () => [], config: async () => [] })))

    await userEvent.click(await screen.findByRole('button', { name: 'トリガーを足す' }))

    const row = within(screen.getByRole('listitem', { name: '1番目のトリガー' }))
    // Base UI のチェックボックスは span[role=checkbox] と隠しinputの2つになるため、役割で探す
    expect(row.getByRole('checkbox', { name: 'アラートを出す' })).not.toBeChecked()
    expect(row.getByRole('checkbox', { name: 'チャットに送る' })).toBeChecked()
  })

  test('チャットに送る文言を入れて保存すると、チャットの動作として送る', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = within((await screen.findAllByRole('listitem', { name: /番目のトリガー/ }))[0]!)
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))
    await userEvent.click(row.getByRole('checkbox', { name: 'チャットに送る' }))
    await userEvent.type(row.getByLabelText('チャットに送る文言'), '{{user} さん、ありがとうございます')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      { event: REDEMPTION, rewardId: 'reward-hakushu', actions: [{ type: 'chat', message: '{user} さん、ありがとうございます' }] },
    ])
  })

  test('アナウンスを送る文言と色を入れて保存すると、アナウンスの動作として送る', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = within((await screen.findAllByRole('listitem', { name: /番目のトリガー/ }))[0]!)
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))
    await userEvent.click(row.getByRole('checkbox', { name: 'アナウンスを送る' }))
    await userEvent.type(row.getByLabelText('アナウンスの文言'), '{{user} さん、ありがとうございます')
    await userEvent.selectOptions(row.getByLabelText('アナウンスの色'), 'purple')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        event: REDEMPTION,
        rewardId: 'reward-hakushu',
        actions: [{ type: 'announce', message: '{user} さん、ありがとうございます', color: 'purple' }],
      },
    ])
  })

  test('アナウンスを送るを外していれば、文言の入力欄を隠す', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = within((await screen.findAllByRole('listitem', { name: /番目のトリガー/ }))[0]!)

    expect(row.queryByLabelText('アナウンスの文言')).not.toBeInTheDocument()
  })

  test('アラートを出すを外すと、素材や表示時間の入力欄を隠す', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = within((await screen.findAllByRole('listitem', { name: /番目のトリガー/ }))[0]!)
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))

    expect(row.queryByLabelText('素材')).not.toBeInTheDocument()
    expect(row.queryByLabelText('表示時間（1〜60秒）')).not.toBeInTheDocument()
  })

  test('チャットに送るだけのトリガーでアラートを出すを付けると、選択欄に見えている最初の素材で保存する', async () => {
    // 素材が未選択（空文字）のまま保存すると、選択欄には最初の素材が見えているのにWorkerが「素材が存在しません」と拒否してしまう
    const チャットだけのトリガー: StoredTrigger = { event: 'channel.follow', actions: [{ type: 'chat', message: 'ありがとうございます' }] }
    const api = 代役のAPI({ config: vi.fn(async () => [チャットだけのトリガー]) })
    render(トリガーのページ(api))

    const row = within((await screen.findAllByRole('listitem', { name: /番目のトリガー/ }))[0]!)
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        event: 'channel.follow',
        actions: [
          { type: 'alert', mediaId: 'media-hakushu', durationSeconds: 5, volume: 1, message: '' },
          { type: 'chat', message: 'ありがとうございます' },
        ],
      },
    ])
  })

  test('トリガーを外せる', async () => {
    render(トリガーのページ(代役のAPI()))

    await userEvent.click(await screen.findByRole('button', { name: 'このトリガーを外す' }))

    expect(screen.getByText('トリガーはまだありません。')).toBeInTheDocument()
  })

  test('表示時間が数として読めなければ、送らずに何番目かを添えて理由を出す', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    fireEvent.change(await screen.findByLabelText('表示時間（1〜60秒）'), { target: { value: '' } })
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('1番目のトリガー: 表示時間を数で入力してください')
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  test('Workerが設定の問題点を返したら、画面の番号に読み替えて並べる', async () => {
    const api = 代役のAPI({
      saveConfig: vi.fn(async () => {
        throw new ApiError(400, 'invalid_config', '設定に問題があります', ['triggers[0].durationSeconds は 1〜60 で指定してください'])
      }),
    })
    render(トリガーのページ(api))

    await userEvent.click(await screen.findByRole('button', { name: 'トリガーを保存' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('トリガーの設定に問題があります')
    expect(alert).toHaveTextContent('1番目のトリガーの durationSeconds は 1〜60 で指定してください')
  })
})

describe('素材', () => {
  test('素材が1つもなければ、アップロードのページへ案内する', async () => {
    render(トリガーのページ(代役のAPI({ media: async () => [], config: async () => [] })))

    expect(await screen.findByRole('link', { name: 'アップロード' })).toHaveAttribute('href', '/media/')
  })
})

describe('読み込みの失敗', () => {
  test('素材の一覧や設定を取得できなければ、操作盤を出さずに理由を出す', async () => {
    render(
      トリガーのページ(
        代役のAPI({
          media: async () => {
            throw new Error('Workerに接続できません')
          },
        }),
      ),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('トリガーを表示できません: Workerに接続できません')
    expect(screen.queryByRole('button', { name: 'トリガーを足す' })).not.toBeInTheDocument()
  })

  test('報酬の一覧だけ取得できないときは、操作盤は出したまま理由を出す', async () => {
    render(
      トリガーのページ(
        代役のAPI({
          rewards: async () => {
            throw new Error('チャンネルポイントを使えないチャンネルです')
          },
        }),
      ),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('チャンネルポイント報酬の一覧を取得できませんでした: チャンネルポイントを使えないチャンネルです')
    expect(screen.getByRole('button', { name: 'トリガーを足す' })).toBeInTheDocument()
    // ほかの操作が成功しても、報酬を選べない理由は出したままにする（報酬の一覧はまだ取得できていない）
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを足す' }))
    expect(await お知らせ('トリガーを足しました')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('チャンネルポイント報酬の一覧を取得できませんでした')
    // 保存済みの報酬はTwitchの一覧にないものとして選択肢に残る（黙って「すべての報酬」に変えない）
    expect(screen.getAllByLabelText('報酬')[0]).toHaveValue('reward-hakushu')
  })
})
