/**
 * 操作の実行と、その結果の表示
 *
 * トリガーのページとアップロードのページが共通で使う。どちらも「ボタンを押す → Workerを呼ぶ → 成功なら知らせ、
 * 失敗なら理由を出す」という同じ形をとるので、その状態（実行中・お知らせ・失敗の理由・確認待ちの操作）と、
 * それを出す要素をここにまとめる。
 *
 * 成功のお知らせは画面の下に浮かべて数秒で消す（ページの先頭に置くと、下のほうの保存ボタンを押したときに見えないため）。
 * 失敗の理由はページの先頭に出したまま消さず、見える位置までスクロールする。
 *
 * 注意: 失敗は黙って無視せず、必ず理由を画面に出す（Fail-Fast）。実行中はボタンを押せなくして、二重の送信を防ぐ。
 */
import { CircleCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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

/** 成功のお知らせを出しておく時間（ミリ秒）。読み切れる長さで、次の操作の邪魔にならない短さにする */
export const NOTICE_VISIBLE_MS = 5000

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
  const failureRef = useRef<HTMLDivElement>(null)

  // 成功のお知らせは、しばらくしたら消す
  useEffect(() => {
    if (notice === '') return
    const timer = setTimeout(() => setNotice(''), NOTICE_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  // 失敗の理由はページの先頭に出るので、下のほうで押したときにも見えるよう、その位置まで送る
  // （jsdom には scrollIntoView がないので、あるときだけ呼ぶ）
  useEffect(() => {
    if (failure.length > 0) failureRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [failure])

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
      {/* 読み上げソフトに伝わるよう、お知らせの領域は空のときも置いたままにし、見た目だけを消す */}
      <p
        role="status"
        className={`pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-2 rounded-lg border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg motion-safe:transition-[opacity,translate] motion-safe:duration-200 sm:right-6 sm:bottom-6 sm:left-auto sm:mx-0 ${
          notice === '' ? 'translate-y-2 opacity-0' : 'translate-y-0 opacity-100'
        }`}
      >
        {notice !== '' && <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />}
        {notice}
      </p>
      {failure.length > 0 && (
        <Alert ref={failureRef} variant="destructive" className="scroll-mt-20">
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
