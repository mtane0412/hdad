// @vitest-environment jsdom
/**
 * ダッシュボード（stats-page.tsx）のテスト
 *
 * 確かめること:
 * - 読み込み中は読み込み中と分かる表示を出すこと
 * - 読み込みに失敗したら、空の記録に見せかけずエラーを出すこと（Fail-Fast）
 * - 記録がまだ無いときは、その旨を伝えること
 * - 概要（配信回数・配信時間・平均と最大の視聴者数・フォロワー数と増減）を出すこと
 * - 配信の一覧に、開始日時・長さ・タイトル・カテゴリ・視聴者数・フォロワー増減・イベント件数を出すこと
 * - 期間を切り替えると、対象の配信だけに変わること
 * - 配信を選ぶと、その配信の視聴者数の推移を読み込んで出すこと
 *
 * 日時はブラウザのタイムゾーンで出す決まりなので、テストでは TZ を東京に固定する。
 * 現在時刻は now で渡して固定し、テストの結果が実行日で変わらないようにする。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FollowerSample, SessionDetail, SessionSummary, StatsApi } from './api'
import { StatsPage } from './stats-page'

process.env.TZ = 'Asia/Tokyo'

/** テストの「現在時刻」。2026年9月21日 21:00（東京） */
const 現在 = Date.parse('2026-09-21T12:00:00.000Z')

const 金曜の配信: SessionSummary = {
  id: '配信ID-金曜',
  startedAt: '2026-09-18T12:00:00.000Z',
  endedAt: '2026-09-18T15:30:00.000Z',
  title: '金曜夜のもくもく配信',
  categoryName: 'Software and Game Development',
  averageViewers: 12.5,
  peakViewers: 31,
  followerDelta: 4,
  eventCounts: { 'channel.subscribe': 2, 'channel.subscription.message': 1, 'channel.channel_points_custom_reward_redemption.add': 7, 'channel.raid': 5 },
}

const 先月の配信: SessionSummary = {
  id: '配信ID-先月',
  startedAt: '2026-08-10T12:00:00.000Z',
  endedAt: '2026-08-10T13:00:00.000Z',
  title: '先月のゲーム配信',
  categoryName: 'Balatro',
  averageViewers: 40,
  peakViewers: 60,
  followerDelta: 2,
  eventCounts: {},
}

const フォロワーの推移: FollowerSample[] = [
  { sampledAt: '2026-08-01T00:00:00.000Z', followerTotal: 90 },
  { sampledAt: '2026-09-18T15:00:00.000Z', followerTotal: 104 },
]

const 金曜の配信の詳細: SessionDetail = {
  id: '配信ID-金曜',
  startedAt: '2026-09-18T12:00:00.000Z',
  endedAt: '2026-09-18T15:30:00.000Z',
  title: '金曜夜のもくもく配信',
  categoryName: 'Software and Game Development',
  samples: [
    { sampledAt: '2026-09-18T12:05:00.000Z', viewerCount: 8 },
    { sampledAt: '2026-09-18T13:05:00.000Z', viewerCount: 31 },
  ],
}

/** 決めた記録を返す代役のAPI。個別に差し替えたいものだけ patch で渡す */
const 代役のAPI = (patch: Partial<StatsApi> = {}): StatsApi => ({
  sessions: vi.fn(async () => [金曜の配信, 先月の配信]),
  session: vi.fn(async () => 金曜の配信の詳細),
  followers: vi.fn(async () => フォロワーの推移),
  ...patch,
})

/** 画面（概要と一覧）が出るまで待つ */
const 表示を待つ = async (): Promise<void> => {
  await screen.findByRole('table', { name: '配信の一覧' })
}

beforeAll(() => {
  // jsdom には ResizeObserver がない。グラフが大きさを測るのに使うので、何もしない代役を置く
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  )
})

afterEach(cleanup)

