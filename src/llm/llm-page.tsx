/**
 * LLMのページ
 *
 * どの提供元（Cloudflare の Workers AI・OpenRouter）のどのモデルに文面を作らせるかを Worker
 * （KVの llm-settings）に保存する画面である。文面を作らせる場所は4つ（チャットの文面・サイドスーパー・
 * 人物像・配信のあらすじ）あるが、モデルを分けたいのは「短く安く作るもの」と「長い材料をまとめるあらすじ」の
 * 2つだけなので、入力欄も用途ごとに2つにしてある（worker/llm-config.ts の LLM_PURPOSES）。
 *
 * Workerの呼び出しは api.ts に分けてテストする。保存の形（ボタンを押す → Workerを呼ぶ → 成功なら知らせ、
 * 失敗なら理由を出す）は usePageActions に合わせる（/triggers/・/speech/ と同じ）。
 *
 * 注意: モデル名の検証は Worker だけが持つ（画面とWorkerで二重に持たない）。入力欄の値はそのまま送り、
 * 返ってきた問題点を並べて出す。
 * 注意: モデル名は提供元ごとに別々に持つ（名前の付け方がまったく違うため）。画面でも両方を持ち続け、
 * 提供元を切り替えて戻したときに前のモデル名が消えないようにする。
 * 注意: OpenRouter のAPIキーはこの画面からは設定できない（Workerのシークレット）。選んでいるのに鍵が無ければ、
 * 保存する前にその場で知らせる（黙って Workers AI へ落ちることはないので、鍵が無いままでは文面が作られない）。
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
import { LLM_PROVIDERS, type LlmApi, type LlmProvider, type LlmSettings } from './api'

/** 提供元の名前と、選ぶときの手がかり */
const PROVIDER_LABELS: Readonly<Record<LlmProvider, string>> = {
  'workers-ai': 'Workers AI（Cloudflare）',
  openrouter: 'OpenRouter',
}

/** 用途ごとの入力欄の見出しと説明 */
const PURPOSE_FIELDS = [
  {
    purpose: 'chat' as const,
    label: 'チャットの文面・サイドスーパー・人物像のモデル',
    description: '短い文をたくさん作る用途。チャットの発言ごとに呼ばれることがあるので、軽いモデルを選ぶ。',
  },
  {
    purpose: 'summary' as const,
    label: '配信のあらすじのモデル',
    description: '配信の発話と書き込みをまとめる用途。5分に1回しか呼ばないので、大きいモデルを選んでよい。',
  },
]

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
  /** 読み込み中は undefined、読めたら設定（提供元ごとのモデル名を両方持つ） */
  const [settings, setSettings] = useState<LlmSettings>()
  const [loadFailure, setLoadFailure] = useState('')
  /** OpenRouter のAPIキーがWorkerに設定されているか */
  const [apiKeyConfigured, setApiKeyConfigured] = useState(true)
  const actions = usePageActions(failureLines)
  const providerFieldId = useId()
  const chatFieldId = useId()
  const summaryFieldId = useId()
  const fieldIds: Readonly<Record<'chat' | 'summary', string>> = { chat: chatFieldId, summary: summaryFieldId }

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

  /** いま選んでいる提供元のモデル名を持つ項目の名前 */
  const modelsKey = settings.provider === 'openrouter' ? 'openrouter' : 'workersAi'

  /** いま選んでいる提供元のモデル名を1つ書き換える（もう一方の提供元のモデル名はそのまま持ち続ける） */
  const changeModel = (purpose: 'chat' | 'summary', model: string): void =>
    setSettings({ ...settings, [modelsKey]: { ...settings[modelsKey], [purpose]: model } })

  const save = async (): Promise<string> => {
    setSettings(await api.save(settings))
    return 'LLMの設定を保存しました'
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      {settings.provider === 'openrouter' && !apiKeyConfigured && (
        <Alert variant="destructive">
          <AlertTitle>OpenRouter のAPIキーが設定されていません</AlertTitle>
          <AlertDescription>
            Workerのシークレット <code>OPENROUTER_API_KEY</code> を設定してください（
            <code>npx wrangler secret put OPENROUTER_API_KEY</code>、ローカルでは <code>.dev.vars</code>）。
            鍵が無いあいだは、文面を作る場面で失敗します（黙って Workers AI には切り替わりません）。
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>LLMの提供元とモデル</CardTitle>
          <CardDescription>
            チャットの文面・サイドスーパー・人物像・配信のあらすじを作らせる相手。保存すると次に作るぶんから効く。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={providerFieldId}>提供元</Label>
            <NativeSelect
              id={providerFieldId}
              className="w-full sm:w-80"
              value={settings.provider}
              onChange={(event) => setSettings({ ...settings, provider: event.currentTarget.value as LlmProvider })}
            >
              {LLM_PROVIDERS.map((provider) => (
                <NativeSelectOption key={provider} value={provider}>
                  {PROVIDER_LABELS[provider]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-sm text-muted-foreground">
              Workers AI はこのWorkerに付いているので鍵が要らない。OpenRouter はシークレットに鍵が要るが、ほかの会社のモデルも選べる。
              モデル名は提供元ごとに覚えているので、切り替えて戻しても入力し直さなくてよい。
            </p>
          </div>

          {PURPOSE_FIELDS.map(({ purpose, label, description }) => (
            <div key={purpose} className="flex flex-col gap-2">
              <Label htmlFor={fieldIds[purpose]}>{label}</Label>
              <Input
                id={fieldIds[purpose]}
                autoComplete="off"
                spellCheck={false}
                value={settings[modelsKey][purpose]}
                onChange={(event) => changeModel(purpose, event.currentTarget.value)}
              />
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
          ))}
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
            Workers AI は <code>@cf/meta/llama-3.1-8b-instruct-fp8</code> のような名前で、
            一覧は Cloudflare のダッシュボードか Workers AI のモデル一覧で確認する。
          </p>
          <p>
            OpenRouter は <code>meta-llama/llama-3.1-8b-instruct</code> のような「提供者/モデル」の名前で、
            一覧は openrouter.ai のモデル一覧で確認する。料金はOpenRouterのアカウントに請求される。
          </p>
          <p>
            あらすじは大きいモデルを選ぶ。小さいモデルでは、視聴者の書き込みを配信者がしたことのように書く・
            同じ言い回しを繰り返して長さの上限を超える、といった壊れ方が起きた。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
