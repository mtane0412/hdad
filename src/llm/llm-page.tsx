/**
 * LLMのページ
 *
 * AIを使う5か所（字幕の翻訳・トリガーの動作 aiChat のチャットの文面・サイドスーパー・視聴者の人物像・配信のあらすじ）
 * それぞれについて、どの提供元（Cloudflare の Workers AI・OpenRouter）のどのモデルに作らせるかを
 * Worker（KVの llm-settings）に保存する画面である。箇所ごとに選べるようにしてあるのは、あらすじだけ
 * 賢いモデルに任せて、発言ごとに呼ばれるチャットの文面は無料枠の Workers AI に留める、といった
 * 使い分けができるようにするためである。
 *
 * Workerの呼び出しは api.ts に分けてテストする。保存の形（ボタンを押す → Workerを呼ぶ → 成功なら知らせ、
 * 失敗なら理由を出す）は usePageActions に合わせる（/triggers/・コネクターのページの VOICEVOX と同じ）。
 *
 * 注意: 保存の応答を待っているあいだは、提供元もモデルも選べなくする（保存ボタンと同じ actions.busy で止める）。
 * 触れるままにすると、「保存しました」と出ているのに画面には保存していない設定が並ぶことになり、
 * どの設定で動いているのかを配信者が取り違える。
 * 注意: モデルは入力ではなく選択にする。打ち間違いに気づくのが「配信中に文面が作られなかったとき」に
 * なってしまうためである。候補は提供元ごとにWorkerから読む（Workers AI はこのリポジトリが持つ一覧、
 * OpenRouter は公開API。worker/llm-models.ts）。候補を読めなかったときは、黙って空の選択欄を出さずに理由を出す。
 * 注意: 保存済みのモデルが候補に無ければ、そのモデルも選択欄に残す（一覧から消えたモデルを選んでいたときに、
 * 画面を開いただけで別のモデルへ移ってしまわないようにするため）。
 * 注意: モデル名の検証は Worker だけが持つ（画面とWorkerで二重に持たない）。選んだ値はそのまま送り、
 * 返ってきた問題点を並べて出す。
 * 注意: モデル名は提供元ごとに別々に持つ（名前の付け方がまったく違うため）。画面でも両方を持ち続け、
 * 提供元を切り替えて戻したときに前のモデル名が消えないようにする。
 * 注意: OpenRouter のAPIキーはこの画面からは設定できない（Workerのシークレット）。1か所でも OpenRouter を
 * 選んでいるのに鍵が無ければ、保存する前にその場で知らせる（黙って Workers AI へ落ちることはないので、
 * 鍵が無いままではその箇所の文面が作られない）。
 * 注意: 設定を読めなかったときは、黙って既定に倒さず理由を出す（Fail-Fast）。読めないまま入力欄を出すと、
 * 配信者が「保存済みの設定はこれだ」と取り違えたまま上書きしてしまう。
 * 注意: 箇所ごとの設定と使用状況は、LLM と Jev の箇所をまとめた1つの表に並べる（1行1か所）。箇所の説明や
 * 注意書きは画面に並べず、ヘルプボタン（src/components/help-button.tsx）を押したときだけ出す。
 * 注意: 字幕の翻訳の提供元（訳さない・LLM・m2m100・DeepL）は、箇所の表の前の区画（translation-card.tsx）で選ぶ。
 * LLM を選んだときのモデルは、表の「字幕の翻訳（LLM）」の行で選ぶ（issue #191）。
 * 注意: 日ごとの呼び出し回数のグラフ（usage-chart.tsx）は Recharts を使うので重い。React.lazy で切り離して読み込む。
 * 注意: 使用状況（どれだけ呼んだか）は自前で数えた記録である（worker/llm-usage-store.ts）。日の区切りはUTCで、
 * Workers AI の無料枠の切り替わりに合わせてある。Cloudflare側の残り無料枠（Neurons）は、読むのに
 * アカウント単位のAPIトークンが要るので出せない（そのために強い鍵を増やさない）。画面にもその旨を書く。
 * 注意: 使用状況と残高を読めなくても、設定の画面はそのまま出して理由だけを添える。モニターのための表示のために、
 * 提供元やモデルを直せなくなるのは本末転倒である（Workerが記録の失敗でも文面を返すのと同じ考え方）。
 * 注意: 残高（OpenRouter）は鍵が設定されているときだけ読む。鍵が無ければWorkerが断るので、読みに行っても
 * 理由の出る場所が増えるだけである。
 */
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { HelpButton } from '@/components/help-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ApiError } from '@/core/api'
import {
  JEV_USAGES,
  LLM_PROVIDERS,
  LLM_USAGES,
  type JevUsage,
  type LlmApi,
  type LlmCredits,
  type LlmModelOption,
  type LlmProvider,
  type LlmSettings,
  type LlmUsage,
  type LlmUsageDay,
} from './api'
import { TranslationCard } from './translation-card'
import { dailyLlmCalls, summarizeLlmUsage, type LlmUsagePeriods, type LlmUsageTotals } from './usage'
import type { UsageChartProps } from './usage-chart'

