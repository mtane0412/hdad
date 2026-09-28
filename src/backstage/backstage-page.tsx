/**
 * 裏方のページ
 *
 * 映すものを持たない裏方（チャットの読み上げ・文字起こしの中継・配信画面の取り込み）を1つのブラウザソースで動かすための、
 * OBSに貼るURLを出す（issue #108）。裏方そのものは overlay/backstage/index.html が行い、この画面は
 * その案内だけを受け持つ（文字起こしのページ・サイドスーパーのページと同じ形）。
 *
 * どの裏方を動かすかは「このブラウザソースが何をするか」という構造の指定なので、Worker には保存せず
 * URLに載せる（合成ページの ?overlay=<名前> と同じ扱い）。読み上げの設定（話者・速度・音量など）は
 * 今までどおり Worker が持ち、/speech/ で変える。
 *
 * URLの組み立ては url.ts に分けてテストする。オーバーレイ用キーはアプリの枠から受け取り、
 * 再発行はトリガーのページ（/triggers/）が受け持つ。
 *
 * 注意: ポートが読めない値・裏方をひとつも選んでいないときはURLを出さず、理由を画面に出す（Fail-Fast）。
 */
import { Copy } from 'lucide-react'
import { useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { DEFAULT_TRANSCRIPT_PORT } from '@/transcript/url'
import { iconButtonName } from '@/core/icon-button'
import { backstageUrl } from './url'

/** ブラウザソースに設定する推奨の大きさ。配信画面には映さないので、状態を読める最小限でよい */
const BACKSTAGE_SIZE = { width: 600, height: 600 }

export const BackstagePage = ({ overlayKey }: { overlayKey: string | null }) => {
  const [speech, setSpeech] = useState(true)
  const [transcript, setTranscript] = useState(true)
  // 画面の取り込みは既定で外す。OBSのWebSocketサーバーと Gyazo のアクセストークンの両方が要るためである
  const [screen, setScreen] = useState(false)
  const [port, setPort] = useState(String(DEFAULT_TRANSCRIPT_PORT))
  const actions = usePageActions()
  const urlFieldId = useId()
  const speechFieldId = useId()
  const transcriptFieldId = useId()
  const screenFieldId = useId()
  const portFieldId = useId()
  const sizeHintId = useId()

  if (overlayKey === null) {
    return (
      <Alert variant="destructive">
        <AlertTitle>OBS用のURLを表示できません</AlertTitle>
        <AlertDescription>オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください</AlertDescription>
      </Alert>
    )
  }

  let url: string
  let urlFailure = ''
  try {
    url = backstageUrl(window.location.origin, overlayKey, { speech, transcript, screen, port: Number(port.trim()) })
  } catch (error) {
    url = ''
    urlFailure = errorMessage(error)
  }

  const copyUrl = async (): Promise<string> => {
    await navigator.clipboard.writeText(url)
    return 'OBS用のURLをコピーしました'
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>OBS用のURL</CardTitle>
          {/* 「表示をオフにしてよい」とは書かない。OBSの「非アクティブ時にソースをシャットダウン」が有効だと、
              非表示にした時点でこのページが閉じられ、読み上げも取り込みも止まってしまう */}
          <CardDescription>
            配信画面に映すものを持たない裏方を、1つのブラウザソースでまとめて動かす。見えない位置に置いてよい。どちらも同じPCの
            VOICEVOX ENGINE・ゆかコネNEO につなぐので、OBSと同じPCで開く必要がある。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Checkbox id={speechFieldId} checked={speech} onCheckedChange={(checked) => setSpeech(checked === true)} />
            <Label htmlFor={speechFieldId}>チャットの読み上げ</Label>
          </div>
          <p className="text-sm text-muted-foreground">話者・速度・音量などの設定は「読み上げ」のページで変える。</p>

          <div className="flex items-center gap-2">
            <Checkbox id={transcriptFieldId} checked={transcript} onCheckedChange={(checked) => setTranscript(checked === true)} />
            <Label htmlFor={transcriptFieldId}>文字起こしの中継</Label>
          </div>

          {/* ポートはゆかコネNEO へのつなぎ先なので、中継を動かすときだけ出す（使われない入力欄を残さない） */}
          {transcript && (
            <>
              <Label htmlFor={portFieldId}>ゆかコネNEO のポート番号</Label>
              <Input
                id={portFieldId}
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value)}
                className="max-w-40"
              />
              <p className="text-sm text-muted-foreground">既定は {DEFAULT_TRANSCRIPT_PORT}。</p>
            </>
          )}

          <div className="flex items-center gap-2">
            <Checkbox id={screenFieldId} checked={screen} onCheckedChange={(checked) => setScreen(checked === true)} />
            <Label htmlFor={screenFieldId}>配信画面の取り込み</Label>
          </div>
          <p className="text-sm text-muted-foreground">
            OBSのつなぎ先と撮る間隔は「画面の取り込み」のページで変える。Worker 側に Gyazo のアクセストークンが要る。
          </p>

          {urlFailure === '' ? (
            <>
              <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
              <p id={sizeHintId} className="text-sm text-muted-foreground">
                推奨の大きさ: {BACKSTAGE_SIZE.width} × {BACKSTAGE_SIZE.height} px
              </p>
              <div className="flex gap-2">
                {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
                <Input id={urlFieldId} type="password" readOnly autoComplete="off" value={url} aria-describedby={sizeHintId} />
                <Button type="button" size="icon" {...iconButtonName('URLをコピー')} disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
                  <Copy aria-hidden="true" />
                </Button>
              </div>
            </>
          ) : (
            <Alert variant="destructive">
              <AlertTitle>URLを組み立てられません</AlertTitle>
              <AlertDescription>{urlFailure}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
