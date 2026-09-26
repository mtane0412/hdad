/**
 * チャットの読み上げのページ
 *
 * 読み上げの設定を Worker（KVの speech-settings）に保存し、OBSに貼るURLを出す画面である。
 * 読み上げそのものは素材ページ（speech/reader/）が行い、この画面で保存した設定を定期的に読み直して
 * 次の1件から反映する（issue #86）。以前は設定をすべてURLのクエリに埋めていたため、配信中に音量ひとつ
 * 変えるにもURLを貼り替える必要があった。
 *
 * Workerの呼び出しは api.ts、入力欄の値の変換は form.ts、URLの組み立ては url.ts に分けてテストする。
 * 保存の形（ボタンを押す → Workerを呼ぶ → 成功なら知らせ、失敗なら理由を出す）は usePageActions に合わせる。
 *
 * 注意: 値の範囲の検証は Worker だけが持つ（画面とWorkerで二重に持たない）。そのため入力欄の値は
 * そのまま送り、返ってきた問題点を並べて出す。
 * 注意: ホストとポートは読み上げのページが起動のときにしか使えないので、変えたらOBSの再読み込みが要ることを
 * その場で知らせる。
 * 注意: 設定とbotの接続状態を読めなかったときは、黙って既定や未接続に倒さず理由を出す（Fail-Fast）。
 * 設定を読めないまま入力欄を出すと、配信者が「保存済みの設定はこれだ」と取り違えたまま上書きしてしまう。
 */