/** グラフ（Recharts）は重いので、ほかのページを開くときに運ばないよう切り離して読み込む */
const UsageChart = lazy(async () => ({ default: (await import('./usage-chart')).UsageChart }))

/**
 * グラフの読み込みの失敗を、グラフの場所だけに留めるエラー境界。
 *
 * グラフは切り離して読み込むので、デプロイの直後に古いファイル名を読みに行くなどして失敗しうる。
 * 境界が無いとページ全体が消え、表示のためのグラフのせいで提供元やモデルを直せなくなる。
 */
class ChartErrorBoundary extends Component<{ children: ReactNode }, { failure: string }> {
  override state = { failure: '' }

  static getDerivedStateFromError(error: unknown): { failure: string } {
    return { failure: errorMessage(error) }
  }

  override render() {
    if (this.state.failure === '') return this.props.children
    return (
      <Alert variant="destructive">
        <AlertTitle>グラフを読み込めませんでした</AlertTitle>
        <AlertDescription>{this.state.failure}（ページを再読み込みすると直ることがあります）</AlertDescription>
      </Alert>
    )
  }
}

/** グラフを読み込み終えるまでは、同じ大きさの枠を出しておく。失敗したらグラフの場所にだけ理由を出す */
const LazyUsageChart = ({ label, points }: UsageChartProps) => (
  <ChartErrorBoundary>
    <Suspense fallback={<Skeleton className="h-48 w-full" aria-label={`${label}のグラフを読み込んでいます`} />}>
      <UsageChart label={label} points={points} />
    </Suspense>
  </ChartErrorBoundary>
)

/** グラフに並べる日数。Worker（worker/admin-routes.ts の USAGE_WINDOW_DAYS）が返す期間に合わせる */
const CHART_DAYS = 30

/** 提供元の名前 */
const PROVIDER_LABELS: Readonly<Record<LlmProvider, string>> = {
  'workers-ai': 'Workers AI（Cloudflare）',
  openrouter: 'OpenRouter',
}

