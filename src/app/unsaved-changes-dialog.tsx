/**
 * 未保存の変更があるページから離れようとしたときの確認
 *
 * 移動を止める判断は `./router` が持ち、ここは確認待ちの移動（usePendingNavigation）があるあいだ確認を出すだけにする。
 * 「留まる」を選ぶか確認を閉じれば、ページは作り直されず編集した内容がそのまま残る。
 */
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
import { usePendingNavigation } from './router'

export const UnsavedChangesDialog = () => {
  const pending = usePendingNavigation()
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) pending?.stay()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>保存していない変更があります</AlertDialogTitle>
          <AlertDialogDescription>このページを離れると、保存していない変更は消えます。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>留まる</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => pending?.proceed()}>
            保存せずに移る
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
