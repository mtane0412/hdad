/**
 * コネクターのページの VOICEVOX（チャットの読み上げ）の区画
 *
 * 読み上げの設定を Worker（KVの speech-settings）に保存する。読み上げそのものはOBSに載せる裏方のページ
 * （overlay/backstage/）が行い、この区画で保存した設定を定期的に読み直して次の1件から反映する（issue #86）。
 * OBSに貼るURLはこの区画では出さず、コネクターのページの「OBS用のURL」が出す（読み上げ単独のページ
 * speech/reader/ は、貼ってあるブラウザソースのために残してあるが案内しない）。
 *
 * Workerの呼び出しは api.ts、入力欄の値の変換は form.ts に分けてテストする。
 * 保存の形（ボタンを押す → Workerを呼ぶ → 成功なら知らせ、失敗なら理由を出す）は usePageActions に合わせる。
 * 入力欄の目安と VOICEVOX 側の設定（CORS）は、画面に並べずヘルプボタンの中で案内する。
 *
 * 注意: 値の範囲の検証は Worker だけが持つ（画面とWorkerで二重に持たない）。そのため入力欄の値は
 * そのまま送り、返ってきた問題点を並べて出す。
 * 注意: ホストとポートは裏方のページが起動のときにしか使えないので、変えたらOBSの再読み込みが要ることを
 * その場で知らせる。
 * 注意: 設定とbotの接続状態を読めなかったときは、黙って既定や未接続に倒さず理由を出す（Fail-Fast）。
 * 設定を読めないまま入力欄を出すと、配信者が「保存済みの設定はこれだ」と取り違えたまま上書きしてしまう。
 */
import { Plus } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import type { BotApi } from '@/bot/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { HelpButton } from '@/components/help-button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import { ApiError } from '@/core/api'
import { iconButtonName } from '@/core/icon-button'
import type { SpeechApi, SpeechSettings } from './api'
import { joinIgnoreLogins, numberOf, splitIgnoreLogins } from './form'

/** VOICEVOX ENGINE を動かせるホスト。ブラウザが混在コンテンツを許すループバックだけに限る（worker/speech-config.ts と同じ） */
const HOST_OPTIONS = ['localhost', '127.0.0.1'] as const

export interface SpeechSectionProps {
  /** 読み上げの設定の読み書き */
  api: SpeechApi
  /** botの接続状態の読み出し。接続していれば、そのログイン名を読み上げない人に追加できるようにする */
  botApi: Pick<BotApi, 'status'>
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

export const SpeechSection = ({ api, botApi }: SpeechSectionProps) => {
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
      <LoadFailure title="読み上げの設定を読み込めませんでした" message={loadFailure} />
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
          <CardTitle>VOICEVOX</CardTitle>
          <CardAction>
            <HelpButton topic="VOICEVOX">
              <p>同じPCの VOICEVOX にチャットを読み上げさせます。保存すると次に読む1件から効きます。</p>
              <p>
                はじめに一度だけ、配信に使うPCで <code>http://{form.host}:{form.port}/setting</code> を開き、CORSの許可するオリジンに{' '}
                <code>{window.location.origin}</code> を追加して保存し、VOICEVOX を再起動します（既定ではこのサイトからの読み出しを拒むため）。
              </p>
              <p>話者IDの 3 はずんだもん（ノーマル）です。長さの上限より長い発言は途中まで読みます。</p>
            </HelpButton>
          </CardAction>
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
                {...iconButtonName(`${botLogin} を読み上げない人に追加する`)}
                onClick={() => change('ignoreLogins', joinIgnoreLogins([...splitIgnoreLogins(form.ignoreLogins), botLogin]))}
              >
                {/* 画面には＋とbotの名前だけを出し、読み上げとホバーの名前には何に追加するのかを含める（見えている名前を含むので音声でも呼べる） */}
                <Plus aria-hidden="true" />
                {botLogin}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox id={readNameFieldId} checked={form.readName} onCheckedChange={(checked) => change('readName', checked === true)} />
            <Label htmlFor={readNameFieldId}>発言者の名前も読む</Label>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={hostFieldId}>ホスト</Label>
            <NativeSelect id={hostFieldId} className="w-full" value={form.host} onChange={(event) => change('host', event.currentTarget.value)}>
              {HOST_OPTIONS.map((host) => (
                <NativeSelectOption key={host} value={host}>
                  {host}
                </NativeSelectOption>
              ))}
            </NativeSelect>
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
