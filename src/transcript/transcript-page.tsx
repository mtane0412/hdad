/**
 * 文字起こしのページ
 *
 * 配信中に喋った内容を Worker へ取り込むための、OBSに貼るURLを出す。取り込みそのものは
 * OBSのブラウザソースに置く中継ページ（transcript/relay/index.html）が行い、この画面はその案内だけを受け持つ。
 *
 * 中継ページは同じPCで動いているゆかりねっとコネクターNEO（ゆかコネNEO）の WebSocket につなぐので、
 * ポート番号だけは配信者の環境で変わりうる。既定（11901）と違うときはURLに書き足す。
 *
 * URLの組み立ては url.ts に分けてテストする。オーバーレイ用キーはアプリの枠から受け取り、
 * 再発行はトリガーのページ（/triggers/）が受け持つ（キーはアラートと共通のため、出し先を2つに分けない）。
 *
 * 注意: ポートが読めない値ならURLを出さず、理由を画面に出す（Fail-Fast）。
 */
import { useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { DEFAULT_TRANSCRIPT_PORT, relayUrl } from './url'

/** ブラウザソースに設定する推奨の大きさ。配信画面には映さないので、状態を読める最小限でよい */
const RELAY_SIZE = { width: 600, height: 400 }

export const TranscriptPage = ({ overlayKey }: { overlayKey: string | null }) => {
  const [port, setPort] = useState(String(DEFAULT_TRANSCRIPT_PORT))
  const actions = usePageActions()
  const urlFieldId = useId()
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
    url = relayUrl(window.location.origin, overlayKey, Number(port.trim()))
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
          <CardDescription>ゆかコネNEO の音声認識の結果を取り込む。配信画面には映らないので、表示はオフでよい。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor={portFieldId}>ゆかコネNEO のポート番号</Label>
          <Input
            id={portFieldId}
            inputMode="numeric"
            value={port}
            onChange={(event) => setPort(event.target.value)}
            className="max-w-40"
          />
          <p className="text-sm text-muted-foreground">既定は {DEFAULT_TRANSCRIPT_PORT}。</p>

          {urlFailure === '' ? (
            <>
              <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
              <p id={sizeHintId} className="text-sm text-muted-foreground">
                推奨の大きさ: {RELAY_SIZE.width} × {RELAY_SIZE.height} px
              </p>
              <div className="flex gap-2">
                {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
                <Input id={urlFieldId} type="password" readOnly autoComplete="off" value={url} aria-describedby={sizeHintId} />
                <Button type="button" disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
                  URLをコピー
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
