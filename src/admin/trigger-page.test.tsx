// @vitest-environment jsdom
/**
 * トリガーのページ（OBS用のURL・トリガー）のテスト
 *
 * 確かめること:
 * - OBS用のURLを伏せ字で出し、コピーとキーの再発行ができること（再発行は確認してから）
 * - URL欄に、ブラウザソースへ設定する推奨の幅と高さが添えられること
 * - トリガーは折りたたんで並び、見出しの要約を押すと入力欄が開くこと（開くのは1件ずつ）
 * - きっかけを既定メニューから選んでトリガーを足せること（イベント種別と条件は画面から組み立てない）
 * - メニュー項目が要求するパラメータ（報酬・ユーザー名・言葉・日数・広告の絞り込み）を書き換えられること
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
import type { BotStatus } from '@/bot/api'

/** 接続済みのbotアカウント */
const 接続済みのbot: BotStatus = { userId: 'bot-user-id', login: 'haishinsha_bot', missingScopes: [], isModerator: true }

const 拍手の動画: MediaItem = { id: 'media-hakushu', name: '拍手.webm', kind: 'video', contentType: 'video/webm', size: 2 * 1024 * 1024, uploadedAt: '2026-09-01T00:00:00Z' }
const 花火の画像: MediaItem = { id: 'media-hanabi', name: '花火.png', kind: 'image', contentType: 'image/png', size: 2048, uploadedAt: '2026-09-02T00:00:00Z' }
const 拍手の報酬: Reward = { id: 'reward-hakushu', title: '拍手を送る', cost: 100 }
const 拍手のトリガー: StoredTrigger = {
  kind: 'reward',
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

/** botの接続状態を返すWorkerの代役。既定では接続済み */
const 代役のBotAPI = (status: () => Promise<BotStatus | null> = async () => 接続済みのbot) => ({ status: vi.fn(status) })

const トリガーのページ = (api: AdminApi, props: Partial<React.ComponentProps<typeof TriggerPage>> = {}) => (
  <TriggerPage api={api} botApi={代役のBotAPI()} overlayKey="ima-no-key" onOverlayKeyChange={() => {}} {...props} />
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

/** 既定メニューから項目を選んでトリガーを足す */
const メニューから足す = async (label: string): Promise<void> => {
  await userEvent.click(await screen.findByRole('button', { name: 'トリガーを足す' }))
  await userEvent.click(await screen.findByRole('menuitem', { name: new RegExp(label) }))
}

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

  test('URL欄に、ブラウザソースへ設定する推奨の幅と高さを添える', async () => {
    render(トリガーのページ(代役のAPI()))

    expect(await screen.findByText('推奨の大きさ: 幅 1920 × 高さ 1080 px（配信のキャンバスと同じ大きさ）')).toBeInTheDocument()
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
    expect(row.getByLabelText('対象の報酬')).toHaveValue('reward-hakushu')
    expect(row.getByLabelText('素材')).toHaveValue('media-hakushu')
    expect(row.getByLabelText('表示時間（1〜60秒）')).toHaveValue(8)
    expect(スライダー('音量', row)).toHaveValue('50')
    expect(row.getByLabelText('文言（空欄なら出さない）')).toHaveValue('{user} さんが拍手を送りました')
  })

  test('きっかけは後から変えられない（イベントの選択欄を出さない）', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いたトリガー()

    // メニュー項目が決まればイベント種別と条件も決まるので、画面からは組み立てさせない
    expect(row.queryByLabelText('イベント')).not.toBeInTheDocument()
    expect(row.getByText('チャンネルポイントが交換された')).toBeInTheDocument()
  })

  test('報酬を選び直して保存すると、その報酬IDで送る', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.selectOptions(row.getByLabelText('対象の報酬'), '')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([expect.objectContaining({ kind: 'reward', rewardId: null })])
  })

  test('報酬の選択欄には「すべての報酬」が並び、絞り込まないトリガーではそれが選ばれている', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [{ ...拍手のトリガー, rewardId: null }] })))

    const row = await 開いたトリガー()

    expect(row.getByLabelText('対象の報酬')).toHaveValue('')
    expect(row.getByRole('option', { name: 'すべての報酬' })).toBeInTheDocument()
  })

  test('決まった人が発言したトリガーは、ユーザー名を書き換えて保存できる', async () => {
    const api = 代役のAPI({ config: async () => [{ kind: 'chatFromUser', login: 'tanenobu', actions: [{ type: 'chat', message: 'やあ' }] }] })
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    expect(row.getByLabelText('対象のユーザー名')).toHaveValue('tanenobu')
    await userEvent.clear(row.getByLabelText('対象のユーザー名'))
    await userEvent.type(row.getByLabelText('対象のユーザー名'), 'yamada_hanako')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(api.saveConfig).toHaveBeenCalledWith([{ kind: 'chatFromUser', login: 'yamada_hanako', actions: [{ type: 'chat', message: 'やあ' }] }])
  })

  test('決まった言葉を含む発言のトリガーは、言葉を書き換えて保存できる', async () => {
    const api = 代役のAPI({ config: async () => [{ kind: 'chatContains', contains: 'おはよう', actions: [{ type: 'chat', message: 'おはよう！' }] }] })
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.clear(row.getByLabelText('発言に含まれる言葉'))
    await userEvent.type(row.getByLabelText('発言に含まれる言葉'), 'こんばんは')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(api.saveConfig).toHaveBeenCalledWith([expect.objectContaining({ kind: 'chatContains', contains: 'こんばんは' })])
  })

  test('久しぶりの人が発言したトリガーは、日数を書き換えて保存できる', async () => {
    const api = 代役のAPI({ config: async () => [{ kind: 'returningAfter', days: 30, actions: [{ type: 'chat', message: 'お久しぶり' }] }] })
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    fireEvent.change(row.getByLabelText('前の発言から空いた日数'), { target: { value: '60' } })
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(api.saveConfig).toHaveBeenCalledWith([expect.objectContaining({ kind: 'returningAfter', days: 60 })])
  })

  test('日数を空欄にして保存しようとしたら、数を入れるよう知らせる（0日として送ってしまわないため）', async () => {
    const api = 代役のAPI({ config: async () => [{ kind: 'returningAfter', days: 30, actions: [{ type: 'chat', message: 'お久しぶり' }] }] })
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.clear(row.getByLabelText('前の発言から空いた日数'))
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('日数を数で入力してください')).toBeInTheDocument()
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  test('広告のトリガーは、自動・手動の絞り込みを選んで保存できる', async () => {
    const api = 代役のAPI({ config: async () => [{ kind: 'adBreakEnd', automatic: true, actions: [{ type: 'chat', message: 'おかえりなさい' }] }] })
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    expect(row.getByLabelText('対象の広告')).toHaveValue('true')
    await userEvent.selectOptions(row.getByLabelText('対象の広告'), '')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(api.saveConfig).toHaveBeenCalledWith([expect.objectContaining({ kind: 'adBreakEnd', automatic: null })])
  })

  test('パラメータを持たないメニュー項目では、入力欄の代わりに何をきっかけにするかの補足を出す', async () => {
    const 初見のトリガー: StoredTrigger = { kind: 'firstChatEver', actions: [{ type: 'chat', message: 'はじめまして' }] }
    render(トリガーのページ(代役のAPI({ config: async () => [初見のトリガー] })))

    const row = await 開いたトリガー()

    expect(row.getByText('このチャンネルで初めての人が発言した')).toBeInTheDocument()
    expect(row.getByText(/記録が残っていない人/)).toBeInTheDocument()
  })

  test('チャットの発言をきっかけにするトリガーでは、差し込み語に {message} を出す', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [{ kind: 'chat', actions: [{ type: 'chat', message: 'やあ' }] }] })))

    const row = await 開いたトリガー()

    expect(row.getByText(/\{user\}/)).toHaveTextContent('{message}')
  })

  test('メニューは「視聴者・応援・配信」に分かれ、選ぶとその項目のトリガーが足される', async () => {
    const api = 代役のAPI({ config: vi.fn(async () => []) })
    render(トリガーのページ(api))

    await userEvent.click(await screen.findByRole('button', { name: 'トリガーを足す' }))
    // メニューの中身は開いたあとに差し込まれるので、出そろうのを待ってから確かめる
    expect(await screen.findByText('視聴者')).toBeInTheDocument()
    expect(screen.getByText('応援')).toBeInTheDocument()
    expect(screen.getByText('配信')).toBeInTheDocument()

    await userEvent.click(await screen.findByRole('menuitem', { name: /フォローされた/ }))

    expect(await お知らせ('「フォローされた」のトリガーを足しました')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^1番目のトリガー:/ })).toHaveTextContent('フォローされた')
  })

  test('トリガーを足して書き換え、Workerへ送る形で保存する', async () => {
    const api = 代役のAPI({ config: vi.fn(async () => []) })
    render(トリガーのページ(api))

    await メニューから足す('チャンネルポイントが交換された')
    const row = within(screen.getByRole('listitem', { name: '1番目のトリガー' }))
    await userEvent.selectOptions(row.getByLabelText('素材'), 'media-hanabi')
    fireEvent.change(row.getByLabelText('表示時間（1〜60秒）'), { target: { value: '12' } })
    fireEvent.change(スライダー('音量', row), { target: { value: '30' } })
    await userEvent.type(row.getByLabelText('文言（空欄なら出さない）'), 'ありがとう')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      { kind: 'reward', rewardId: null, actions: [{ type: 'alert', mediaId: 'media-hanabi', durationSeconds: 12, volume: 0.3, message: 'ありがとう' }] },
    ])
  })

  test('素材が1つもなければ、チャットに送るだけのトリガーとして足す', async () => {
    render(トリガーのページ(代役のAPI({ media: async () => [], config: async () => [] })))

    await メニューから足す('フォローされた')

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
        kind: 'reward',
        rewardId: 'reward-hakushu',
        actions: [{ type: 'chat', message: '{user} さん、ありがとうございます' }],
      },
    ])
  })

  test('LLMへの指示を入れて保存すると、aiChat の動作として送る', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))
    await userEvent.click(row.getByRole('checkbox', { name: 'AIに文面を作らせて送る' }))
    await userEvent.type(row.getByLabelText('AIへの指示'), '初めて来てくれた人を歓迎してください')
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        kind: 'reward',
        rewardId: 'reward-hakushu',
        actions: [{ type: 'aiChat', instruction: '初めて来てくれた人を歓迎してください' }],
      },
    ])
  })

  test('「チャットに送る」と「AIに文面を作らせて送る」は同時に選べない（同じ発言に2通返ってしまうため）', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('checkbox', { name: 'チャットに送る' }))
    await userEvent.click(row.getByRole('checkbox', { name: 'AIに文面を作らせて送る' }))

    expect(row.getByRole('checkbox', { name: 'AIに文面を作らせて送る' })).toBeChecked()
    expect(row.getByRole('checkbox', { name: 'チャットに送る' })).not.toBeChecked()
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
        kind: 'reward',
        rewardId: 'reward-hakushu',
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
    const チャットだけのトリガー: StoredTrigger = { kind: 'follow', actions: [{ type: 'chat', message: 'ありがとうございます' }] }
    const api = 代役のAPI({ config: vi.fn(async () => [チャットだけのトリガー]) })
    render(トリガーのページ(api))

    const row = await 開いたトリガー()
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))
    await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        kind: 'follow',
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
  test('保存済みのトリガーは折りたたんで並び、見出しに「きっかけ・絞り込み・動作」の要約を出す', async () => {
    render(トリガーのページ(代役のAPI()))

    expect(await screen.findByRole('button', { name: /^1番目のトリガー:/ })).toHaveTextContent('チャンネルポイントが交換された（拍手を送る）→ アラート')
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
      { kind: 'follow', actions: [{ type: 'chat', message: 'ありがとうございます' }] },
    ]
    render(トリガーのページ(代役のAPI({ config: async () => トリガー2件 })))

    await 開いたトリガー(1)
    const フォローのトリガー = await 開いたトリガー(2)

    expect(フォローのトリガー.getByLabelText('チャットに送る文言')).toBeInTheDocument()
    expect(screen.queryByLabelText('素材')).not.toBeInTheDocument()
  })

  test('足したトリガーは、すぐ書き換えられるよう開いた状態で出る', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [] })))

    await メニューから足す('フォローされた')

    expect(within(screen.getByRole('listitem', { name: '1番目のトリガー' })).getByRole('checkbox', { name: 'アラートを出す' })).toBeInTheDocument()
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

