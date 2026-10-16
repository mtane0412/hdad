/**
 * 1項目＝1行の一覧の表。
 *
 * 項目ごとに箱（Card）を並べる代わりに、列をそろえた行で並べる（Linear の課題一覧の組み方。docs/decisions/design.md）。
 * 編集できる項目は、行（名前から始まるボタン）を押すとその場で下に詳細（入力欄）が開く。開くのは1件ずつにするので、
 * どの行が開いているかは呼び出し側が持ち、行には expand で渡す。
 *
 * 読み上げでは名前の付いたリスト（ul・li）として読ませ、列の見出しは見た目だけにする（aria-hidden）。
 * 行そのものがボタンになるので、<table> の行とセルの構造には収まらないためである（行の中身はボタンの名前としてそのまま読まれる）。
 *
 * 列の幅は DataTable の columns（grid-template-columns の値）で1回だけ決め、CSS 変数 --columns で見出しと各行に配る。
 * 開閉の矢印の場所はどの行でも取り、開ける行と開けない行で列の位置をそろえる。
 */
import { ChevronDown } from 'lucide-react'
import { useId, type CSSProperties, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** セルの寄せ方。数量は end（右揃え）にする */
type Align = 'start' | 'end'

const ALIGN_CLASS: Readonly<Record<Align, string>> = { start: 'justify-start text-left', end: 'justify-end text-right' }

/** 行と見出しの、列の並べ方。列の幅は表の --columns を使う */
const COLUMNS_CLASS = 'grid min-w-0 flex-1 grid-cols-(--columns) items-center gap-3 px-2'

/** 開閉の矢印の場所。開けない行と見出しも同じ幅を取る */
const CHEVRON_SLOT_CLASS = 'size-4 shrink-0'

/** 列の見出し。label は見出しの文字（読み上げない） */
export interface DataTableHeading {
  label: ReactNode
  align?: Align
}

/**
 * 一覧の表の外枠。label はリストの名前（読み上げで「チャンネルポイント報酬 のリスト」のように読まれる）。
 * columns は grid-template-columns の値（例: "minmax(0,1fr) 6rem"）。headings は列の見出し（columns と同じ数）。
 */
export const DataTable = ({
  label,
  columns,
  headings,
  children,
  className,
}: {
  label: string
  columns: string
  headings: readonly DataTableHeading[]
  children: ReactNode
  className?: string
}) => (
  // --columns は CSS 変数なので、React の style の型（CSSProperties）に無い名前として渡す
  <div className={cn('flex flex-col text-sm', className)} style={{ '--columns': columns } as CSSProperties}>
    <div aria-hidden="true" className="flex min-h-7 items-center gap-2 border-b text-xs font-medium text-muted-foreground">
      <div className={COLUMNS_CLASS}>
        {headings.map((heading, index) => (
          // 見出しは並び順だけで決まり、入れ替わらないので位置を鍵にする
          <span key={index} className={cn('flex', ALIGN_CLASS[heading.align ?? 'start'])}>
            {heading.label}
          </span>
        ))}
      </div>
      <span className={CHEVRON_SLOT_CLASS} />
    </div>
    <ul aria-label={label} className="flex flex-col">
      {children}
    </ul>
  </div>
)

/**
 * 行の区分。灰色の帯に区分の名前と件数（例: 「2 / 7」）を出し、その下に行を並べる。
 * 件数は数えた結果を呼び出し側で文字にして渡す（何を数えるかは一覧ごとに違うため）。
 */
export const DataTableGroup = ({ label, count, children }: { label: string; count?: string; children: ReactNode }) => (
  <li className="mt-2.5 flex flex-col first:mt-0">
    {/* 帯は見た目の見出しで、区分の名前は中のリストの名前として読まれるので、ここは読み上げない */}
    <div aria-hidden="true" className="flex h-8.5 items-center gap-2 rounded-md bg-muted px-3 font-medium">
      {label}
      {count !== undefined && <span className="font-normal text-muted-foreground tabular-nums">{count}</span>}
    </div>
    <ul aria-label={label} className="flex flex-col">
      {children}
    </ul>
  </li>
)

/** 行を押したときにその場で下に開く詳細 */
export interface DataTableExpand {
  /** 開いているか */
  open: boolean
  onToggle(): void
  /** 開いたときに出す中身（入力欄・保存のボタンなど） */
  detail: ReactNode
}

/**
 * データの行。label は行の名前（読み上げで項目の名前として読まれる）。children は DataTableCell を列の数だけ並べる。
 *
 * expand を渡すと、行は名前から始まるボタンになり、押すとその場で下に detail が開く（aria-expanded を持ち、
 * aria-controls は詳細があるとき、つまり開いているときだけ付ける）。渡さなければ押せない行になる。
 * dimmed は「まだ何も設定していない行」のように、並んではいるが目立たせない行。
 */
export const DataTableRow = ({
  label,
  expand,
  dimmed = false,
  children,
}: {
  label: string
  expand?: DataTableExpand
  dimmed?: boolean
  children: ReactNode
}) => {
  const detailId = useId()
  const open = expand?.open === true
  return (
    <li aria-label={label} className={cn('flex flex-col border-b border-border/60', dimmed && 'text-muted-foreground')}>
      <div className="flex min-h-9.5 items-center gap-2">
        {expand === undefined ? (
          <div className={cn(COLUMNS_CLASS, 'py-1.5')}>{children}</div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className={cn(COLUMNS_CLASS, 'h-auto py-1.5 text-left font-normal whitespace-normal')}
            aria-expanded={open}
            // 閉じているあいだは詳細が無いので、無い要素を指さないよう開いているときだけ付ける
            aria-controls={open ? detailId : undefined}
            onClick={expand.onToggle}
          >
            {children}
          </Button>
        )}
        {expand === undefined ? (
          <span aria-hidden="true" className={CHEVRON_SLOT_CLASS} />
        ) : (
          <ChevronDown aria-hidden="true" className={cn(CHEVRON_SLOT_CLASS, 'text-muted-foreground', open && 'rotate-180')} />
        )}
      </div>
      {expand !== undefined && open && (
        <div id={detailId} className="flex flex-col gap-3 border-t px-2 py-4">
          {expand.detail}
        </div>
      )}
    </li>
  )
}

/**
 * データのセル。中身は切り取らず折り返す（札が半分で切れたり、ボタンのフォーカスの印が切れたりしないように）。
 * 長い文字を1行で省略したいときは、中の文字を <span className="truncate"> で包む。
 * 行がボタンになることがあるので、div ではなく span で組む（ボタンの中に置けるのは文字の要素だけのため）。
 */
export const DataTableCell = ({ align = 'start', children, className }: { align?: Align; children?: ReactNode; className?: string }) => (
  <span className={cn('flex min-w-0 flex-wrap items-center gap-1', ALIGN_CLASS[align], className)}>{children}</span>
)
