/**
 * 配信画面の取り込みのページ
 *
 * 画面の取り込みの設定を Worker（KVの screen-settings）に保存する画面である。取り込みそのものはOBSに載せる
 * 裏方のページ（overlay/backstage/）が行い、この画面で保存した設定を撮るたびに読み直す（issue #122）。
 * 読み上げのページ（src/speech/speech-page.tsx）と同じ形で、Workerの呼び出しは api.ts に分けてテストする。
 *
 * OBSに貼るURLはここでは出さない。画面の取り込みは裏方のページの一部として動くので、URLは
 * 「裏方」のページ（/backstage/）が出す（そこで取り込みを動かすかどうかも選ぶ）。
 *
 * 注意: 値の範囲の検証は Worker だけが持つ（画面とWorkerで二重に持たない）。そのため入力欄の値は
 * そのまま送り、返ってきた問題点を並べて出す。空欄も 0 に丸めず、数として読めない値のまま送る。
 * 注意: ホスト・ポート・パスワードは裏方のページが起動のときにしか使えないので、変えたらOBSの再読み込みが
 * 要ることをその場で知らせる（読み上げと同じ）。
 * 注意: 設定を読めなかったときは、黙って既定に倒さず理由を出す（Fail-Fast）。読めないまま入力欄を出すと、
 * 配信者が「保存済みの設定はこれだ」と取り違えたまま上書きしてしまう。
 */
import { useEffect, useId, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/core/api'
import type { ScreenAdminApi, ScreenSettings } from './api'

/** OBS を動かせるホスト。ブラウザが混在コンテンツを許すループバックだけに限る（worker/screen-config.ts と同じ） */
const HOST_OPTIONS = ['localhost', '127.0.0.1'] as const

export interface ScreenPageProps {
  /** 画面の取り込みの設定の読み書き */
  api: ScreenAdminApi
}

/** 入力欄が持つ値。数の欄は文字のまま持ち、保存のときに数へ直す（空欄を 0 に丸めないため） */
interface ScreenForm {
  host: string
  port: string
  password: string
  intervalSeconds: string
  collectionId: string
}

/** 入力欄の文字を数にする。空欄や数として読めない文字は NaN（Workerが理由を返す） */
const numberOf = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw))

