/**
 * 字幕の翻訳の区画（/llm/ のページ）
 *
 * アプリの枠の音声認識が確定した発話を、どの提供元で英訳して字幕に添えるかを選ぶ（issue #191）。設定は Worker
 * （KVの translation-settings）が持ち、この区画は /api/admin/translation を読み書きする。LLM を選んだときの提供元と
 * モデルは、同じページの箇所の表の「字幕の翻訳（LLM）」の行で選ぶ（LLM の呼び先を決めるのは worker/llm.ts だけなので、
 * 翻訳のためにモデルの選び方を二重に持たない）。
 *
 * LLM の箇所の表とは保存のボタンを分ける。設定の置き場所（KVのキー）も検証も別で、片方の問題点のせいで
 * もう片方を保存できなくならないようにするためである。
 *
 * 注意: DeepL の鍵はこの画面からは設定できない（Workerのシークレット）。DeepL を選んでいるのに鍵が無ければ、
 * 保存する前にその場で知らせる（黙って別の提供元へ落ちることはないので、鍵が無いままでは訳が出ない）。
 * 注意: DeepL の使用量は鍵があるときだけ読む（鍵が無ければWorkerが断る）。読めなくても選択欄はそのまま出す。
 * 注意: 設定を読めなかったときは、黙って「訳さない」に倒さず理由を出す（Fail-Fast）。
 * 注意: 選び直して保存していないあいだは、ページを離れる前に確認を出す（src/app/router.tsx の useUnsavedChanges）。
 */
import { useEffect, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { useUnsavedChanges } from '@/app/router'
import { HelpButton } from '@/components/help-button'
import { LoadFailure } from '@/components/load-failure'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { TRANSLATION_PROVIDERS, type DeeplUsage, type LlmApi, type TranslationProvider, type TranslationState } from './api'

/** この区画が使う読み書き */
export type TranslationCardApi = Pick<LlmApi, 'loadTranslation' | 'saveTranslation' | 'loadDeeplUsage'>

/** 提供元の名前 */
const PROVIDER_LABELS: Readonly<Record<TranslationProvider, string>> = {
  off: '訳さない',
  llm: 'LLM（下の表の「字幕の翻訳（LLM）」で選んだモデル）',
  m2m100: 'Workers AI の翻訳専用モデル（m2m100）',
  deepl: 'DeepL API Free',
}

/** 文字数を3桁ごとに区切って出す */
const formatCharacters = (characters: number): string => characters.toLocaleString('ja-JP')

/** DeepL の今月の使用量と残りを1行で出す */
const formatDeeplUsage = ({ characterCount, characterLimit }: DeeplUsage): string =>
  `今月 ${formatCharacters(characterCount)} / ${formatCharacters(characterLimit)}字（残り ${formatCharacters(Math.max(characterLimit - characterCount, 0))}字）`

export const TranslationCard = ({ api }: { api: TranslationCardApi }) => {
  /** 読み込み中は undefined */
  const [state, setState] = useState<TranslationState>()
  /** Worker に保存されている提供元。選び直して保存していないかを比べる基準（読み込み中は undefined） */
  const [savedProvider, setSavedProvider] = useState<TranslationProvider>()
  const [loadFailure, setLoadFailure] = useState('')
  const [deeplUsage, setDeeplUsage] = useState<DeeplUsage>()
  const [deeplUsageFailure, setDeeplUsageFailure] = useState('')
  const actions = usePageActions()

  useEffect(() => {
    let cancelled = false
    api.loadTranslation().then(
      (loaded) => {
        if (cancelled) return
        setState(loaded)
        setSavedProvider(loaded.provider)
      },
      (error: unknown) => {
        if (!cancelled) setLoadFailure(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  /** DeepL の鍵があるか。使用量の読み出しの条件に使う（設定そのものを条件にすると、選び直すたびに読み直してしまう） */
  const deeplKeyConfigured = state?.deeplKeyConfigured === true

  // 使用量は鍵があるときだけ読む（鍵が無ければWorkerが断るため）
  useEffect(() => {
    if (!deeplKeyConfigured) return
    let cancelled = false
    api.loadDeeplUsage().then(
      (usage) => {
        if (!cancelled) setDeeplUsage(usage)
      },
      (error: unknown) => {
        if (!cancelled) setDeeplUsageFailure(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, deeplKeyConfigured])

  // 読み込み中は比べる基準が無いので、未保存として扱わない
  useUnsavedChanges(state !== undefined && state.provider !== savedProvider)

  if (loadFailure !== '') return <LoadFailure title="字幕の翻訳の設定を読み込めませんでした" message={loadFailure} />
  if (!state) return <Skeleton className="h-32 w-full" aria-label="字幕の翻訳の設定を読み込んでいます" />

  const save = async (): Promise<string> => {
    const provider = await api.saveTranslation(state.provider)
    setState({ ...state, provider })
    setSavedProvider(provider)
    return '字幕の翻訳の設定を保存しました'
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>字幕の翻訳</CardTitle>
        <CardAction>
          <HelpButton topic="字幕の翻訳">
            <div className="flex flex-col gap-2 text-sm">
              <p>コネクターのページの音声認識が確定した発話を英語に訳し、合成ページの字幕で原文の下に出します。話している途中の文は訳しません。</p>
              <p>LLM を選ぶと、直前の2件の発話を手がかりに訳します。DeepL も直前の2件を手がかりにします（その分の文字数は数えられません）。m2m100 は1件ずつ訳します。</p>
              <p>訳せなかったときは原文の字幕だけを出し、理由をコネクターのページとダッシュボードに残します。</p>
            </div>
          </HelpButton>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {actions.feedback}
        <NativeSelect
          aria-label="字幕の翻訳の提供元"
          className="max-w-md"
          value={state.provider}
          disabled={actions.busy}
          onChange={(event) => {
            const provider = TRANSLATION_PROVIDERS.find((candidate) => candidate === event.currentTarget.value)
            if (provider !== undefined) setState({ ...state, provider })
          }}
        >
          {TRANSLATION_PROVIDERS.map((provider) => (
            <NativeSelectOption key={provider} value={provider}>
              {PROVIDER_LABELS[provider]}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        {state.provider === 'deepl' && !state.deeplKeyConfigured && (
          <Alert variant="destructive">
            <AlertTitle>DeepL のAPIキーが設定されていません</AlertTitle>
            <AlertDescription>
              <code>npx wrangler secret put DEEPL_API_KEY</code> で設定してください（ローカルでは <code>.dev.vars</code>）。鍵が無いあいだは訳が出ません。
            </AlertDescription>
          </Alert>
        )}

        {deeplUsage !== undefined && <p className="text-sm">
            DeepL の使用量: <span className="tabular-nums">{formatDeeplUsage(deeplUsage)}</span>
          </p>}
        {deeplUsageFailure !== '' && (
          <Alert variant="destructive">
            <AlertTitle>DeepL の使用量を読み込めませんでした</AlertTitle>
            <AlertDescription>{deeplUsageFailure}</AlertDescription>
          </Alert>
        )}

        <div>
          <Button type="button" disabled={actions.busy} onClick={() => void actions.run(save)}>
            翻訳の設定を保存
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
