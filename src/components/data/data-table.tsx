/**
 * 1項目＝1行の一覧の表。
 *
 * 項目ごとに箱（Card）を並べる代わりに、列をそろえた行で並べる（Linear の課題一覧の組み方。docs/decisions/design.md）。
 * <table> ではなく CSS grid の div に表の役割（table・row・columnheader・cell・rowgroup）を付けて組む。
 * 行の中に詳細を開く・区分の帯を挟むなど、<table> の構造に収まらない並べ方をするためである。
 *
 * 列の幅は DataTable の columns（grid-template-columns の値）で1回だけ決め、CSS 変数 --columns で各行に配る。
 */
import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** セルの寄せ方。数量は end（右揃え）にする */
type Align = 'start' | 'end'

const ALIGN_CLASS: Readonly<Record<Align, string>> = { start: 'justify-start text-left', end: 'justify-end text-right' }

/** 行の共通の組み方。列の幅は表の --columns を使う */
const ROW_CLASS = 'grid grid-cols-(--columns) items-center gap-3 px-3'

/**
 * 一覧の表の外枠。label は表の名前（読み上げで「チャンネルポイント報酬 の表」のように読まれる）。
 * columns は grid-template-columns の値（例: "minmax(0,1fr) 6rem"）。
 */
export const DataTable = ({ label, columns, children, className }: { label: string; columns: string; children: ReactNode; className?: string }) => (
  // --columns は CSS 変数なので、React の style の型（CSSProperties）に無い名前として渡す
  <div role="table" aria-label={label} className={cn('text-sm', className)} style={{ '--columns': columns } as CSSProperties}>
    {children}
  </div>
)

/** 列の見出しの行 */
export const DataTableHeader = ({ children }: { children: ReactNode }) => (
  <div role="row" className={cn(ROW_CLASS, 'min-h-7 border-b text-xs font-medium text-muted-foreground')}>
    {children}
  </div>
)

/** 列の見出し */
export const DataTableHead = ({ align = 'start', children }: { align?: Align; children?: ReactNode }) => (
  <div role="columnheader" className={cn('flex', ALIGN_CLASS[align])}>
    {children}
  </div>
)

/**
 * 行の区分。灰色の帯に区分の名前と件数（例: 「2 / 7」）を出し、その下に行を並べる。
 * 件数は数えた結果を呼び出し側で文字にして渡す（何を数えるかは一覧ごとに違うため）。
 */
export const DataTableGroup = ({ label, count, children }: { label: string; count?: string; children: ReactNode }) => (
  <div role="rowgroup" aria-label={label} className="mt-2.5 first:mt-0">
    {/* 帯は見た目の見出しで、区分の名前は rowgroup の名前として読まれるので、ここは読み上げない */}
    <div aria-hidden="true" className="flex h-8.5 items-center gap-2 rounded-md bg-muted px-3 font-medium">
      {label}
      {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
    </div>
    {children}
  </div>
)

/** データの行。dimmed は「まだ何も設定していない行」のように、並んではいるが目立たせない行 */
export const DataTableRow = ({ dimmed = false, children, className }: { dimmed?: boolean; children: ReactNode; className?: string }) => (
  <div role="row" className={cn(ROW_CLASS, 'min-h-9.5 border-b border-border/60 hover:bg-muted/50', dimmed && 'text-muted-foreground', className)}>
    {children}
  </div>
)

/**
 * データのセル。中身は切り取らず折り返す（札が半分で切れたり、ボタンのフォーカスの印が切れたりしないように）。
 * 長い文字を1行で省略したいときは、中の文字を <span className="truncate"> で包む。
 */
export const DataTableCell = ({ align = 'start', children, className }: { align?: Align; children?: ReactNode; className?: string }) => (
  <div role="cell" className={cn('flex min-w-0 flex-wrap items-center gap-1', ALIGN_CLASS[align], className)}>
    {children}
  </div>
)
