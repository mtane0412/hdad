// @vitest-environment jsdom
/**
 * トリガーのページ（OBS用のURL・トリガー）のテスト
 *
 * 確かめること:
 * - OBS用のURLを伏せ字で出し、コピーとキーの再発行ができること（再発行は確認してから）
 * - URL欄に、ブラウザソースへ設定する推奨の幅と高さが添えられること
 * - トリガーは折りたたんで並び、見出しの要約を押すと入力欄が開くこと（開くのは1件ずつ）
 * - どの項目も同じ枠に入って並び、効果はバッジで出ること（複数の設定を持てる項目だけ見た目が変わらない）
 * - 区分（チャット・イベント）を畳めること
 * - 広告の開始と終了を1つの枠で設定でき、対象の広告（自動・手動）は両方で共通になること
 * - 未保存の変更があることを知らせること
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

/**
 * 1行だけの項目（絞り込みのパラメータを持たない項目）を開き、その中だけを探せるようにする。
 *
 * 行の見出しは「項目の名前 + 効果の要約」なので、名前で押せる。
 */
const 開いた項目 = async (label: string) => {
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${label}`) }))
  return within(screen.getByRole('listitem', { name: label }))
}

/** 複数の設定を持てる項目の、position番目の設定を開く */
const 開いた設定 = async (item: string, position = 1) => {
  const label = `${item}の${position}番目の設定`
  // 見出しの読み上げは「<行の呼び名>:<要約>」なので、コロンまでを目印にする（「…を外す」ボタンと取り違えないため）
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(`^${label}:`) }))
  return within(screen.getByRole('listitem', { name: label }))
}

/** 開閉を変えずに、その設定の中だけを探せるようにする（足した直後の行はすでに開いている） */
const 設定の行 = (item: string, position = 1) => within(screen.getByRole('listitem', { name: `${item}の${position}番目の設定` }))

/** メニュー項目1つぶんの枠。1行だけの項目も複数の設定を持てる項目も、同じ枠で並ぶ */
const 項目の枠 = (label: string): Promise<HTMLElement> => screen.findByRole('listitem', { name: label })

/** 複数の設定を持てる項目に、設定を1つ足す */
const 設定を足す = async (label: string): Promise<void> => {
  await userEvent.click(await screen.findByRole('button', { name: label }))
}

const 保存する = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: 'トリガーを保存' }))
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

describe('一覧', () => {
  test('配信で起きる出来事が、区分ごとに最初から並ぶ（トリガーを作る操作はない）', async () => {
    render(トリガーのページ(代役のAPI()))

    expect(await screen.findByRole('region', { name: 'チャット' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'イベント' })).toBeInTheDocument()
    // 配信者はトリガーを作らず、並んでいる出来事に効果を足していく
    expect(screen.queryByRole('button', { name: 'トリガーを足す' })).not.toBeInTheDocument()
  })

  test('効果をひとつも付けていない項目も並び、何も起きないことが分かる', async () => {
    render(トリガーのページ(代役のAPI()))

    expect(within(await 項目の枠('フォローされた')).getByText('効果なし')).toBeInTheDocument()
  })

  test('効果を付けてある項目は、付けた効果をバッジで出す（要約の文を読まなくても分かるようにする）', async () => {
    const 挨拶とアナウンス: StoredTrigger = {
      kind: 'follow',
      actions: [
        { type: 'chat', message: 'ありがとう' },
        { type: 'announce', message: 'フォローありがとう', color: 'purple' },
      ],
    }
    render(トリガーのページ(代役のAPI({ config: async () => [挨拶とアナウンス] })))

    const 枠 = within(await 項目の枠('フォローされた'))
    expect(枠.getByText('チャット')).toBeInTheDocument()
    expect(枠.getByText('アナウンス')).toBeInTheDocument()
    expect(枠.queryByText('効果なし')).not.toBeInTheDocument()
  })

  test('複数の設定を持てる項目も、1行だけの項目と同じ枠に入れて並べる（見た目が2種類に分かれないようにする）', async () => {
    render(トリガーのページ(代役のAPI()))

    // 枠の中に、項目の名前・設定の行・設定を足すボタンがすべて入る
    const 枠 = within(await 項目の枠('チャンネルポイントが交換された'))
    expect(枠.getByRole('listitem', { name: 'チャンネルポイントが交換されたの1番目の設定' })).toBeInTheDocument()
    expect(枠.getByRole('button', { name: '報酬を足す' })).toBeInTheDocument()
  })

  test('どの項目にも、何をきっかけにするかの説明を添える', async () => {
    render(トリガーのページ(代役のAPI()))

    // 1行だけの項目（フォロー）でも、複数の設定を持てる項目（報酬）と同じように説明を出す
    expect(within(await 項目の枠('フォローされた')).getByText('新しくフォローされたとき')).toBeInTheDocument()
    expect(within(await 項目の枠('チャンネルポイントが交換された')).getByText(/報酬ごとに違う効果を付けられる/)).toBeInTheDocument()
  })

  test('1行だけの項目は外せない（効果をすべて外せば何も起きないため）', async () => {
    render(トリガーのページ(代役のAPI()))

    await 開いた項目('フォローされた')

    expect(screen.queryByRole('button', { name: 'フォローされたを外す' })).not.toBeInTheDocument()
  })

  test('1行しか持てない項目に設定が2つ保存されていたら、両方を出して外せるようにする（画面に出ていない設定が保存され続けないため）', async () => {
    // 画面からは作れない形だが、KVを手で直したり古い設定を入れ直したりすると起こりうる。
    // 1つ目だけを出すと、2つ目は見えないまま保存され続けてしまう
    const 二重のフォロー = async (): Promise<StoredTrigger[]> => [
      { kind: 'follow', actions: [{ type: 'chat', message: '1つ目' }] },
      { kind: 'follow', actions: [{ type: 'chat', message: '2つ目' }] },
    ]
    render(トリガーのページ(代役のAPI({ config: 二重のフォロー })))

    expect(await screen.findByText(/設定が2つ以上保存されています/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'フォローされたの1番目の設定を外す' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'フォローされたの2番目の設定を外す' })).toBeInTheDocument()
  })

  test('絞り込みのパラメータを持つ項目は、保存済みの設定がなければ行を並べず、足すボタンだけを出す', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [] })))

    expect(await screen.findByRole('button', { name: '報酬を足す' })).toBeInTheDocument()
    expect(screen.queryByRole('listitem', { name: 'チャンネルポイントが交換されたの1番目の設定' })).not.toBeInTheDocument()
  })

  test('項目に添えた注意書きを出す（初めての人の扱い）', async () => {
    render(トリガーのページ(代役のAPI()))

    expect(await screen.findByText(/記録が残っていない人/)).toBeInTheDocument()
  })
})

describe('効果の付け外し', () => {
  test('効果を付けて保存すると、その出来事のトリガーとしてWorkerへ送る', async () => {
    const api = 代役のAPI({ config: vi.fn(async () => []) })
    render(トリガーのページ(api))

    const row = await 開いた項目('フォローされた')
    await userEvent.click(row.getByRole('checkbox', { name: 'チャットに送る' }))
    await userEvent.type(row.getByLabelText('チャットに送る文言'), 'ありがとう')
    await 保存する()

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(api.saveConfig).toHaveBeenCalledWith([{ kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }])
  })

  test('効果をひとつも付けていない行は送らない（並んでいるだけの行を保存しない）', async () => {
    const api = 代役のAPI({ config: vi.fn(async () => []) })
    render(トリガーのページ(api))

    await 項目の枠('フォローされた')
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([])
  })

  test('効果をすべて外して保存すると、その出来事のトリガーは送られなくなる', async () => {
    const api = 代役のAPI({ config: vi.fn(async (): Promise<StoredTrigger[]> => [{ kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }]) })
    render(トリガーのページ(api))

    const row = await 開いた項目('フォローされた')
    await userEvent.click(row.getByRole('checkbox', { name: 'チャットに送る' }))
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([])
  })

  test('アラートを出す効果を付けると、選択欄に見えている最初の素材で保存する', async () => {
    // 素材が未選択（空文字）のまま保存すると、選択欄には最初の素材が見えているのにWorkerが「素材が存在しません」と拒否してしまう
    const api = 代役のAPI({ config: vi.fn(async () => []) })
    render(トリガーのページ(api))

    const row = await 開いた項目('フォローされた')
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([
      { kind: 'follow', actions: [{ type: 'alert', mediaId: 'media-hakushu', durationSeconds: 5, volume: 1, message: '' }] },
    ])
  })

  test('アラートの素材・表示時間・音量・文言を書き換えて保存できる', async () => {
    const api = 代役のAPI()
    render(トリガーのページ(api))

    const row = await 開いた設定('チャンネルポイントが交換された')
    await userEvent.selectOptions(row.getByLabelText('素材'), 'media-hanabi')
    fireEvent.change(row.getByLabelText('表示時間（1〜60秒）'), { target: { value: '12' } })
    fireEvent.change(スライダー('音量', row), { target: { value: '30' } })
    await userEvent.clear(row.getByLabelText('文言（空欄なら出さない）'))
    await userEvent.type(row.getByLabelText('文言（空欄なら出さない）'), 'ありがとう')
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([
      {
        kind: 'reward',
        rewardId: 'reward-hakushu',
        actions: [{ type: 'alert', mediaId: 'media-hanabi', durationSeconds: 12, volume: 0.3, message: 'ありがとう' }],
      },
    ])
  })

  test('保存済みの効果を入力欄に出す（音量は百分率）', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いた設定('チャンネルポイントが交換された')
    expect(row.getByLabelText('対象の報酬')).toHaveValue('reward-hakushu')
    expect(row.getByLabelText('素材')).toHaveValue('media-hakushu')
    expect(row.getByLabelText('表示時間（1〜60秒）')).toHaveValue(8)
    expect(スライダー('音量', row)).toHaveValue('50')
    expect(row.getByLabelText('文言（空欄なら出さない）')).toHaveValue('{user} さんが拍手を送りました')
  })

  test('アラートを出すを外すと、素材や表示時間の入力欄を隠す', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いた設定('チャンネルポイントが交換された')
    await userEvent.click(row.getByRole('checkbox', { name: 'アラートを出す' }))

    expect(row.queryByLabelText('素材')).not.toBeInTheDocument()
    expect(row.queryByLabelText('表示時間（1〜60秒）')).not.toBeInTheDocument()
  })

  test('LLMへの指示を入れて保存すると、aiChat の効果として送る', async () => {
    const api = 代役のAPI({ config: vi.fn(async () => []) })
    render(トリガーのページ(api))

    const row = await 開いた項目('初めて来た人の発言')
    await userEvent.click(row.getByRole('checkbox', { name: 'AIに文面を作らせて送る' }))
    await userEvent.type(row.getByLabelText('AIへの指示'), '初めて来てくれた人を歓迎してください')
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([{ kind: 'newViewer', actions: [{ type: 'aiChat', instruction: '初めて来てくれた人を歓迎してください' }] }])
  })

  test('「チャットに送る」と「AIに文面を作らせて送る」は同時に選べない（同じ発言に2通返ってしまうため）', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いた項目('フォローされた')
    await userEvent.click(row.getByRole('checkbox', { name: 'チャットに送る' }))
    await userEvent.click(row.getByRole('checkbox', { name: 'AIに文面を作らせて送る' }))

    expect(row.getByRole('checkbox', { name: 'AIに文面を作らせて送る' })).toBeChecked()
    expect(row.getByRole('checkbox', { name: 'チャットに送る' })).not.toBeChecked()
  })

  test('アナウンスを送る文言と色を入れて保存すると、アナウンスの効果として送る', async () => {
    const api = 代役のAPI({ config: vi.fn(async () => []) })
    render(トリガーのページ(api))

    const row = await 開いた項目('レイドされた')
    await userEvent.click(row.getByRole('checkbox', { name: 'アナウンスを送る' }))
    await userEvent.type(row.getByLabelText('アナウンスの文言'), 'レイドありがとう')
    await userEvent.selectOptions(row.getByLabelText('アナウンスの色'), 'purple')
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([{ kind: 'raid', actions: [{ type: 'announce', message: 'レイドありがとう', color: 'purple' }] }])
  })

  test('アナウンスを送るを外していれば、文言の入力欄を隠す', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いた項目('フォローされた')

    expect(row.queryByLabelText('アナウンスの文言')).not.toBeInTheDocument()
  })

  test('チャットの発言をきっかけにする項目では、差し込み語に {message} を出す', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いた項目('すべての発言')

    expect(row.getByText(/\{user\}/)).toHaveTextContent('{message}')
  })
})

describe('絞り込みのパラメータ', () => {
  test('報酬を足すと設定が増え、報酬ごとに違う効果を付けられる', async () => {
    const api = 代役のAPI({ config: vi.fn(async () => []) })
    render(トリガーのページ(api))

    // 足した設定はそのまま開いた状態で出るので、押して開き直さない
    await 設定を足す('報酬を足す')
    await userEvent.selectOptions(設定の行('チャンネルポイントが交換された', 1).getByLabelText('対象の報酬'), 'reward-hakushu')
    await 設定を足す('報酬を足す')
    await userEvent.selectOptions(設定の行('チャンネルポイントが交換された', 2).getByLabelText('対象の報酬'), '')
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'reward', rewardId: 'reward-hakushu' }),
      expect.objectContaining({ kind: 'reward', rewardId: null }),
    ])
  })

  test('足した設定は外せる', async () => {
    render(トリガーのページ(代役のAPI()))

    await userEvent.click(await screen.findByRole('button', { name: 'チャンネルポイントが交換されたの1番目の設定を外す' }))

    expect(screen.queryByRole('listitem', { name: 'チャンネルポイントが交換されたの1番目の設定' })).not.toBeInTheDocument()
  })

  test('報酬の選択欄には「すべての報酬」が並び、絞り込まない設定ではそれが選ばれている', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [{ ...拍手のトリガー, rewardId: null }] })))

    const row = await 開いた設定('チャンネルポイントが交換された')

    expect(row.getByLabelText('対象の報酬')).toHaveValue('')
    expect(row.getByRole('option', { name: 'すべての報酬' })).toBeInTheDocument()
  })

  test('決まった人が発言した設定は、ユーザー名を書き換えて保存できる', async () => {
    const api = 代役のAPI({ config: async (): Promise<StoredTrigger[]> => [{ kind: 'fromUser', login: 'tanenobu', actions: [{ type: 'chat', message: 'やあ' }] }] })
    render(トリガーのページ(api))

    const row = await 開いた設定('決まった人の発言')
    await userEvent.clear(row.getByLabelText('対象のユーザー名'))
    await userEvent.type(row.getByLabelText('対象のユーザー名'), 'yamada_hanako')
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([{ kind: 'fromUser', login: 'yamada_hanako', actions: [{ type: 'chat', message: 'やあ' }] }])
  })

  test('決まった言葉を含む発言の設定は、言葉を書き換えて保存できる', async () => {
    const api = 代役のAPI({ config: async (): Promise<StoredTrigger[]> => [{ kind: 'keyword', contains: 'おはよう', actions: [{ type: 'chat', message: 'おはよう！' }] }] })
    render(トリガーのページ(api))

    const row = await 開いた設定('決まった言葉を含む発言')
    await userEvent.clear(row.getByLabelText('発言に含まれる言葉'))
    await userEvent.type(row.getByLabelText('発言に含まれる言葉'), 'こんばんは')
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([expect.objectContaining({ kind: 'keyword', contains: 'こんばんは' })])
  })

  test('久しぶりの人が発言した設定は、日数を書き換えて保存できる', async () => {
    const api = 代役のAPI({ config: async (): Promise<StoredTrigger[]> => [{ kind: 'comeback', days: 30, actions: [{ type: 'chat', message: 'お久しぶり' }] }] })
    render(トリガーのページ(api))

    const row = await 開いた項目('久しぶりの人の発言')
    fireEvent.change(row.getByLabelText('前の発言から空いた日数'), { target: { value: '60' } })
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([expect.objectContaining({ kind: 'comeback', days: 60 })])
  })

  test('日数を空欄にして保存しようとしたら、どの項目かを添えて数を入れるよう知らせる', async () => {
    const api = 代役のAPI({ config: async (): Promise<StoredTrigger[]> => [{ kind: 'comeback', days: 30, actions: [{ type: 'chat', message: 'お久しぶり' }] }] })
    render(トリガーのページ(api))

    const row = await 開いた項目('久しぶりの人の発言')
    await userEvent.clear(row.getByLabelText('前の発言から空いた日数'))
    await 保存する()

    expect(await お知らせ('「久しぶりの人の発言」の設定: 日数を数で入力してください')).toBeInTheDocument()
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  test('広告の開始と終了は1つの枠にまとまり、対象の広告は両方で共通になる', async () => {
    const api = 代役のAPI({ config: async (): Promise<StoredTrigger[]> => [{ kind: 'adBreakEnd', automatic: true, actions: [{ type: 'chat', message: 'おかえりなさい' }] }] })
    render(トリガーのページ(api))

    const row = await 開いた項目('広告')
    // 絞り込みは開始と終了で1つしかないので、入力欄も1つだけ出す
    expect(row.getByLabelText('対象の広告')).toHaveValue('true')
    await userEvent.selectOptions(row.getByLabelText('対象の広告'), '')
    await 保存する()

    // 開始には効果が付いていないので送られず、終了だけが送られる。絞り込みの変更は両方に効く
    expect(api.saveConfig).toHaveBeenCalledWith([expect.objectContaining({ kind: 'adBreakEnd', automatic: null })])
  })

  test('広告の開始と終了には、別々の効果を付けられる', async () => {
    const api = 代役のAPI({ config: async () => [] })
    render(トリガーのページ(api))

    const row = await 開いた項目('広告')
    const 開始 = within(row.getByRole('group', { name: '広告が始まったときの効果' }))
    const 終了 = within(row.getByRole('group', { name: '広告が終わったときの効果' }))
    await userEvent.click(開始.getByRole('checkbox', { name: 'チャットに送る' }))
    await userEvent.type(開始.getByLabelText('チャットに送る文言'), '{{duration}秒の広告が入ります')
    await userEvent.click(終了.getByRole('checkbox', { name: 'アナウンスを送る' }))
    await userEvent.type(終了.getByLabelText('アナウンスの文言'), 'おかえりなさい')
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([
      { kind: 'adBreakBegin', automatic: null, actions: [{ type: 'chat', message: '{duration}秒の広告が入ります' }] },
      { kind: 'adBreakEnd', automatic: null, actions: [{ type: 'announce', message: 'おかえりなさい', color: 'primary' }] },
    ])
  })

  test('広告の開始と終了で絞り込みが食い違って保存されていたら、黙って片方に寄せず知らせる', async () => {
    // 開始と終了が別々の項目だったころに保存された設定では、食い違いが起こりうる。
    // 画面の絞り込みの入力欄は1つしかないので、保存すると片方の値に寄ってしまう
    const 食い違い: StoredTrigger[] = [
      { kind: 'adBreakBegin', automatic: true, actions: [{ type: 'chat', message: '広告が入ります' }] },
      { kind: 'adBreakEnd', automatic: false, actions: [{ type: 'chat', message: 'おかえりなさい' }] },
    ]
    render(トリガーのページ(代役のAPI({ config: async () => 食い違い })))

    expect(within(await 項目の枠('広告')).getByText(/対象の広告が食い違って保存されています/)).toBeInTheDocument()
  })

  test('食い違ったまま保存しても、勝手に片方へ寄せない（選び直したときだけ揃える）', async () => {
    const 食い違い: StoredTrigger[] = [
      { kind: 'adBreakBegin', automatic: true, actions: [{ type: 'chat', message: '広告が入ります' }] },
      { kind: 'adBreakEnd', automatic: false, actions: [{ type: 'chat', message: 'おかえりなさい' }] },
    ]
    const api = 代役のAPI({ config: async () => 食い違い })
    render(トリガーのページ(api))

    await 項目の枠('広告')
    await 保存する()

    expect(api.saveConfig).toHaveBeenCalledWith([
      expect.objectContaining({ kind: 'adBreakBegin', automatic: true }),
      expect.objectContaining({ kind: 'adBreakEnd', automatic: false }),
    ])
  })

  test('広告の見出しでは、効果のバッジがどちらのときのものか分かる', async () => {
    const 終了だけ: StoredTrigger = { kind: 'adBreakEnd', automatic: true, actions: [{ type: 'chat', message: 'おかえりなさい' }] }
    render(トリガーのページ(代役のAPI({ config: async () => [終了だけ] })))

    const 枠 = within(await 項目の枠('広告'))
    expect(枠.getByText('終了')).toBeInTheDocument()
    expect(枠.getByText('チャット')).toBeInTheDocument()
    // 開始には効果が付いていないので、開始のバッジは出さない
    expect(枠.queryByText('開始')).not.toBeInTheDocument()
  })
})

describe('保存', () => {
  test('保存する順は一覧の並びにそろえる（あとから足した設定でも並びが崩れない）', async () => {
    const api = 代役のAPI({ config: vi.fn(async (): Promise<StoredTrigger[]> => [{ kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }]) })
    render(トリガーのページ(api))

    await 設定を足す('言葉を足す')
    await 保存する()

    // 「決まった言葉を含む発言があった」はチャットの区分、「フォローされた」はイベントの区分なので、言葉が先に来る
    expect(api.saveConfig).toHaveBeenCalledWith([expect.objectContaining({ kind: 'keyword' }), expect.objectContaining({ kind: 'follow' })])
  })

  test('Workerが設定の問題点を返したら、どの項目の設定かに読み替えて並べる', async () => {
    const api = 代役のAPI({
      config: vi.fn(async (): Promise<StoredTrigger[]> => [{ kind: 'comeback', days: 30, actions: [{ type: 'chat', message: 'お久しぶり' }] }]),
      saveConfig: vi.fn(async () => {
        throw new ApiError(400, 'invalid_config', '設定に問題があります', ['triggers[0].days: 1〜365の整数（日数）で指定してください'])
      }),
    })
    render(トリガーのページ(api))

    await screen.findByRole('button', { name: /^久しぶりの人の発言/ })
    await 保存する()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('トリガーの設定に問題があります')
    expect(alert).toHaveTextContent('「久しぶりの人の発言」の設定の days: 1〜365の整数（日数）で指定してください')
  })
})

describe('未保存の変更', () => {
  test('入力を変えると未保存だと知らせ、保存すると消える（一覧の一番下まで見なくても分かるようにする）', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [], saveConfig: async () => [] })))

    const row = await 開いた項目('フォローされた')
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()

    await userEvent.click(row.getByRole('checkbox', { name: 'チャットに送る' }))

    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()

    await 保存する()

    expect(await お知らせ('トリガーを保存しました')).toBeInTheDocument()
    expect(screen.queryByText('未保存の変更があります')).not.toBeInTheDocument()
  })

  test('設定を足しただけでも未保存だと知らせる（足しただけでは保存されないため）', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [] })))

    await 設定を足す('言葉を足す')

    expect(screen.getByText('未保存の変更があります')).toBeInTheDocument()
  })
})

describe('折りたたみ', () => {
  test('開くまでは入力欄を出さない（一覧を見渡せるようにする）', async () => {
    render(トリガーのページ(代役のAPI()))

    expect(await screen.findByRole('button', { name: /^チャンネルポイントが交換されたの1番目の設定:/ })).toBeInTheDocument()
    expect(screen.queryByLabelText('素材')).not.toBeInTheDocument()
  })

  test('見出しを押すと入力欄が開き、もう一度押すと閉じる', async () => {
    render(トリガーのページ(代役のAPI()))

    const row = await 開いた設定('チャンネルポイントが交換された')
    expect(row.getByLabelText('素材')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^チャンネルポイントが交換されたの1番目の設定:/ }))

    expect(screen.queryByLabelText('素材')).not.toBeInTheDocument()
  })

  test('別の行を開くと、先に開いていた行は閉じる', async () => {
    render(トリガーのページ(代役のAPI()))

    await 開いた設定('チャンネルポイントが交換された')
    const フォロー = await 開いた項目('フォローされた')

    expect(フォロー.getByRole('checkbox', { name: 'アラートを出す' })).toBeInTheDocument()
    expect(screen.queryByLabelText('素材')).not.toBeInTheDocument()
  })

  test('区分の見出しを押すと、その区分の項目ごと畳める（使わない区分を閉じておける）', async () => {
    render(トリガーのページ(代役のAPI()))

    await 項目の枠('フォローされた')
    await userEvent.click(screen.getByRole('button', { name: 'イベント' }))

    expect(screen.queryByRole('listitem', { name: 'フォローされた' })).not.toBeInTheDocument()
    // 畳んでいるあいだも、ほかの区分の項目は並んだままにする
    expect(screen.getByRole('listitem', { name: '初めて来た人の発言' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'イベント' }))

    expect(screen.getByRole('listitem', { name: 'フォローされた' })).toBeInTheDocument()
  })

  test('足した設定は、すぐ書き換えられるよう開いた状態で出る', async () => {
    render(トリガーのページ(代役のAPI({ config: async () => [] })))

    await 設定を足す('言葉を足す')

    expect(within(screen.getByRole('listitem', { name: '決まった言葉を含む発言の1番目の設定' })).getByLabelText('発言に含まれる言葉')).toBeInTheDocument()
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

    expect(await screen.findByRole('button', { name: 'トリガーを保存' })).toBeInTheDocument()
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
    expect(screen.queryByRole('button', { name: 'トリガーを保存' })).not.toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: 'トリガーを保存' })).toBeInTheDocument()
    // ほかの操作が成功しても、報酬を選べない理由は出したままにする（報酬の一覧はまだ取得できていない）
    await 設定を足す('報酬を足す')
    expect(await お知らせ('の設定を足しました')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('チャンネルポイント報酬の一覧を取得できませんでした')
    // 保存済みの報酬はTwitchの一覧にないものとして選択肢に残る（黙って別の報酬に変えない）
    expect((await 開いた設定('チャンネルポイントが交換された')).getByLabelText('対象の報酬')).toHaveValue('reward-hakushu')
  })
})
