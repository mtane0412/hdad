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
 * 失敗なら理由を出す）は usePageActions に合わせる（/triggers/・/speech/ と同じ）。
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
 */
import { useEffect, useId, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/core/api'
import { LLM_PROVIDERS, LLM_USAGES, type LlmApi, type LlmModelOption, type LlmProvider, type LlmSettings, type LlmUsage } from './api'

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
    description: '途中から来た人向けのまとめ。材料が多いので大きいモデル向き。',
  },
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
  const actions = usePageActions(failureLines)
  /** 入力欄のidは箇所ごとに要るので、1つのidを土台にして箇所の名前を足す */
  const fieldIdPrefix = useId()

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
      <Alert variant="destructive">
        <AlertTitle>LLMの設定を読み込めませんでした</AlertTitle>
        <AlertDescription>{loadFailure}</AlertDescription>
      </Alert>
    )
  }

  if (!settings) return <Skeleton className="h-96 w-full" aria-label="LLMの設定を読み込んでいます" />

  /**
   * 選択欄に並べる候補。
   *
   * 読み込みが終わるまでは、いま保存されている値だけを並べる（空の選択欄にすると、読み込み中に
   * 保存されているモデルが分からなくなる）。候補に無い値も足して残す（一覧から消えたモデルを選んでいたときに、
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

      <div>
        <Button type="button" disabled={actions.busy} onClick={() => void actions.run(save)}>
          設定を保存
        </Button>
      </div>

    </div>
  )
}
