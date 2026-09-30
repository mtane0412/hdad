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
const NOW = Date.parse('2026-09-21T12:00:00.000Z')

const FRIDAY_SESSION: SessionSummary = {
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

const LAST_MONTH_SESSION: SessionSummary = {
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

const FOLLOWER_TREND: FollowerSample[] = [
  { sampledAt: '2026-08-01T00:00:00.000Z', followerTotal: 90 },
  { sampledAt: '2026-09-18T15:00:00.000Z', followerTotal: 104 },
]

const FRIDAY_SESSION_DETAIL: SessionDetail = {
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
const createFakeApi = (patch: Partial<StatsApi> = {}): StatsApi => ({
  sessions: vi.fn(async () => [FRIDAY_SESSION, LAST_MONTH_SESSION]),
  session: vi.fn(async () => FRIDAY_SESSION_DETAIL),
  followers: vi.fn(async () => FOLLOWER_TREND),
  ...patch,
})

/** 画面（概要と一覧）が出るまで待つ */
const waitForDisplay = async (): Promise<void> => {
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
    const neverRespondingApi = createFakeApi({ sessions: vi.fn(() => new Promise<SessionSummary[]>(() => {})) })
    render(<StatsPage api={neverRespondingApi} now={NOW} />)

    expect(screen.getByLabelText('配信の記録を読み込んでいます')).toBeInTheDocument()
  })

  it('読み込みに失敗したら、記録が無いように見せず理由を出す', async () => {
    const failingApi = createFakeApi({
      sessions: vi.fn(async () => {
        throw new Error('Workerの環境変数が設定されていません: DB')
      }),
    })
    render(<StatsPage api={failingApi} now={NOW} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Workerの環境変数が設定されていません: DB')
    expect(screen.queryByText('まだ配信の記録がありません')).not.toBeInTheDocument()
  })

  it('記録がまだ無ければ、その旨を伝える', async () => {
    const emptyApi = createFakeApi({ sessions: vi.fn(async () => []), followers: vi.fn(async () => []) })
    render(<StatsPage api={emptyApi} now={NOW} />)

    expect(await screen.findByText('まだ配信の記録がありません')).toBeInTheDocument()
  })
})

describe('概要', () => {
  it('期間内の配信回数・配信時間・平均と最大の視聴者数・フォロワー数と増減を出す', async () => {
    render(<StatsPage api={createFakeApi()} now={NOW} />)
    await waitForDisplay()

    // 初期の期間は30日なので、対象は金曜の配信だけ（3時間30分・平均12.5人・最大31人）
    expect(within(screen.getByRole('group', { name: '配信回数' })).getByText('1回')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '配信時間' })).getByText('3時間30分')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '平均視聴者数' })).getByText('12.5')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: '最大視聴者数' })).getByText('31')).toBeInTheDocument()
    // 30日前（8月22日）時点のフォロワー数は90人なので、104人で14人増えた
    const followers = within(screen.getByRole('group', { name: 'フォロワー数' }))
    expect(followers.getByText('104')).toBeInTheDocument()
    expect(followers.getByText('+14')).toBeInTheDocument()
  })
})

describe('配信の一覧', () => {
  it('開始日時・長さ・タイトル・カテゴリ・視聴者数・フォロワー増減・イベント件数を出す', async () => {
    render(<StatsPage api={createFakeApi()} now={NOW} />)
    await waitForDisplay()

    const row = within(screen.getByRole('table', { name: '配信の一覧' })).getByRole('row', { name: /金曜夜のもくもく配信/ })
    // 開始日時はブラウザのタイムゾーン（東京）で出す
    expect(within(row).getByText('2026/9/18 21:00')).toBeInTheDocument()
    expect(within(row).getByText('3時間30分')).toBeInTheDocument()
    expect(within(row).getByText('Software and Game Development')).toBeInTheDocument()
    expect(within(row).getByText('12.5')).toBeInTheDocument()
    expect(within(row).getByText('31')).toBeInTheDocument()
    expect(within(row).getByText('+4')).toBeInTheDocument()
    // サブスクは新規2件と継続1件で3件、ポイント交換は7件、レイドは5件
    expect(within(row).getByText('3')).toBeInTheDocument()
    expect(within(row).getByText('7')).toBeInTheDocument()
    expect(within(row).getByText('5')).toBeInTheDocument()
  })

  it('タイトルの記録が無い配信は、一覧でもボタンの名前でも「（タイトルの記録なし）」と呼ぶ', async () => {
    // 配信の開始の通知で始まった配信は、次の収集までタイトルが空のことがある
    const untitledSession: SessionSummary = { ...FRIDAY_SESSION, id: '配信ID-無題', title: '', categoryName: '' }
    render(<StatsPage api={createFakeApi({ sessions: vi.fn(async () => [untitledSession]) })} now={NOW} />)
    await waitForDisplay()

    expect(screen.getByText('（タイトルの記録なし）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '（タイトルの記録なし） の視聴者数の推移を見る' })).toBeInTheDocument()
  })

  it('期間を切り替えると、その期間に始まった配信だけを出す', async () => {
    const user = userEvent.setup()
    render(<StatsPage api={createFakeApi()} now={NOW} />)
    await waitForDisplay()

    // 初期の30日では先月の配信は入らない
    expect(screen.queryByText('先月のゲーム配信')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '90日' }))
    expect(screen.getByText('先月のゲーム配信')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '7日' }))
    expect(screen.getByText('金曜夜のもくもく配信')).toBeInTheDocument()
    expect(screen.queryByText('先月のゲーム配信')).not.toBeInTheDocument()
  })
})

describe('フォロワー数の推移', () => {
  it('グラフの読み込みが終わると、期間のフォロワー数の推移を出す', async () => {
    // グラフ（Recharts）は React.lazy で切り離してあるので、出るまで待つ必要がある
    render(<StatsPage api={createFakeApi()} now={NOW} />)
    await waitForDisplay()

    expect(await screen.findByRole('img', { name: '直近30日のフォロワー数の推移' })).toBeInTheDocument()
  })
})

describe('配信ごとの視聴者数の推移', () => {
  it('配信を選ぶと、その配信の推移を読み込んで出す', async () => {
    const user = userEvent.setup()
    const api = createFakeApi()
    render(<StatsPage api={api} now={NOW} />)
    await waitForDisplay()

    await user.click(screen.getByRole('button', { name: '金曜夜のもくもく配信 の視聴者数の推移を見る' }))

    expect(api.session).toHaveBeenCalledWith('配信ID-金曜')
    const trend = await screen.findByRole('img', { name: '金曜夜のもくもく配信 の視聴者数の推移' })
    expect(trend).toBeInTheDocument()
  })

  it('推移の読み込みに失敗したら、理由を出す', async () => {
    const user = userEvent.setup()
    const detailFailingApi = createFakeApi({
      session: vi.fn(async () => {
        throw new Error('配信「配信ID-金曜」の記録が存在しません')
      }),
    })
    render(<StatsPage api={detailFailingApi} now={NOW} />)
    await waitForDisplay()

    await user.click(screen.getByRole('button', { name: '金曜夜のもくもく配信 の視聴者数の推移を見る' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('配信「配信ID-金曜」の記録が存在しません')
  })
})
