/**
 * 操作の実行と、その結果の表示
 *
 * トリガーのページとアップロードのページが共通で使う。どちらも「ボタンを押す → Workerを呼ぶ → 成功なら知らせ、
 * 失敗なら理由を出す」という同じ形をとるので、その状態（実行中・お知らせ・失敗の理由・確認待ちの操作）と、
 * それを出す要素をここにまとめる。
 *
 * 注意: 失敗は黙って無視せず、必ず理由を画面に出す（Fail-Fast）。実行中はボタンを押せなくして、二重の送信を防ぐ。
 */
import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/** 失敗の理由を、そのまま画面に出せる文字列にする */
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 実行の前に確かめる操作。確かめてから run を実行する */
export interface Confirmation {
  title: string
  description: string
  actionLabel: string
  run(): Promise<string>
}

export interface PageActions {
  /** 実行中かどうか。ボタンの disabled に渡して二重の送信を防ぐ */
  busy: boolean
  /** 操作を実行し、終わったら結果を知らせる。失敗したら理由を出す */
  run(action: () => Promise<string>): Promise<void>
  /** 確かめてから実行する操作を出す */
  ask(confirmation: Confirmation): void
  /** お知らせ・失敗の理由・確認のダイアログ。ページの先頭に置く */
  feedback: React.ReactNode
}

/**
 * 操作の実行と結果の表示をまとめて用意する。
 *
 * @param toFailureLines 失敗を画面に出す行にする。問題点を1行ずつ並べたいページが渡す（既定は理由を1行で出す）
 */
export const usePageActions = (toFailureLines: (error: unknown) => string[] = (error) => [errorMessage(error)]): PageActions => {
  const [notice, setNotice] = useState('')
  const [failure, setFailure] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation>()

  const run = async (action: () => Promise<string>): Promise<void> => {
    setFailure([])
    setNotice('')
    setBusy(true)
    try {
      setNotice(await action())
    } catch (error) {
      setFailure(toFailureLines(error))
    } finally {
      setBusy(false)
    }
  }

  const feedback = (
    <>
      <p role="status" className="min-h-5 text-sm">
        {notice}
      </p>
      {failure.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>操作に失敗しました</AlertTitle>
          <AlertDescription className="whitespace-pre-line">{failure.join('\n')}</AlertDescription>
        </Alert>
      )}
      <AlertDialog
        open={confirmation !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirmation(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            {/* AlertDialogAction は押しても閉じないので、実行と合わせてここで閉じる */}
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmation) void run(confirmation.run)
                setConfirmation(undefined)
              }}
            >
              {confirmation?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )

  return { busy, run, ask: setConfirmation, feedback }
}
