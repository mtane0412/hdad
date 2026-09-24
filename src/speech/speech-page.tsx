/**
 * チャットの読み上げのページ
 *
 * OBSのブラウザソースに貼るURLを出すだけの画面で、読み上げそのものは素材ページ（speech/reader/）が行う
 * （文字起こし・サイドスーパーのページと同じ作り）。URLの組み立ては url.ts に分けてテストする。
 *
 * 読み上げは VOICEVOX（同じPCで動かす）に任せるので、Workerの設定は何も持たない。そのため保存の操作もなく、
 * 入力を変えるたびにURLが変わる。オーバーレイ用キーも要らない（読み上げは匿名IRCとキーの要らない公開APIだけで動く）。
 *
 * 注意: 接続しているbotのログイン名を「読み上げない人」として自動で入れる。botの応答まで読み上げると、
 * 読み上げた声にbotが応え続けるような聞こえ方になるためである。接続状態を読めなかったときは未接続扱いにせず
 * 理由を出す（/triggers/ と同じ扱い）。
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
import { DEFAULT_SPEECH_SETTINGS, speechUrl } from './url'

export interface SpeechPageProps {
  /** botの接続状態の読み出し。接続していれば、そのログイン名を読み上げない人にする */
  botApi: Pick<BotApi, 'status'>
}

/** 入力欄の文字を数にする。空欄は 0 ではなく「数でない」として扱う（url.ts がエラーにする） */
const numberOf = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw))

export const SpeechPage = ({ botApi }: SpeechPageProps) => {
  const [port, setPort] = useState(String(DEFAULT_SPEECH_SETTINGS.port))
  const [speaker, setSpeaker] = useState(String(DEFAULT_SPEECH_SETTINGS.speaker))
  const [speed, setSpeed] = useState(String(DEFAULT_SPEECH_SETTINGS.speed))
  const [volume, setVolume] = useState(String(DEFAULT_SPEECH_SETTINGS.volume))
  const [maxLength, setMaxLength] = useState(String(DEFAULT_SPEECH_SETTINGS.maxLength))
  const [readName, setReadName] = useState(DEFAULT_SPEECH_SETTINGS.readName)
  /** 読み上げない人（接続しているbot）。読めていないあいだは空 */
  const [ignoreLogins, setIgnoreLogins] = useState<readonly string[]>([])
  // botの接続状態を読めなかった理由。URLは出したうえで添える（未接続と取り違えないため）
  const [botFailure, setBotFailure] = useState('')
  const actions = usePageActions()
  const urlFieldId = useId()
  const portFieldId = useId()
  const speakerFieldId = useId()
  const speedFieldId = useId()
  const volumeFieldId = useId()
  const maxLengthFieldId = useId()
  const readNameFieldId = useId()

  useEffect(() => {
    let cancelled = false
    botApi.status().then(
      (status) => {
        if (!cancelled) setIgnoreLogins(status === null ? [] : [status.login])
      },
      (error: unknown) => {
        if (!cancelled) setBotFailure(`botの接続状態を読めませんでした: ${errorMessage(error)}`)
      },
    )
    return () => {
      cancelled = true
    }
  }, [botApi])

  /** 入力の値からURLを組み立てる。読めない値があれば、URLの代わりに理由を出す */
  const built = ((): { url: string } | { problem: string } => {
    try {
      return {
        url: speechUrl(window.location.origin, {
          ...DEFAULT_SPEECH_SETTINGS,
          port: numberOf(port),
          speaker: numberOf(speaker),
          speed: numberOf(speed),
          volume: numberOf(volume),
          maxLength: numberOf(maxLength),
          readName,
          ignoreLogins,
        }),
      }
    } catch (error) {
      return { problem: errorMessage(error) }
    }
  })()

  const copyUrl = async (): Promise<string> => {
    if (!('url' in built)) throw new Error(built.problem)
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    await navigator.clipboard.writeText(built.url)
    return 'OBS用のURLをコピーしました'
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      {botFailure !== '' && (
        <Alert variant="destructive">
          <AlertTitle>botの接続状態を読めませんでした</AlertTitle>
          <AlertDescription>{botFailure} そのため、botの発言を読み上げない設定が入っていません</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>読み上げの設定</CardTitle>
          <CardDescription>
            同じPCで動かす VOICEVOX に読み上げさせる。設定を変えるとURLが変わるので、変えたら貼り替える。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor={speakerFieldId}>話者ID</Label>
            <Input id={speakerFieldId} type="number" min={0} step={1} value={speaker} onChange={(event) => setSpeaker(event.currentTarget.value)} />
            <p className="text-sm text-muted-foreground">VOICEVOX のキャラクターとスタイルの組み合わせ。既定の 3 はずんだもんのノーマル。</p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={portFieldId}>VOICEVOX のポート番号</Label>
            <Input id={portFieldId} type="number" min={1} max={65535} step={1} value={port} onChange={(event) => setPort(event.currentTarget.value)} />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={speedFieldId}>読み上げ速度</Label>
            <Input id={speedFieldId} type="number" min={0.5} max={2} step={0.1} value={speed} onChange={(event) => setSpeed(event.currentTarget.value)} />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={volumeFieldId}>音量</Label>
            <Input id={volumeFieldId} type="number" min={0} max={1} step={0.1} value={volume} onChange={(event) => setVolume(event.currentTarget.value)} />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={maxLengthFieldId}>読み上げる長さの上限（文字）</Label>
            <Input
              id={maxLengthFieldId}
              type="number"
              min={1}
              max={200}
              step={1}
              value={maxLength}
              onChange={(event) => setMaxLength(event.currentTarget.value)}
            />
            <p className="text-sm text-muted-foreground">長い発言は途中まで読む。読み終わるまで次の発言を待たせないため。</p>
          </div>

          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox id={readNameFieldId} checked={readName} onCheckedChange={(checked) => setReadName(checked === true)} />
            <Label htmlFor={readNameFieldId}>発言者の名前も読む</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>OBS用のURL</CardTitle>
          <CardDescription>ブラウザソースに貼り、「OBSで音声を制御する」を有効にする（映すものは無いので大きさは任意）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {'problem' in built ? (
            <Alert variant="destructive">
              <AlertTitle>URLを組み立てられません</AlertTitle>
              <AlertDescription>{built.problem}</AlertDescription>
            </Alert>
          ) : (
            <>
              <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
              <div className="flex gap-2">
                {/* このURLにはオーバーレイ用キーが入らないので、伏せ字にしなくてよい */}
                <Input id={urlFieldId} readOnly autoComplete="off" value={built.url} />
                <Button type="button" disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
                  URLをコピー
                </Button>
              </div>
            </>
          )}
          {ignoreLogins.length > 0 && <p className="text-sm text-muted-foreground">botアカウント（{ignoreLogins.join('・')}）の発言は読み上げない。</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>使うときの前提</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>配信に使うPCで VOICEVOX を起動しておく。起動していないと、ブラウザソースに理由が表示される。</p>
          <p>読み上げるのはこのチャンネルのチャットで、コマンド（!で始まる発言）・エモートだけの発言は読まない。</p>
          <p>URLは「URL」と読み替え、同じ文字の連打は2文字に縮める。聞いても分からないものを読ませないため。</p>
          <p>チャットが速いときは古い発言を捨てて、新しい発言から読む。</p>
        </CardContent>
      </Card>
    </div>
  )
}
