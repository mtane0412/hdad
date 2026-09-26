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
 * 注意: モデル名の検証は Worker だけが持つ（画面とWorkerで二重に持たない）。入力欄の値はそのまま送り、
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/core/api'
import { LLM_PROVIDERS, LLM_USAGES, type LlmApi, type LlmProvider, type LlmSettings, type LlmUsage } from './api'

/** 提供元の名前 */
const PROVIDER_LABELS: Readonly<Record<LlmProvider, string>> = {
  'workers-ai': 'Workers AI（Cloudflare）',
  openrouter: 'OpenRouter',
}

/** 使う箇所ごとの、画面に出す名前と説明 */
const USAGE_LABELS: Readonly<Record<LlmUsage, { name: string; description: string }>> = {
  aiChat: {
    name: 'チャットの文面',
    description: 'トリガーの動作「AIチャット」が視聴者へ送る文面。発言ごとに呼ばれることがあるので、軽くて安いモデルを選ぶ。',
  },
  sideSuper: {
    name: 'サイドスーパー',
    description: '配信画面の隅に出す2行のテロップ。cron が5分おきに作り直す。',
  },
  viewerSummary: {
    name: '視聴者の人物像',
    description: '配信が終わったあと、その人の発言からどんな人かをまとめた文。cron が1回に5人ぶんまで作る。',
  },
  streamSummary: {
    name: '配信のあらすじ',
    description: '配信者の発話と視聴者の発言をまとめた、途中から来た人向けの文。材料が多いので、大きいモデルを選ぶ。',
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

  if (loadFailure !== '') {
    return (
      <Alert variant="destructive">
        <AlertTitle>LLMの設定を読み込めませんでした</AlertTitle>
        <AlertDescription>{loadFailure}</AlertDescription>
      </Alert>
    )
  }

  if (!settings) return <Skeleton className="h-96 w-full" aria-label="LLMの設定を読み込んでいます" />

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

      {openrouterUsages.length > 0 && !apiKeyConfigured && (
        <Alert variant="destructive">
          <AlertTitle>OpenRouter のAPIキーが設定されていません</AlertTitle>
          <AlertDescription>
            Workerのシークレット <code>OPENROUTER_API_KEY</code> を設定してください（
            <code>npx wrangler secret put OPENROUTER_API_KEY</code>、ローカルでは <code>.dev.vars</code>）。
            鍵が無いあいだは、{openrouterUsages.map((usage) => USAGE_LABELS[usage].name).join('・')}
            を作るときに失敗します（黙って Workers AI には切り替わりません）。
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>AIを使う箇所ごとの提供元とモデル</CardTitle>
          <CardDescription>
            箇所ごとに別の提供元を選べる。保存すると次に作るぶんから効く（OBSの再読み込みは要らない）。
          </CardDescription>
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
                    <Label htmlFor={providerFieldId}>{name}の提供元</Label>
                    <NativeSelect
                      id={providerFieldId}
                      className="w-full"
                      value={provider}
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
                    <Label htmlFor={modelFieldId}>{name}のモデル</Label>
                    <Input
                      id={modelFieldId}
                      autoComplete="off"
                      spellCheck={false}
                      value={models[provider]}
                      onChange={(event) => changeModel(usage, event.currentTarget.value)}
                    />
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

      <Card>
        <CardHeader>
          <CardTitle>モデル名の書き方</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            Workers AI は <code>@cf/meta/llama-3.1-8b-instruct-fp8</code> のような名前で、鍵は要らない
            （このWorkerに付いている。無料枠は1日10,000 Neurons）。
          </p>
          <p>
            OpenRouter は <code>meta-llama/llama-3.1-8b-instruct</code> のような「提供者/モデル」の名前で、
            シークレットに鍵が要る。料金はOpenRouterのアカウントに請求される。
          </p>
          <p>
            モデル名は提供元ごとに覚えているので、切り替えて戻しても入力し直さなくてよい。
            選んでいない提供元のモデル名も保存のときに確かめるので、空にはできない。
          </p>
          <p>
            配信のあらすじは大きいモデルを選ぶ。小さいモデルでは、視聴者の書き込みを配信者がしたことのように書く・
            同じ言い回しを繰り返して長さの上限を超える、といった壊れ方が起きた。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
