// @vitest-environment jsdom
/**
 * トリガーのページ（OBS用のURL・トリガー）のテスト
 *
 * 確かめること:
 * - OBS用のURLを伏せ字で出し、コピーとキーの再発行ができること（再発行は確認してから）
 * - トリガーは折りたたんで並び、見出しの要約を押すと入力欄が開くこと（開くのは1件ずつ）
 * - 条件（報酬・ユーザー）を足す・書き換える・外せること
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
  conditions: [{ kind: 'reward', rewardId: 'reward-hakushu' }],
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

/** position番目のトリガーの見出しを押して入力欄を開き、その中だけを探せるようにする */
const 開いたトリガー = async (position = 1) => {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${position}番目のトリガー:`) }))
  return within(screen.getByRole('listitem', { name: `${position}番目のトリガー` }))
}

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

    const row = await 開いたトリガー()
    expect(await row.findByRole('option', { name: '拍手を送る（100pt）' })).toBeInTheDocument()
    expect(row.getByLabelText('報酬')).toHaveValue('reward-hakushu')
    expect(row.getByLabelText('素材')).toHaveValue('media-hakushu')
    expect(row.getByLabelText('表示時間（1〜60秒）')).toHaveValue(8)
    expect(スライダー('音量', row)).toHaveValue('50')
    expect(row.getByLabelText('文言（空欄なら出さない）')).toHaveValue('{user} さんが拍手を送りました')
  })

  test('チャンネルポイント交換以外のイベントに切り替えると、報酬の条件は外れる（そのままでは保存できないため）', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いたトリガー()
    expect(row.getByLabelText('報酬')).toBeInTheDocument()

    await userEvent.selectOptions(row.getByLabelText('イベント'), 'channel.follow')

    expect(row.queryByLabelText('報酬')).not.toBeInTheDocument()
    // 報酬の条件は足せなくなる（チャンネルポイントの交換にしか付けられない）
    expect(row.queryByRole('button', { name: '報酬の条件を足す' })).not.toBeInTheDocument()
  })

  test('選んだイベントで使える差し込み語を、文言欄のそばに出す', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いたトリガー()
    expect(row.getByText(/\{user\}/)).toHaveTextContent('{reward}')

    await userEvent.selectOptions(row.getByLabelText('イベント'), 'channel.raid')
    const 差し込み語 = row.getByText(/\{user\}/)
    expect(差し込み語).toHaveTextContent('{viewers}')
    expect(差し込み語).not.toHaveTextContent('{reward}')
  })

  test('チャンネルポイント交換以外のイベントのトリガーは、報酬の条件を付けずに保存する', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.selectOptions(row.getByLabelText('イベント'), 'channel.raid')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        event: 'channel.raid',
        conditions: [],
        actions: [{ type: 'alert', mediaId: 'media-hakushu', durationSeconds: 8, volume: 0.5, message: '{user} さんが拍手を送りました' }],
      },
    ])
  })

  test('ユーザーの条件を足して名前を入れると、条件として保存する', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('button', { name: 'ユーザーの条件を足す' }))
    await userEvent.type(row.getByLabelText('ユーザー'), 'tanenobu')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        event: REDEMPTION,
        conditions: [
          { kind: 'reward', rewardId: 'reward-hakushu' },
          { kind: 'user', login: 'tanenobu' },
        ],
        actions: [{ type: 'alert', mediaId: 'media-hakushu', durationSeconds: 8, volume: 0.5, message: '{user} さんが拍手を送りました' }],
      },
    ])
  })

  test('同じ種類の条件は2件足せない（足したあとは選べなくなる）', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いたトリガー()
    // 報酬の条件は保存済みのトリガーにすでに付いている
    expect(row.queryByRole('button', { name: '報酬の条件を足す' })).not.toBeInTheDocument()

    await userEvent.click(row.getByRole('button', { name: 'ユーザーの条件を足す' }))

    expect(row.queryByRole('button', { name: 'ユーザーの条件を足す' })).not.toBeInTheDocument()
  })

  test('条件を外せる', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('button', { name: '報酬の条件を外す' }))
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([expect.objectContaining({ conditions: [] })])
  })

  test('条件が1件もなければ、いつでも動くことを知らせる', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [{ ...拍手のトリガー, conditions: [] }] })))

    const row = await 開いたトリガー()

    expect(row.getByText(/このイベントが起きればいつでも/)).toBeInTheDocument()
  })

  test('報酬の条件を足すと、置いてある報酬の先頭を選んだ状態になる（選択欄に見えているとおりで保存できる）', async () => {
    const api = 代役のAPI({ config: async () => [{ ...拍手のトリガー, conditions: [] }] })
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('button', { name: '報酬の条件を足す' }))

    expect(row.getByLabelText('報酬')).toHaveValue('reward-hakushu')
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
      { event: REDEMPTION, conditions: [], actions: [{ type: 'alert', mediaId: 'media-hanabi', durationSeconds: 12, volume: 0.3, message: 'ありがとう' }] },
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

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))
    await userEvent.click(row.getByRole('checkbox', { name: 'チャットに送る' }))
    await userEvent.type(row.getByLabelText('チャットに送る文言'), '{{user} さん、ありがとうございます')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        event: REDEMPTION,
        conditions: [{ kind: 'reward', rewardId: 'reward-hakushu' }],
        actions: [{ type: 'chat', message: '{user} さん、ありがとうございます' }],
      },
    ])
  })

  test('アナウンスを送る文言と色を入れて保存すると、アナウンスの動作として送る', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))
    await userEvent.click(row.getByRole('checkbox', { name: 'アナウンスを送る' }))
    await userEvent.type(row.getByLabelText('アナウンスの文言'), '{{user} さん、ありがとうございます')
    await userEvent.selectOptions(row.getByLabelText('アナウンスの色'), 'purple')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        event: REDEMPTION,
        conditions: [{ kind: 'reward', rewardId: 'reward-hakushu' }],
        actions: [{ type: 'announce', message: '{user} さん、ありがとうございます', color: 'purple' }],
      },
    ])
  })

  test('アナウンスを送るを外していれば、文言の入力欄を隠す', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いたトリガー()

    expect(row.queryByLabelText('アナウンスの文言')).not.toBeInTheDocument()
  })

  test('アラートを出すを外すと、素材や表示時間の入力欄を隠す', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))

    expect(row.queryByLabelText('素材')).not.toBeInTheDocument()
    expect(row.queryByLabelText('表示時間（1〜60秒）')).not.toBeInTheDocument()
  })

  test('チャットに送るだけのトリガーでアラートを出すを付けると、選択欄に見えている最初の素材で保存する', async () => {
    // 素材が未選択（空文字）のまま保存すると、選択欄には最初の素材が見えているのにWorkerが「素材が存在しません」と拒否してしまう
    const チャットだけのトリガー: StoredTrigger = { event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: 'ありがとうございます' }] }
    const api = 代役のAPI({ config: vi.fn(async () => [チャットだけのトリガー]) })
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        event: 'channel.follow',
        conditions: [],
        actions: [
          { type: 'alert', mediaId: 'media-hakushu', durationSeconds: 5, volume: 1, message: '' },
          { type: 'chat', message: 'ありがとうございます' },
        ],
      },
    ])
  })

  test('トリガーを外せる', async () => {
    render(トリガーのページ(代役のAPI()))

    await userEvent.click(await screen.findByRole('button', { name: '1番目のトリガーを外す' }))

    expect(screen.getByText('トリガーはまだありません。')).toBeInTheDocument()
  })

  test('表示時間が数として読めなければ、送らずに何番目かを添えて理由を出す', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    fireEvent.change(row.getByLabelText('表示時間（1〜60秒）'), { target: { value: '' } })
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

describe('折りたたみ', () => {
  test('保存済みのトリガーは折りたたんで並び、見出しに「イベント・条件・動作」の要約を出す', async () => {
    render(トリガーのページ(代役のAPI()))

    expect(await screen.findByRole('button', { name: /^1番目のトリガー:/ })).toHaveTextContent('チャンネルポイントの交換（報酬「拍手を送る」）→ アラート')
    // 開くまでは入力欄を出さない（数が増えても一覧を見渡せるようにする）
    expect(screen.queryByLabelText('素材')).not.toBeInTheDocument()
  })

  test('見出しを押すと入力欄が開き、もう一度押すと閉じる', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いたトリガー()
    expect(row.getByLabelText('素材')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^1番目のトリガー:/ }))

    expect(screen.queryByLabelText('素材')).not.toBeInTheDocument()
  })

  test('別のトリガーを開くと、先に開いていたトリガーは閉じる', async () => {
    const トリガー2件: StoredTrigger[] = [
      拍手のトリガー,
      { event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: 'ありがとうございます' }] },
    ]
    render(トリガーのページ(代役のAPI({ config: async () => トリガー2件 })))

    await 開いたトリガー(1)
    const フォローのトリガー = await 開いたトリガー(2)

    expect(フォローのトリガー.getByLabelText('チャットに送る文言')).toBeInTheDocument()
    expect(screen.queryByLabelText('素材')).not.toBeInTheDocument()
  })

  test('足したトリガーは、すぐ書き換えられるよう開いた状態で出る', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [] })))

    await userEvent.click(await screen.findByRole('button', { name: 'トリガーを足す' }))

    expect(within(screen.getByRole('listitem', { name: '1番目のトリガー' })).getByLabelText('イベント')).toBeInTheDocument()
  })

  test('折りたたんだままでもトリガーを外せる', async () => {
    render(トリガーのページ(代役のAPI()))

    await userEvent.click(await screen.findByRole('button', { name: '1番目のトリガーを外す' }))

    expect(screen.getByText('トリガーはまだありません。')).toBeInTheDocument()
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
    // 保存済みの報酬はTwitchの一覧にないものとして選択肢に残る（黙って別の報酬に変えない）
    expect((await 開いたトリガー()).getByLabelText('報酬')).toHaveValue('reward-hakushu')
  })
})
