/**
 * サイドスーパーのページ
 *
 * 配信画面の隅に出すテロップ（サイドスーパー）を、OBSに貼るURLとして出す。文言そのものは cron
 * （worker/collect.ts）が5分おきに作って貯めるので、この画面は案内と、出す位置の選択だけを受け持つ。
 *
 * URLの組み立ては url.ts に分けてテストする。オーバーレイ用キーはアプリの枠から受け取り、
 * 再発行はトリガーのページ（/triggers/）が受け持つ（キーはアラート・文字起こしと共通のため、出し先を増やさない）。
 *
 * 文言は cron が作るものなので、配信していないあいだや作られる前は何も映らない。それでは見栄えを
 * 確かめられないため、サンプルを流すデモ（?demo=true）へのリンクも出す。オーバーレイはアプリの外なので、
 * 画面の移動（router.tsx の Link）ではなく普通の `<a>` で、別のタブに開く。
 */
import { useId, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { usePageActions } from '@/admin/page-actions'
import { DEFAULT_SIDE_SUPER_POSITION, sideSuperDemoUrl, sideSuperUrl, type SideSuperPosition } from './url'

/** ブラウザソースに設定する推奨の大きさ。配信画面と同じ大きさにして、隅の余白ごと重ねる */
const OVERLAY_SIZE = { width: 1920, height: 1080 }

/** 出す位置の選択肢 */
const POSITION_OPTIONS: readonly { value: SideSuperPosition; label: string }[] = [
  { value: 'left', label: '左上' },
  { value: 'right', label: '右上' },
]

export const SideSuperPage = ({ overlayKey }: { overlayKey: string | null }) => {
  const [position, setPosition] = useState<SideSuperPosition>(DEFAULT_SIDE_SUPER_POSITION)
  const actions = usePageActions()
  const urlFieldId = useId()
  const positionFieldId = useId()
  const sizeHintId = useId()

  if (overlayKey === null) {
    return (
      <Alert variant="destructive">
        <AlertTitle>OBS用のURLを表示できません</AlertTitle>
        <AlertDescription>オーバーレイ用キーが発行されていません。ログアウトしてログインし直してください</AlertDescription>
      </Alert>
    )
  }

  const url = sideSuperUrl(window.location.origin, overlayKey, position)
  const demoUrl = sideSuperDemoUrl(window.location.origin, position)

  const copyUrl = async (): Promise<string> => {
    // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる
    if (!navigator.clipboard) throw new Error('このページではクリップボードを使えません（https か localhost で開いてください）')
    await navigator.clipboard.writeText(url)
    return 'OBS用のURLをコピーしました'
  }

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}

      <Card>
        <CardHeader>
          <CardTitle>OBS用のURL</CardTitle>
          <CardDescription>配信画面の隅に、いまの話題を2行のテロップで出し続ける。5分おきに作り直す。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor={positionFieldId}>出す位置</Label>
          <NativeSelect
            id={positionFieldId}
            className="max-w-40"
            value={position}
            onChange={(event) => setPosition(event.currentTarget.value === 'right' ? 'right' : 'left')}
          >
            {POSITION_OPTIONS.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>

          <Label htmlFor={urlFieldId}>OBSのブラウザソースに貼るURL</Label>
          <p id={sizeHintId} className="text-sm text-muted-foreground">
            推奨の大きさ: {OVERLAY_SIZE.width} × {OVERLAY_SIZE.height} px（配信画面と同じ大きさ）
          </p>
          <div className="flex gap-2">
            {/* URLにはオーバーレイ用キーが含まれる。配信画面に映り込んでも読めないよう、伏せ字で表示する */}
            <Input id={urlFieldId} type="password" readOnly autoComplete="off" value={url} aria-describedby={sizeHintId} />
            <Button type="button" disabled={actions.busy} onClick={() => void actions.run(copyUrl)}>
              URLをコピー
            </Button>
          </div>

          <div className="flex items-center gap-3">
            {/* オーバーレイはアプリの外なので、router.tsx の Link ではなく普通の `<a>` で開く */}
            <a className={buttonVariants({ variant: 'outline' })} href={demoUrl} target="_blank" rel="noreferrer">
              デモを開く
            </a>
            <p className="text-sm text-muted-foreground">サンプルの文言で見た目と配置を確かめる。</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