describe('読み込みの途中と失敗', () => {
  it('読み込みが終わるまでは、読み込み中と分かる表示を出す', () => {
    // 応答を返さないAPIにして、読み込み中のまま止める
    const 返事のないAPI = 代役のAPI({ sessions: vi.fn(() => new Promise<SessionSummary[]>(() => {})) })
    render(<StatsPage api={返事のないAPI} now={現在} />)

    expect(screen.getByLabelText('配信の記録を読み込んでいます')).toBeInTheDocument()
  })

  it('読み込みに失敗したら、記録が無いように見せず理由を出す', async () => {
    const 失敗するAPI = 代役のAPI({
      sessions: vi.fn(async () => {
        throw new Error('Workerの環境変数が設定されていません: DB')
      }),
    })
    render(<StatsPage api={失敗するAPI} now={現在} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Workerの環境変数が設定されていません: DB')
    expect(screen.queryByText('まだ配信の記録がありません')).not.toBeInTheDocument()
  })

  it('記録がまだ無ければ、その旨を伝える', async () => {
    const 記録のないAPI = 代役のAPI({ sessions: vi.fn(async () => []), followers: vi.fn(async () => []) })
    render(<StatsPage api={記録のないAPI} now={現在} />)

    expect(await screen.findByText('まだ配信の記録がありません')).toBeInTheDocument()
  })
})

describe('概要', () => {
  it('期間内の配信回数・配信時間・平均と最大の視聴者数・フォロワー数と増減を出す', async () => {
    render(<StatsPage api={代役のAPI()} now={現在} />)
    await 表示を待つ()

    // 初期の期間は30日なので、対象は金曜の配信だけ（3時間30分・平均12.5人・最大31人）
    expect(within(screen.getByRole('group', { name: '配信回数' })).getByText('1回')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '配信時間' })).getByText('3時間30分')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '平均視聴者数' })).getByText('12.5')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '最大視聴者数' })).getByText('31')).toBeInTheDocument()
    // 30日前（8月22日）時点のフォロワー数は90人なので、104人で14人増えた
    const フォロワー = within(screen.getByRole('group', { name: 'フォロワー数' }))
    expect(フォロワー.getByText('104')).toBeInTheDocument()
    expect(フォロワー.getByText('+14')).toBeInTheDocument()
  })
})

describe('配信の一覧', () => {
  it('開始日時・長さ・タイトル・カテゴリ・視聴者数・フォロワー増減・イベント件数を出す', async () => {
    render(<StatsPage api={代役のAPI()} now={現在} />)
    await 表示を待つ()

    const 行 = within(screen.getByRole('table', { name: '配信の一覧' })).getByRole('row', { name: /金曜夜のもくもく配信/ })
    // 開始日時はブラウザのタイムゾーン（東京）で出す
    expect(within(行).getByText('2026/9/18 21:00')).toBeInTheDocument()
    expect(within(行).getByText('3時間30分')).toBeInTheDocument()
    expect(within(行).getByText('Software and Game Development')).toBeInTheDocument()
    expect(within(行).getByText('12.5')).toBeInTheDocument()
    expect(within(行).getByText('31')).toBeInTheDocument()
    expect(within(行).getByText('+4')).toBeInTheDocument()
    // サブスクは新規2件と継続1件で3件、ポイント交換は7件、レイドは5件
    expect(within(行).getByText('3')).toBeInTheDocument()
    expect(within(行).getByText('7')).toBeInTheDocument()
    expect(within(行).getByText('5')).toBeInTheDocument()
  })

  it('期間を切り替えると、その期間に始まった配信だけを出す', async () => {
    const 操作 = userEvent.setup()
    render(<StatsPage api={代役のAPI()} now={現在} />)
    await 表示を待つ()

    // 初期の30日では先月の配信は入らない
    expect(screen.queryByText('先月のゲーム配信')).not.toBeInTheDocument()

    await 操作.click(screen.getByRole('button', { name: '90日' }))
    expect(screen.getByText('先月のゲーム配信')).toBeInTheDocument()

    await 操作.click(screen.getByRole('button', { name: '7日' }))
    expect(screen.getByText('金曜夜のもくもく配信')).toBeInTheDocument()
    expect(screen.queryByText('先月のゲーム配信')).not.toBeInTheDocument()
  })
})

describe('配信ごとの視聴者数の推移', () => {
  it('配信を選ぶと、その配信の推移を読み込んで出す', async () => {
    const 操作 = userEvent.setup()
    const api = 代役のAPI()
    render(<StatsPage api={api} now={現在} />)
    await 表示を待つ()

    await 操作.click(screen.getByRole('button', { name: '金曜夜のもくもく配信 の視聴者数の推移を見る' }))

    expect(api.session).toHaveBeenCalledWith('配信ID-金曜')
    const 推移 = await screen.findByRole('img', { name: '金曜夜のもくもく配信 の視聴者数の推移' })
    expect(推移).toBeInTheDocument()
  })

  it('推移の読み込みに失敗したら、理由を出す', async () => {
    const 操作 = userEvent.setup()
    const 詳細が失敗するAPI = 代役のAPI({
      session: vi.fn(async () => {
        throw new Error('配信「配信ID-金曜」の記録が存在しません')
      }),
    })
    render(<StatsPage api={詳細が失敗するAPI} now={現在} />)
    await 表示を待つ()

    await 操作.click(screen.getByRole('button', { name: '金曜夜のもくもく配信 の視聴者数の推移を見る' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('配信「配信ID-金曜」の記録が存在しません')
  })
})