/** コレクションのURL（https://gyazo.com/collections/<ID>）。貼られたURLからIDを取り出すために使う */
const COLLECTION_URL_PATTERN = /^https:\/\/gyazo\.com\/collections\/([^/?#]+)/

/**
 * コレクションの入力欄の文字をIDにする。
 *
 * Gyazo の画面からはURLごとコピーするのが自然なので、URLを貼られたらその末尾のIDを取り出す。
 * 取り出せない文字はそのまま送り、正しいIDかどうかは Worker に確かめさせる（検証は二重に持たない）。
 */
const collectionIdOf = (raw: string): string => {
  const trimmed = raw.trim()
  return COLLECTION_URL_PATTERN.exec(trimmed)?.[1] ?? trimmed
}

/** 保存済みの設定を入力欄の値にする */
const toForm = (settings: ScreenSettings): ScreenForm => ({
  host: settings.host,
  port: String(settings.port),
  password: settings.password,
  intervalSeconds: String(settings.intervalSeconds),
  collectionId: settings.collectionId,
})

/** 入力欄の値を、Workerへ送る設定にする。範囲の検証はWorkerが行う */
const toSettings = (form: ScreenForm): ScreenSettings => ({
  host: form.host,
  port: numberOf(form.port),
  password: form.password,
  intervalSeconds: numberOf(form.intervalSeconds),
  collectionId: collectionIdOf(form.collectionId),
})

/** 保存の失敗を画面に出す行にする。Workerが返した問題点は1行ずつ並べる */
const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['画面の取り込みの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${problem}`)]
    : [errorMessage(error)]

/** つなぎ先（起動のときにしか使えない項目）を変えたか */
const endpointOf = (form: ScreenForm): string => [form.host, form.port, form.password].join('\u0000')

export const ScreenPage = ({ api }: ScreenPageProps) => {
  /** 読み込み中は undefined、読めたら入力欄の値 */
  const [form, setForm] = useState<ScreenForm>()
  const [loadFailure, setLoadFailure] = useState('')
  /** 保存済みのつなぎ先。入力欄がこれと違えば、OBSの再読み込みが要ると知らせる */
  const [savedEndpoint, setSavedEndpoint] = useState('')
  const actions = usePageActions(failureLines)
  const hostFieldId = useId()
  const portFieldId = useId()
  const passwordFieldId = useId()
  const intervalFieldId = useId()
  const collectionFieldId = useId()

  useEffect(() => {
    let cancelled = false
    api.load().then(
      (settings) => {
        if (cancelled) return
        setForm(toForm(settings))
        setSavedEndpoint(endpointOf(toForm(settings)))
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
      <LoadFailure title="画面の取り込みの設定を読み込めませんでした" message={loadFailure} />
    )
  }

  if (!form) return <Skeleton className="h-96 w-full" aria-label="画面の取り込みの設定を読み込んでいます" />

  /** 入力欄の1項目を書き換える */
  const change = <Key extends keyof ScreenForm>(name: Key, value: ScreenForm[Key]): void => setForm({ ...form, [name]: value })

  const endpointChanged = endpointOf(form) !== savedEndpoint

  const save = async (): Promise<string> => {
    const saved = await api.save(toSettings(form))
    setForm(toForm(saved))
    setSavedEndpoint(endpointOf(toForm(saved)))
    return '画面の取り込みの設定を保存しました'
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>画面の取り込みの設定</CardTitle>
          <CardDescription>
            同じPCのOBS（ツール &gt; WebSocketサーバー設定）につなぎ、いま映しているシーンを一定の間隔で1枚撮る。撮った画面に出ている文字は、あらすじとサイドスーパーの材料になる。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={hostFieldId}>OBS のホスト</Label>
            <NativeSelect id={hostFieldId} value={form.host} onChange={(event) => change('host', event.currentTarget.value)}>
              {HOST_OPTIONS.map((host) => (
                <NativeSelectOption key={host} value={host}>
                  {host}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-sm text-muted-foreground">OBSと同じPCで開くので、ふつうは localhost のままでよい。</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={portFieldId}>obs-websocket のポート番号</Label>
            <Input
              id={portFieldId}
              type="number"
              min={1}
              max={65535}
              step={1}
              value={form.port}
              onChange={(event) => change('port', event.currentTarget.value)}
            />
            <p className="text-sm text-muted-foreground">既定は 4455。</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={passwordFieldId}>obs-websocket のパスワード</Label>
            {/* 配信画面に映り込んでも読めないよう伏せ字にする（オーバーレイ用キーと同じ扱い） */}
            <Input
              id={passwordFieldId}
              type="password"
              autoComplete="off"
              value={form.password}
              onChange={(event) => change('password', event.currentTarget.value)}
            />
            <p className="text-sm text-muted-foreground">OBSで認証を切っているなら空にする。</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={intervalFieldId}>撮る間隔（秒）</Label>
            <Input
              id={intervalFieldId}
              type="number"
              min={15}
              max={600}
              step={1}
              value={form.intervalSeconds}
              onChange={(event) => change('intervalSeconds', event.currentTarget.value)}
            />
            <p className="text-sm text-muted-foreground">短くするほどOBSの負荷が上がる。60秒から始めて様子を見る。</p>
          </div>

          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor={collectionFieldId}>上げ先の Gyazo のコレクション（任意）</Label>
            <Input
              id={collectionFieldId}
              autoComplete="off"
              placeholder="https://gyazo.com/collections/..."
              value={form.collectionId}
              onChange={(event) => change('collectionId', event.currentTarget.value)}
            />
            <p className="text-sm text-muted-foreground">
              コレクションのURLを貼ると、その末尾のIDを取り出して保存する。空にすると、どのコレクションにも入れずに上げる。
            </p>
          </div>

          {endpointChanged && (
            <Alert className="sm:col-span-2">
              <AlertTitle>OBSの再読み込みが要ります</AlertTitle>
              <AlertDescription>
                ホスト・ポート・パスワードは、裏方のページが起動のときにしか使いません。保存したあと、OBSでそのブラウザソースを再読み込みしてください。
              </AlertDescription>
            </Alert>
          )}

          <div className="sm:col-span-2">
            <Button type="button" disabled={actions.busy} onClick={() => void actions.run(save)}>
              保存
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