/** 使う箇所ごとの、画面に出す名前と説明 */
const USAGE_LABELS: Readonly<Record<LlmUsage, { name: string; description: string }>> = {
  translation: {
    name: '字幕の翻訳（LLM）',
    description:
      '「字幕の翻訳」で LLM を選んだときだけ使う。確定した発話ごとに呼ばれるので軽いモデル向き。m2m100・DeepL で訳した回数もこの行に数える。',
  },
  aiChat: {
    name: 'チャットの文面',
    description: 'トリガーの「AIに文面を作らせて送る」。発言ごとに呼ばれるので軽いモデル向き。',
  },
  sideSuper: {
    name: 'サイドスーパー',
    description: '配信画面の隅に出す2行のテロップ。',
  },
  viewerSummary: {
    name: '視聴者の人物像',
    description: '配信後に、その人の発言からまとめる文。',
  },
  streamSummary: {
    name: '配信のあらすじ',
    description: '途中から来た人向けのまとめと、ダッシュボードに残す約30分ごとの章。材料が多いので大きいモデル向き。',
  },
  streamTitle: {
    name: '配信タイトルの候補',
    description: 'ダッシュボードで「配信タイトルの候補を作る」を入れていると、配信中に章が切り替わるたびに1回呼ばれる（試験運用）。日本語の言い回しが要るので大きいモデル向き。',
  },
  townTour: {
    name: '市町村紹介',
    description: 'レイドで流す、ランダムな市町村の紹介。Wikipedia の記事を材料に、その都度作る。材料にないことを書かせないよう大きいモデル向き。',
  },
  townBond: {
    name: '市町村紹介の共通点',
    description: '市町村紹介の締めに出す、レイド元の配信者とその市町村の意外な共通点と、認定証の任命理由。既定の google/gemini-3.8-flash は推論を止められないので、軽い推論をかけて呼ぶ。',
  },
  autoText: {
    name: 'テキストの自動の書き換え',
    description: '「自動で書き換える」を入れたテキストの本文。配信中、前回のあとに喋っていれば5分おきにテキストごとに呼ばれるので軽いモデル向き。',
  },
}

/** Jev を使う箇所ごとの、画面に出す名前と説明 */
const JEV_USAGE_LABELS: Readonly<Record<JevUsage, { name: string; description: string }>> = {
  bgm: {
    name: 'BGMの選択（Jev）',
    description: 'BGMで「配信の話題に合う曲へ自動で切り替える」を入れていると、配信中にあらすじを作り直すたびに呼ばれる（切り替えの直後は呼ばない）。',
  },
  streamTitle: {
    name: '配信タイトルの候補の判定（Jev）',
    description: '配信タイトルの候補を作るたびに、配信タイトルとして公開してよいかを尋ねる（試験運用）。',
  },
}

/** トークン数を3桁ごとに区切って出す */
const formatTokens = (tokens: number): string => tokens.toLocaleString('ja-JP')

/** 実費（米ドル）を出す。1回あたりが小さい額なので、桁を落とさないよう小数4桁まで出す */
const formatCost = (usd: number): string => `$${usd.toFixed(4)}`

/** 残高（米ドル）を出す。こちらは課金の単位なので小数2桁でよい */
const formatCredits = (usd: number): string => `$${usd.toFixed(2)}`

/** 回数を出す。失敗が無いときは括弧を付けない（ふだんの表示を短く保つ） */
const formatCalls = (totals: LlmUsageTotals): string =>
  `${totals.calls}回${totals.failures > 0 ? `（失敗${totals.failures}回）` : ''}`

/** 回数とトークン数を2段にして出す（表のセルと集計のタイルで共通） */
const UsageFigure = ({ totals }: { totals: LlmUsageTotals }) => (
  <div className="flex flex-col">
    <span className="tabular-nums">{formatCalls(totals)}</span>
    <span className="text-xs text-muted-foreground tabular-nums">{formatTokens(totals.promptTokens + totals.completionTokens)}トークン</span>
  </div>
)

/** 集計のタイル。読み上げでは見出し（label）を名前にしたひとまとまりとして読ませる */
const StatTile = ({ label, children }: { label: string; children: ReactNode }) => (
  <div role="group" aria-label={label} className="flex flex-col gap-1 rounded-md border p-3">
    <span className="text-xs text-muted-foreground">{label}</span>
    <div className="text-lg font-medium">{children}</div>
  </div>
)

/** 表の、今日と直近7日の使用状況の2列 */
const UsageCells = ({ periods }: { periods: LlmUsagePeriods }) => (
  <>
    <TableCell>
      <UsageFigure totals={periods.today} />
    </TableCell>
    <TableCell>
      <UsageFigure totals={periods.week} />
    </TableCell>
  </>
)

/** 箇所の名前と、その説明を出すヘルプボタン */
const UsageName = ({ name, description }: { name: string; description: string }) => (
  <div className="flex items-center gap-1">
    <span className="font-medium">{name}</span>
    <HelpButton topic={name}>
      <p className="text-sm">{description}</p>
    </HelpButton>
  </div>
)

