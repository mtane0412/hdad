/**
 * 保存のバー。
 *
 * どのページでも、保存ボタンを同じ形で出すための部品（docs/decisions/design.md の「保存の型」）。
 * - 文言は「〜を保存する」。開いた行の中のように何を保存するかが見えている場所では「保存する」と見せ、読み上げの名前（name）に対象を含める
 * - 未保存の変更があることは、ボタンの横に StatusDot（対応待ちの色の点＋語）で出す
 * - 押せないのは保存の最中だけにする。変更が無くても押せる（読み込んだ値をそのまま保存し直すことにも意味があるため）
 * - 1つのボタンでページ全体を保存するページ（トリガー・オーバーレイ）では、画面の下に貼り付ける（sticky）。
 *   オーバーレイのプレビューで選んだ素材（z-10）がスクロールで重なっても覆われないよう、それより前に出す
 *
 * 注意: 保存の最中（busy）は押せなくして、二重の送信を防ぐ。
 */
import type { ReactNode } from 'react'
import { StatusDot } from '@/components/data/data-display'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface SaveBarProps {
  /** ボタンに見せる文言（例: 「音を保存する」。開いた行の中では「保存する」） */
  label: string
  /** 読み上げの名前。見せる文言だけでは何を保存するか分からないときに渡す（見せる文言を含める。WCAG 2.5.3） */
  name?: string
  /** 保存の最中か */
  busy: boolean
  /** 未保存の変更があるか。true のときだけ印を出す。変更を追っていないページでは渡さない */
  unsaved?: boolean
  /** 画面の下に貼り付けるか（ページ全体を1回で保存するページだけ） */
  sticky?: boolean
  onSave(): void
  /** 保存のボタンの横に並べるほかのボタン（消すなど） */
  children?: ReactNode
}

export const SaveBar = ({ label, name, busy, unsaved, sticky = false, onSave, children }: SaveBarProps) => (
  <div className={cn('flex flex-wrap items-center gap-3', sticky && 'sticky bottom-0 z-20 border-t bg-background py-3')}>
    <Button type="button" aria-label={name} disabled={busy} onClick={onSave}>
      {label}
    </Button>
    {children}
    {unsaved === true && <StatusDot tone="attention">未保存の変更があります</StatusDot>}
  </div>
)