describe('botの接続状態', () => {
  test('botが未接続なら、チャットとアナウンスの動作が動かないことを知らせる', async () => {
    render(トリガーのページ(代役のAPI(), { botApi: 代役のBotAPI(async () => null) }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('botが接続されていません')
    // チャットの発言のトリガーは、Workerが発言そのものを受け取れない（購読の条件にbotのユーザーIDが要る）
    expect(alert).toHaveTextContent('チャットの発言')
    expect(within(alert).getByRole('link', { name: 'チャットボット' })).toHaveAttribute('href', '/bot/')
  })

  test('botが接続済みなら、その知らせは出さない', async () => {
    render(トリガーのページ(代役のAPI()))

    expect(await screen.findByRole('button', { name: 'トリガーを足す' })).toBeInTheDocument()
    expect(screen.queryByText(/botが接続されていません/)).not.toBeInTheDocument()
  })

  test('接続状態を取得できなければ、未接続扱いにせず理由を出す', async () => {
    const botApi = 代役のBotAPI(async () => {
      throw new Error('Workerに接続できません')
    })
    render(トリガーのページ(代役のAPI(), { botApi }))

    expect(await screen.findByRole('alert')).toHaveTextContent('botの接続状態を取得できませんでした: Workerに接続できません')
    expect(screen.queryByText(/botが接続されていません/)).not.toBeInTheDocument()
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
    await メニューから足す('フォローされた')
    expect(await お知らせ('のトリガーを足しました')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('チャンネルポイント報酬の一覧を取得できませんでした')
    // 保存済みの報酬はTwitchの一覧にないものとして選択肢に残る（黙って別の報酬に変えない）
    expect((await 開いたトリガー()).getByLabelText('対象の報酬')).toHaveValue('reward-hakushu')
  })
})
