/**
 * 下部バーに置く「演出を消す」ボタン
 *
 * どのページを見ていても、合成ページに出ている演出（アラート・市町村紹介・ツイスター・ペロペロ・
 * 解説に入った漢字クイズ・終えたチャットで推理・締め切った意見ボード）を、決まった時間を待たずにまとめて消せるようにする。
 * 待っている演出はそのまま流す（何をどう消すかは合成ページの src/overlay/stage.ts の watchDismiss が決める）。
 *
 * 配信中にすぐ消したいので、確かめのダイアログは挟まない（消しても次の演出は止まらず、取り返しのつかない操作ではない）。
 * ボタンは下部バーのほかの操作に合わせ、文字を出さずアイコンだけにする（名前は読み上げとホバーで出す）。
 *
 * 注意: 断られたときは、黙らずに理由を出す（Fail-Fast。消せたつもりで配信を続けないため）。
 */
import { Eraser } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import { Button } from '@/components/ui/button'
import { iconButtonName } from '@/core/icon-button'
import { createOverlayDismissApi, type OverlayDismissApi } from './dismiss'

const defaultApi = createOverlayDismissApi((input, init) => fetch(input, init))

/**
 * @param api 演出を消す呼び出し。テストで差し替えるために受け取る
 */
export const DismissControl = ({ api = defaultApi }: { api?: OverlayDismissApi }) => {
  const [busy, setBusy] = useState(false)
  /** 断られた理由。次に通ったら消す */
  const [problem, setProblem] = useState<string | null>(null)

  const dismiss = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.dismiss()
      setProblem(null)
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        className="size-9 shrink-0 rounded-full text-muted-foreground"
        disabled={busy}
        onClick={() => void dismiss()}
        {...iconButtonName('演出を消す')}
      >
        <Eraser aria-hidden="true" className="size-5" />
      </Button>
      {problem !== null && (
        <p role="alert" title={problem} className="min-w-0 truncate text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}