import { useEffect, useId, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import type { BotApi } from '@/bot/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/core/api'
import type { SpeechApi, SpeechSettings } from './api'
import { joinIgnoreLogins, numberOf, splitIgnoreLogins } from './form'
import { speechUrl } from './url'

/** VOICEVOX ENGINE を動かせるホスト。ブラウザが混在コンテンツを許すループバックだけに限る（worker/speech-config.ts と同じ） */
const HOST_OPTIONS = ['localhost', '127.0.0.1'] as const

export interface SpeechPageProps {
  /** 読み上げの設定の読み書き */
  api: SpeechApi
  /** botの接続状態の読み出し。接続していれば、そのログイン名を読み上げない人に足せるようにする */
  botApi: Pick<BotApi, 'status'>
  /** オーバーレイ用キー。読み上げのページはこれで設定を読む */
  overlayKey: string | null
}

/** 入力欄が持つ値。数の欄は文字のまま持ち、保存のときに数へ直す（空欄を 0 に丸めないため） */
interface SpeechForm {
  host: string
  port: string
  speaker: string
  speed: string
  volume: string
  maxLength: string
  readName: boolean
  ignoreLogins: string
}

/** 保存済みの設定を入力欄の値にする */
const toForm = (settings: SpeechSettings): SpeechForm => ({
  host: settings.host,
  port: String(settings.port),
  speaker: String(settings.speaker),
  speed: String(settings.speed),
  volume: String(settings.volume),
  maxLength: String(settings.maxLength),
  readName: settings.readName,
  ignoreLogins: joinIgnoreLogins(settings.ignoreLogins),
})

/** 入力欄の値を、Workerへ送る設定にする。範囲の検証はWorkerが行う */
const toSettings = (form: SpeechForm): SpeechSettings => ({
  host: form.host,
  port: numberOf(form.port),
  speaker: numberOf(form.speaker),
  speed: numberOf(form.speed),
  volume: numberOf(form.volume),
  maxLength: numberOf(form.maxLength),
  readName: form.readName,
  ignoreLogins: splitIgnoreLogins(form.ignoreLogins),
})

/** 保存の失敗を画面に出す行にする。Workerが返した問題点は1行ずつ並べる */
const failureLines = (error: unknown): string[] =>
  error instanceof ApiError && error.problems.length > 0
    ? ['読み上げの設定に問題があります。直してから保存し直してください', ...error.problems.map((problem) => `・${problem}`)]
    : [errorMessage(error)]

export const SpeechPage = ({ api, botApi, overlayKey }: SpeechPageProps) => {
  /** 読み込み中は undefined、読めなければ理由（string）、読めたら入力欄の値 */
  const [form, setForm] = useState<SpeechForm>()
  const [loadFailure, setLoadFailure] = useState('')
  /** 保存済みのつなぎ先。入力欄がこれと違えば、OBSの再読み込みが要ると知らせる */
  const [savedEndpoint, setSavedEndpoint] = useState({ host: '', port: '' })
  /** 接続しているbotのログイン名。未接続なら空 */
  const [botLogin, setBotLogin] = useState('')
  /** botの接続状態を読めなかった理由。設定は出したうえで添える（未接続と取り違えないため） */
  const [botFailure, setBotFailure] = useState('')
  const actions = usePageActions(failureLines)
  const urlFieldId = useId()
  const hostFieldId = useId()
  const portFieldId = useId()
  const speakerFieldId = useId()
  const speedFieldId = useId()
  const volumeFieldId = useId()
  const maxLengthFieldId = useId()
  const readNameFieldId = useId()
  const ignoreFieldId = useId()

  useEffect(() => {
    let cancelled = false
    api.load().then(
      (settings) => {
        if (cancelled) return
        setForm(toForm(settings))
        setSavedEndpoint({ host: settings.host, port: String(settings.port) })
      },
      (error: unknown) => {
        if (!cancelled) setLoadFailure(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  useEffect(() => {
    let cancelled = false
    botApi.status().then(
      (status) => {
        if (!cancelled) setBotLogin(status === null ? '' : status.login)
      },
      (error: unknown) => {
        if (!cancelled) setBotFailure(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [botApi])

  if (loadFailure !== '') {
    return (
      <Alert variant="destructive">
        <AlertTitle>読み上げの設定を読み込めませんでした</AlertTitle>
        <AlertDescription>{loadFailure}</AlertDescription>
      </Alert>
    )
  }

  if (!form) return <Skeleton className="h-96 w-full" aria-label="読み上げの設定を読み込んでいます" />

  /** 入力欄の1項目を書き換える */
  const change = <Key extends keyof SpeechForm>(name: Key, value: SpeechForm[Key]): void => setForm({ ...form, [name]: value })

  /** つなぎ先を変えたか。読み上げのページは起動のときにしか読まないので、OBSの再読み込みが要る */
  const endpointChanged = form.host !== savedEndpoint.host || form.port !== savedEndpoint.port

  /** botが接続されていて、まだ読み上げない人に入っていないか */
  const canIgnoreBot =
    botLogin !== '' && !splitIgnoreLogins(form.ignoreLogins).some((login) => login.toLowerCase() === botLogin.toLowerCase())

  const save = async (): Promise<string> => {
    const saved = await api.save(toSettings(form))
    setForm(toForm(saved))
    setSavedEndpoint({ host: saved.host, port: String(saved.port) })
    return '読み上げの設定を保存しました'
  }

  const copyUrl = async (): Promise<string> => {
    if (overlayKey === null) throw new Error('オーバーレイ用キーが発行されていません')
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    await navigator.clipboard.writeText(speechUrl(window.location.origin, overlayKey))
    return 'OBS用のURLをコピーしました'
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      {botFailure !== '' && (
        <Alert variant="destructive">
          <AlertTitle>botの接続状態を読めませんでした</AlertTitle>
          <AlertDescription>{botFailure}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>読み上げの設定</CardTitle>
          <CardDescription>同じPCの VOICEVOX に読み上げさせる。保存すると次に読む1件から効く。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={speakerFieldId}>話者ID</Label>
            <Input
              id={speakerFieldId}
              type="number"
              min={0}
              step={1}
              value={form.speaker}
              onChange={(event) => change('speaker', event.currentTarget.value)}
            />
            <p className="text-sm text-muted-foreground">3 はずんだもん（ノーマル）。</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={speedFieldId}>読み上げ速度</Label>
            <Input
              id={speedFieldId}
              type="number"
              min={0.5}
              max={2}
              step={0.1}
              value={form.speed}
              onChange={(event) => change('speed', event.currentTarget.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={volumeFieldId}>音量</Label>
            <Input
              id={volumeFieldId}
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={form.volume}
              onChange={(event) => change('volume', event.currentTarget.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={maxLengthFieldId}>長さの上限（文字）</Label>
            <Input
              id={maxLengthFieldId}
              type="number"
              min={1}
              max={200}
              step={1}
              value={form.maxLength}
              onChange={(event) => change('maxLength', event.currentTarget.value)}
            />
            <p className="text-sm text-muted-foreground">これより長い発言は途中まで読む。</p>
          </div>

          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor={ignoreFieldId}>読み上げない人（ログイン名をカンマ区切り）</Label>
            <Input
              id={ignoreFieldId}
              autoComplete="off"
              placeholder="hdad_bot, nightbot"
              value={form.ignoreLogins}
              onChange={(event) => change('ignoreLogins', event.currentTarget.value)}
            />
            {canIgnoreBot && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => change('ignoreLogins', joinIgnoreLogins([...splitIgnoreLogins(form.ignoreLogins), botLogin]))}
              >
                {/* 画面では短く出し、読み上げの名前には何に足すのかを含める */}
                {botLogin} を<span className="sr-only">読み上げない人に</span>足す
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox id={readNameFieldId} checked={form.readName} onCheckedChange={(checked) => change('readName', checked === true)} />
            <Label htmlFor={readNameFieldId}>発言者の名前も読む</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>VOICEVOX のつなぎ先</CardTitle>
          <CardDescription>変えたらOBSでブラウザソースを再読み込みする。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={hostFieldId}>ホスト</Label>
            <NativeSelect id={hostFieldId} className="w-full" value={form.host} onChange={(event) => change('host', event.currentTarget.value)}>
              {HOST_OPTIONS.map((host) => (
                <NativeSelectOption key={host} value={host}>
                  {host}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-sm text-muted-foreground">ふつうは localhost のまま使う。</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={portFieldId}>ポート番号</Label>
            <Input
              id={portFieldId}
              type="number"
              min={1}
              max={65535}
              step={1}
              value={form.port}
              onChange={(event) => change('port', event.currentTarget.value)}
            />
          </div>

          {endpointChanged && (
            <Alert className="sm:col-span-2">
              <AlertTitle>OBSの再読み込みが必要です</AlertTitle>
              <AlertDescription>保存したあと、OBSでブラウザソースを再読み込みしてください</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <div>
        <Button type="button" disabled={actions.busy} onClick={() => void actions.run(save)}>
          設定を保存
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>OBS用のURL</CardTitle>
          <CardDescription>ブラウザソースに貼り、「OBSで音声を制御する」を有効にする。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {overlayKey === null ? (
            <Alert variant="destructive">
              <AlertTitle>OBS用のURLを表示できません</AlertTitle>
              <AlertDescription>オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください</AlertDescription>
            </Alert>
          ) : (
            <>
              <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
              <div className="flex gap-2">
                {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
                <Input id={urlFieldId} type="password" readOnly autoComplete="off" value={speechUrl(window.location.origin, overlayKey)} />
                <Button type="button" disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
                  URLをコピー
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>VOICEVOX 側の設定（最初の1回だけ）</CardTitle>
          <CardDescription>VOICEVOX は既定でこのサイトからの読み出しを拒むので、許可しないとつながらない。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            配信に使うPCで <code>http://{form.host}:{form.port}/setting</code> を開き、CORSの許可するオリジンに{' '}
            <code>{window.location.origin}</code> を足して保存し、VOICEVOX を再起動する。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
