/**
 * LLMのページ
 *
 * AIを使う4か所（トリガーの動作 aiChat のチャットの文面・サイドスーパー・視聴者の人物像・配信のあらすじ）
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
 * 注意: 使用状況（どれだけ呼んだか）は自前で数えた記録である（worker/llm-usage-store.ts）。日の区切りはUTCで、
 * Workers AI の無料枠の切り替わりに合わせてある。Cloudflare側の残り無料枠（Neurons）は、読むのに
 * アカウント単位のAPIトークンが要るので出せない（そのために強い鍵を増やさない）。画面にもその旨を書く。
 * 注意: 使用状況と残高を読めなくても、設定の画面はそのまま出して理由だけを添える。モニターのための表示のために、
 * 提供元やモデルを直せなくなるのは本末転倒である（Workerが記録の失敗でも文面を返すのと同じ考え方）。
 * 注意: 残高（OpenRouter）は鍵が設定されているときだけ読む。鍵が無ければWorkerが断るので、読みに行っても
 * 理由の出る場所が増えるだけである。
 */
import { useEffect, useId, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
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
import { summarizeLlmUsage, type LlmUsageTotals } from './usage'

/** 提供元の名前 */
const PROVIDER_LABELS: Readonly<Record<LlmProvider, string>> = {
  'workers-ai': 'Workers AI（Cloudflare）',
  openrouter: 'OpenRouter',
}

/** 使う箇所ごとの、画面に出す名前と説明 */
const USAGE_LABELS: Readonly<Record<LlmUsage, { name: string; description: string }>> = {
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
}

/** Jev を使う箇所ごとの、画面に出す名前と説明 */
const JEV_USAGE_LABELS: Readonly<Record<JevUsage, { name: string; description: string }>> = {
  bgm: {
    name: 'BGMの選択（Jev）',
    description: 'BGMで「配信の話題に合う曲へ自動で切り替える」を入れていると、配信中にあらすじを作り直すたびに呼ばれる（切り替えの直後は呼ばない）。',
  },
}

/** トークン数を3桁ごとに区切って出す */
const formatTokens = (tokens: number): string => tokens.toLocaleString('ja-JP')

/** 実費（米ドル）を出す。1回あたりが小さい額なので、桁を落とさないよう小数4桁まで出す */
const formatCost = (usd: number): string => `$${usd.toFixed(4)}`

/** 残高（米ドル）を出す。こちらは課金の単位なので小数2桁でよい */
const formatCredits = (usd: number): string => `$${usd.toFixed(2)}`

/** 期間ぶんの数を1行にする。失敗が無いときは括弧を付けない（ふだんの表示を短く保つ） */
const usageLine = (label: string, totals: LlmUsageTotals): string => {
  const failure = totals.failures > 0 ? `（失敗${totals.failures}回）` : ''
  return `${label} ${totals.calls}回${failure}・${formatTokens(totals.promptTokens + totals.completionTokens)}トークン`
}

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
  /** 読み込み中は undefined、読めたら4か所ぶんの設定（提供元ごとのモデル名を両方持つ） */
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
  /** 入力欄のidは箇所ごとに要るので、1つのidを土台にして箇所の名前を追加する */
  const fieldIdPrefix = useId()

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
          <CardDescription>
            日の区切りはUTC（Workers AI の無料枠の切り替わりに合わせている）。Workers AI の残り無料枠そのものは読めないため、呼び出した回数から見当をつける。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>{usageLine('今日', usageSummary.total.today)}</p>
          <p>{usageLine('直近7日', usageSummary.total.week)}</p>
          <p className="text-muted-foreground">直近7日の実費（OpenRouter のぶん）{formatCost(usageSummary.total.week.costUsd)}</p>
          {credits !== undefined && (
            <p>
              OpenRouter の残高 残り {formatCredits(credits.remaining)}（付与 {formatCredits(credits.totalCredits)}・使用{' '}
              {formatCredits(credits.totalUsage)}）
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>AIを使う箇所</CardTitle>
          <CardDescription>箇所ごとに提供元とモデルを選べる。保存すると次に作るぶんから効く。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {LLM_USAGES.map((usage) => {
            const { name, description } = USAGE_LABELS[usage]
            const { provider, models } = settings.usages[usage]
            const providerFieldId = `${fieldIdPrefix}-${usage}-provider`
            const modelFieldId = `${fieldIdPrefix}-${usage}-model`
            return (
              <div key={usage} className="flex flex-col gap-3 rounded-md border p-4">
                <div className="flex flex-col gap-1">
                  <h3 className="font-medium">{name}</h3>
                  <p className="text-sm text-muted-foreground">{description}</p>
                  <p className="text-sm text-muted-foreground">
                    {usageLine('今日', usageSummary.usages[usage].today)} / {usageLine('直近7日', usageSummary.usages[usage].week)}
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={providerFieldId}>
                      {/* 画面には「提供元」とだけ出し、読み上げの名前には箇所の名前を含める（同じ名前の選択欄が4つ並ばないようにする） */}
                      <span className="sr-only">{name}の</span>提供元
                    </Label>
                    <NativeSelect
                      id={providerFieldId}
                      className="w-full"
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
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={modelFieldId}>
                      <span className="sr-only">{name}の</span>モデル
                    </Label>
                    <NativeSelect
                      id={modelFieldId}
                      className="w-full"
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
                  </div>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>判定に使う箇所</CardTitle>
          <CardDescription>文面を作らず、判定だけを返すモデル（TypeSafe の Jev。OpenRouter 経由）。モデルは版を固定しているので選べない。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {JEV_USAGES.map((usage) => {
            const { name, description } = JEV_USAGE_LABELS[usage]
            const headingId = `${fieldIdPrefix}-${usage}-heading`
            return (
              <section key={usage} aria-labelledby={headingId} className="flex flex-col gap-1 rounded-md border p-4">
                <h3 id={headingId} className="font-medium">
                  {name}
                </h3>
                <p className="text-sm text-muted-foreground">{description}</p>
                <p className="text-sm text-muted-foreground">
                  {usageLine('今日', usageSummary.jevUsages[usage].today)} / {usageLine('直近7日', usageSummary.jevUsages[usage].week)}
                </p>
              </section>
            )
          })}
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