export interface LlmPageProps {
  /** LLMの設定の読み書き */
  api: LlmApi
}

/** 保存の失敗を画面に出す行にする。Workerが返した問題点は1行ずつ並べる */
const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['LLMの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${problem}`)]
    : [errorMessage(error)]

export const LlmPage = ({ api }: LlmPageProps) => {
  /** 読み込み中は undefined、読めたら5か所ぶんの設定（提供元ごとのモデル名を両方持つ） */
  const [settings, setSettings] = useState<LlmSettings>()
  const [loadFailure, setLoadFailure] = useState('')
  /** OpenRouter のAPIキーがWorkerに設定されているか */
  const [apiKeyConfigured, setApiKeyConfigured] = useState(true)
  /** 提供元ごとのモデルの候補。まだ読んでいない提供元は持たない */
  const [modelOptions, setModelOptions] = useState<Partial<Record<LlmProvider, readonly LlmModelOption[]>>>({})
  /** モデルの候補を読めなかった理由 */
  const [modelsFailure, setModelsFailure] = useState('')
  /** 日ごとの使用状況（読み込み前は空として扱い、0回と出す） */
  const [usageDays, setUsageDays] = useState<readonly LlmUsageDay[]>([])
  /** 使用状況を読めなかった理由 */
  const [usageFailure, setUsageFailure] = useState('')
  /** OpenRouter の残高。鍵が無い・まだ読めていないあいだは undefined */
  const [credits, setCredits] = useState<LlmCredits>()
  /** 残高を読めなかった理由 */
  const [creditsFailure, setCreditsFailure] = useState('')
  const actions = usePageActions(failureLines)

  // 使用状況は設定とは別に読む（片方を読めなかったことを、もう片方に波及させない）
  useEffect(() => {
    let cancelled = false
    api.loadUsage().then(
      (days) => {
        if (!cancelled) setUsageDays(days)
      },
      (error: unknown) => {
        if (!cancelled) setUsageFailure(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    let cancelled = false
    api.load().then(
      (state) => {
        if (cancelled) return
        setSettings(state.settings)
        setApiKeyConfigured(state.apiKeyConfigured)
      },
      (error: unknown) => {
        if (!cancelled) setLoadFailure(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  /** 設定を読み終えたか。残高の読み出しの条件に使う（設定そのものを条件にすると、選び直すたびに読み直してしまう） */
  const settingsLoaded = settings !== undefined

  // 残高は鍵が設定されているときだけ読む（鍵が無ければWorkerが断るため）。
  // 設定を読めるまでは鍵の有無が分からないので、読み終わるまで待つ
  useEffect(() => {
    if (!settingsLoaded || !apiKeyConfigured) return
    let cancelled = false
    api.loadCredits().then(
      (loadedBalance) => {
        if (!cancelled) setCredits(loadedBalance)
      },
      (error: unknown) => {
        if (!cancelled) setCreditsFailure(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, apiKeyConfigured, settingsLoaded])

  /** いま画面で選ばれている提供元（重なりを除く）。この提供元の候補だけを読む */
  const usedProviders = [...new Set(LLM_USAGES.map((usage) => settings?.usages[usage].provider))].filter(
    (provider): provider is LlmProvider => provider !== undefined,
  )
  // 使っている提供元の候補を、まだ読んでいなければ読む（使っていない提供元の一覧は取りに行かない）
  const missingProviders = usedProviders.filter((provider) => modelOptions[provider] === undefined).join(',')
  useEffect(() => {
    if (missingProviders === '') return
    let cancelled = false
    for (const provider of missingProviders.split(',') as LlmProvider[]) {
      api.listModels(provider).then(
        (models) => {
          if (!cancelled) setModelOptions((current) => ({ ...current, [provider]: models }))
        },
        (error: unknown) => {
          if (!cancelled) setModelsFailure(errorMessage(error))
        },
      )
    }
    return () => {
      cancelled = true
    }
  }, [api, missingProviders])

  if (loadFailure !== '') {
    return (
      <LoadFailure title="LLMの設定を読み込めませんでした" message={loadFailure} />
    )
  }

  if (!settings) return <Skeleton className="h-96 w-full" aria-label="LLMの設定を読み込んでいます" />

  /**
   * 選択欄に並べる候補。
   *
   * 読み込みが終わるまでは、いま保存されている値だけを並べる（空の選択欄にすると、読み込み中に
   * 保存されているモデルが分からなくなる）。候補に無い値も追加して残す（一覧から消えたモデルを選んでいたときに、
   * 画面を開いただけで別のモデルへ移ってしまわないようにするため）。
   */
  const optionsFor = (provider: LlmProvider, selected: string): readonly LlmModelOption[] => {
    const options = modelOptions[provider] ?? []
    return options.some(({ id }) => id === selected) ? options : [{ id: selected, name: selected }, ...options]
  }

  /** 1か所ぶんの提供元を選び直す（モデル名は両方を持ち続けるので、選び直しても消えない） */
  const changeProvider = (usage: LlmUsage, provider: LlmProvider): void =>
    setSettings({ ...settings, usages: { ...settings.usages, [usage]: { ...settings.usages[usage], provider } } })

  /** 1か所ぶんの、いま選んでいる提供元のモデル名を書き換える */
  const changeModel = (usage: LlmUsage, model: string): void => {
    const current = settings.usages[usage]
    setSettings({
      ...settings,
      usages: { ...settings.usages, [usage]: { ...current, models: { ...current.models, [current.provider]: model } } },
    })
  }

  /** 使用状況のまとめ（今日・直近7日）。日の区切りはUTCで数える（Workers AI の無料枠の切り替わりに合わせる） */
  const usageSummary = summarizeLlmUsage(usageDays, Date.now())

  /** OpenRouter を選んでいる箇所の名前。鍵が無いときに、どこが動かなくなるかを知らせるために使う */
  const openrouterUsages = LLM_USAGES.filter((usage) => settings.usages[usage].provider === 'openrouter')

  const save = async (): Promise<string> => {
    setSettings(await api.save(settings))
    return 'LLMの設定を保存しました'
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      {modelsFailure !== '' && (
        <Alert variant="destructive">
          <AlertTitle>モデルの候補を読み込めませんでした</AlertTitle>
          <AlertDescription>{modelsFailure}（選択欄には、いま保存されているモデルだけが出ます）</AlertDescription>
        </Alert>
      )}

      {openrouterUsages.length > 0 && !apiKeyConfigured && (
        <Alert variant="destructive">
          <AlertTitle>OpenRouter のAPIキーが設定されていません</AlertTitle>
          <AlertDescription>
            <code>npx wrangler secret put OPENROUTER_API_KEY</code> で設定してください（ローカルでは <code>.dev.vars</code>）。
            鍵が無いあいだは {openrouterUsages.map((usage) => USAGE_LABELS[usage].name).join('・')} が作られません。
          </AlertDescription>
        </Alert>
      )}

      {usageFailure !== '' && (
        <Alert variant="destructive">
          <AlertTitle>使用状況を読み込めませんでした</AlertTitle>
          <AlertDescription>{usageFailure}（設定の変更と保存は、このままできます）</AlertDescription>
        </Alert>
      )}

      {creditsFailure !== '' && (
        <Alert variant="destructive">
          <AlertTitle>OpenRouter の残高を読み込めませんでした</AlertTitle>
          <AlertDescription>{creditsFailure}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>使用状況</CardTitle>
          <CardAction>
            <HelpButton topic="使用状況">
              <div className="flex flex-col gap-2 text-sm">
                <p>日の区切りはUTCです（Workers AI の無料枠の切り替わりに合わせています）。</p>
                <p>Workers AI の残り無料枠そのものは読めないため、呼び出した回数から見当をつけてください。</p>
                <p>実費は OpenRouter が返した額の合計です（Workers AI は返さないので含みません）。</p>
              </div>
            </HelpButton>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="今日">
              <UsageFigure totals={usageSummary.total.today} />
            </StatTile>
            <StatTile label="直近7日">
              <UsageFigure totals={usageSummary.total.week} />
            </StatTile>
            <StatTile label="直近7日の実費">
              <span className="tabular-nums">{formatCost(usageSummary.total.week.costUsd)}</span>
            </StatTile>
            {credits !== undefined && (
              <StatTile label="OpenRouter の残高">
                <div className="flex flex-col">
                  <span className="tabular-nums">{formatCredits(credits.remaining)}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    付与 {formatCredits(credits.totalCredits)}・使用 {formatCredits(credits.totalUsage)}
                  </span>
                </div>
              </StatTile>
            )}
          </div>
          <LazyUsageChart label={`直近${CHART_DAYS}日の呼び出し回数の推移`} points={dailyLlmCalls(usageDays, Date.now(), CHART_DAYS)} />
        </CardContent>
      </Card>

      <TranslationCard api={api} />

      <Card>
        <CardHeader>
          <CardTitle>AIを使う箇所</CardTitle>
          <CardAction>
            <HelpButton topic="AIを使う箇所">
              <div className="flex flex-col gap-2 text-sm">
                <p>箇所ごとに提供元とモデルを選べます。保存すると次に作るぶんから効きます。</p>
                <p>Jev の箇所は文面を作らず判定だけを返すモデル（TypeSafe の Jev。OpenRouter 経由）です。版を固定しているので選べません。</p>
              </div>
            </HelpButton>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table aria-label="AIを使う箇所">
            <TableHeader>
              <TableRow>
                <TableHead>箇所</TableHead>
                <TableHead>提供元</TableHead>
                <TableHead>モデル</TableHead>
                <TableHead>今日</TableHead>
                <TableHead>直近7日</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {LLM_USAGES.map((usage) => {
                const { name, description } = USAGE_LABELS[usage]
                const { provider, models } = settings.usages[usage]
                return (
                  <TableRow key={usage} aria-label={name}>
                    <TableCell>
                      <UsageName name={name} description={description} />
                    </TableCell>
                    <TableCell>
                      {/* 表の見出しは「提供元」だけなので、読み上げの名前には箇所の名前を含める（同じ名前の選択欄が並ばないようにする） */}
                      <NativeSelect
                        aria-label={`${name}の提供元`}
                        className="min-w-44"
                        value={provider}
                        disabled={actions.busy}
                        onChange={(event) => changeProvider(usage, event.currentTarget.value as LlmProvider)}
                      >
                        {LLM_PROVIDERS.map((candidate) => (
                          <NativeSelectOption key={candidate} value={candidate}>
                            {PROVIDER_LABELS[candidate]}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </TableCell>
                    <TableCell>
                      <NativeSelect
                        aria-label={`${name}のモデル`}
                        className="min-w-56"
                        value={models[provider]}
                        disabled={actions.busy || modelOptions[provider] === undefined}
                        onChange={(event) => changeModel(usage, event.currentTarget.value)}
                      >
                        {optionsFor(provider, models[provider]).map(({ id, name: modelName }) => (
                          <NativeSelectOption key={id} value={id}>
                            {modelName}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </TableCell>
                    <UsageCells periods={usageSummary.usages[usage]} />
                  </TableRow>
                )
              })}
              {JEV_USAGES.map((usage) => {
                const { name, description } = JEV_USAGE_LABELS[usage]
                return (
                  <TableRow key={usage} aria-label={name}>
                    <TableCell>
                      <UsageName name={name} description={description} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{PROVIDER_LABELS.openrouter}</TableCell>
                    <TableCell className="text-muted-foreground">Jev（版を固定）</TableCell>
                    <UsageCells periods={usageSummary.jevUsages[usage]} />
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div>
        <Button type="button" disabled={actions.busy} onClick={() => void actions.run(save)}>
          設定を保存
        </Button>
      </div>

    </div>
  )
}
