/**
 * データの型ごとの表示部品。
 *
 * 一覧の中の値を、文で書かずに型として見分けられる形で出す（Linear・Cloudflare の見せ方。docs/decisions/design.md）。
 * - StatusDot: 状態（点＋短い語）
 * - Identifier: 識別子（ログイン名・ファイル名・キーワード。等幅）
 * - Quantity: 数量（右揃えに向く等幅の数字＋小さな単位。値が無ければ「—」）
 * - ColorSwatch: 色の見本
 * - Tag: 種類（色の点＋名前の札）
 * - StatTile: 集計の数（見出し＋大きな値）。ダッシュボードの概要と LLM の使用状況で同じ形にする
 *
 * 色はすべて src/app/app.css のトークンから取る。点の色は飾りなので読み上げず、意味は必ず文字で添える。
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** 状態の種類。positive=良い・動いている、attention=対応を待っている、negative=失敗・止まっている（異常）、neutral=止めている（正常） */
export type StatusTone = 'positive' | 'attention' | 'negative' | 'neutral'

const STATUS_DOT_CLASS: Readonly<Record<StatusTone, string>> = {
  positive: 'bg-positive',
  attention: 'bg-attention',
  negative: 'bg-destructive',
  // 透明度を付けた色はコントラスト比を確かめられないので、テスト済みの灰色（tag-gray）を使う
  neutral: 'bg-tag-gray',
}

/**
 * 状態を「点＋短い語」で出す。
 *
 * 注意: 語を省いて点だけにしない（色だけでは状態を読み取れない人がいるため）。
 */
export const StatusDot = ({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) => (
  <span data-tone={tone} className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
    <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', STATUS_DOT_CLASS[tone])} />
    {children}
  </span>
)

/**
 * 識別子（ログイン名・ファイル名・キーワードなど、配信者が打ち込んだ値そのもの）を等幅で出す。
 * prefix はログイン名の @ のように、値の前に付けて種類を示す記号。
 */
export const Identifier = ({ prefix, children, className }: { prefix?: string; children: ReactNode; className?: string }) => (
  <code className={cn('font-mono text-xs', className)}>
    {prefix}
    {children}
  </code>
)

/** 値が無いことを表す既定の文字（docs/principles.md の「記録が無い値は表示のときだけ —」） */
const ABSENT = '—'

/**
 * 数量を、3桁区切りの等幅の数字と小さな単位で出す。
 *
 * 値が null のときは 0 にせず absent（既定は「—」）を薄く出す。0 は値として出す（「無い」と「0」を同じ見た目にしない）。
 * NaN・無限大は数のように見せず「数ではない値」と赤で出す（黙って「NaN pt」と出さない。呼び出し側の誤りに気づけるようにする）。
 */
export const Quantity = ({ value, unit, absent = ABSENT, className }: { value: number | null; unit?: string; absent?: string; className?: string }) => {
  if (value === null) return <span className={cn('text-muted-foreground', className)}>{absent}</span>
  if (!Number.isFinite(value)) return <span className={cn('text-destructive', className)}>数ではない値</span>
  return (
    <span className={cn('font-medium whitespace-nowrap tabular-nums', className)}>
      {value.toLocaleString('ja-JP')}
      {unit !== undefined && <span className="ml-0.5 text-xs font-normal text-muted-foreground">{unit}</span>}
    </span>
  )
}

/** 色の見本。label には色の名前（例: 「背景色 #9147FF」）を渡し、読み上げで色が分かるようにする */
export const ColorSwatch = ({ color, label, className }: { color: string; label: string; className?: string }) => (
  <span
    role="img"
    aria-label={label}
    className={cn('inline-block size-3.5 shrink-0 rounded-sm ring-1 ring-foreground/10 ring-inset', className)}
    style={{ backgroundColor: color }}
  />
)

/** 種類の札の色。意味（良い・悪い）は持たせず、種類を見分けるためだけに使う */
export type TagTone = 'orange' | 'blue' | 'purple' | 'teal' | 'pink' | 'green' | 'red' | 'yellow' | 'indigo' | 'gray'

const TAG_DOT_CLASS: Readonly<Record<TagTone, string>> = {
  orange: 'bg-tag-orange',
  blue: 'bg-tag-blue',
  purple: 'bg-tag-purple',
  teal: 'bg-tag-teal',
  pink: 'bg-tag-pink',
  green: 'bg-tag-green',
  red: 'bg-tag-red',
  yellow: 'bg-tag-yellow',
  indigo: 'bg-tag-indigo',
  gray: 'bg-tag-gray',
}

/** 種類を、色の点を添えた丸い札で出す（トリガーの効果の種類など） */
export const Tag = ({ tone, children, className }: { tone: TagTone; children: ReactNode; className?: string }) => (
  <span
    data-tone={tone}
    className={cn('inline-flex h-5.5 items-center gap-1.5 rounded-full border px-2 text-xs font-medium whitespace-nowrap', className)}
  >
    <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', TAG_DOT_CLASS[tone])} />
    {children}
  </span>
)

/**
 * 集計の数を1つ出すタイル。読み上げでは見出し（label）を名前にしたひとまとまりとして読ませる。
 * children には値を渡す（Quantity・時間の文字列・2行の値など）。値の大きさはここで決め、ページごとに変えない。
 */
export const StatTile = ({ label, children, className }: { label: string; children: ReactNode; className?: string }) => (
  <div role="group" aria-label={label} className={cn('flex flex-col gap-1 rounded-md border p-3', className)}>
    <span className="text-xs text-muted-foreground">{label}</span>
    <div data-slot="stat-value" className="text-xl font-semibold tabular-nums">
      {children}
    </div>
  </div>
)
