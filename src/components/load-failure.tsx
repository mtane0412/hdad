/**
 * ページの中身を読み込めなかったときの表示
 *
 * 何を読めなかったかと理由を出し、その場で読み込み直せるボタンを添える。
 * 一時的な失敗（Workerの再起動・回線の瞬断）なら、押すだけで立て直せるようにするため。
 *
 * 注意: 失敗を隠さず必ず出す（Fail-Fast）。読み込み直しの既定はページの再読み込み。
 */
import { RotateCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/**
 * @param title 何を読み込めなかったか
 * @param message 失敗の理由
 * @param onRetry 読み込み直す処理。渡さなければページを再読み込みする
 */
export const LoadFailure = ({
  title,
  message,
  onRetry = () => window.location.reload(),
}: {
  title: string
  message: React.ReactNode
  onRetry?: () => void
}) => (
  <Alert variant="destructive">
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="space-y-3">
      <p>{message}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        <RotateCw aria-hidden="true" />
        もう一度読み込む
      </Button>
    </AlertDescription>
  </Alert>
)
