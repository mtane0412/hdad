/**
 * 視聴者1人の人形（視聴者のページの、開いた行の中に置く区画）
 *
 * その人がいまの人形を種類ごとにいくつ持っているかを出し、配信者が手で1つずつ渡す・取り上げるボタンを置く（issue #418）。
 * 前に使った人形も、集めたものとして数だけを出す（減らせるのはいまの人形だけなので、ボタンは置かない）。
 * いまの人形の所持数を合成ページの素材「人形の獲得」へ出すボタンも置く（視聴者のチャットの !人形 と同じもの）。
 *
 * 増減の実行と結果の表示は、呼び出し側（視聴者のページ）の操作の仕組みに任せる。ここは数とボタンを並べるだけにする。
 *
 * 注意: 取り上げるボタンは、その種類を1つも持っていないあいだは押せなくする（押しても Worker が拒むだけなので）。
 */
import { Minus, MonitorUp, Plus } from 'lucide-react'
import { Link } from '@/app/router'
import { Quantity } from '@/components/data/data-display'
import { Button } from '@/components/ui/button'
import { iconButtonName } from '@/core/icon-button'
import type { DollHolding, DollKind, DollSet } from './doll'

const KINDS: readonly DollKind[] = ['normal', 'super']

/** 人形の数の単位 */
const UNIT = 'つ'

interface ViewerDollsProps {
  /** 読み上げとボタンの名前に使う、その人の表示名 */
  displayName: string
  /** 人形の組（追加した順） */
  sets: readonly DollSet[]
  /** その人の組ごとの所持数（持っていない組は含まない） */
  holdings: readonly DollHolding[]
  busy: boolean
  /** いまの人形を delta だけ増減させる（渡すなら 1、取り上げるなら -1） */
  onChange(kind: DollKind, delta: number): void
  /** いまの人形の所持数を、合成ページへ出す */
  onShow(): void
}

export const ViewerDolls = ({ displayName, sets, holdings, busy, onChange, onShow }: ViewerDollsProps) => {
  const current = sets.find((set) => set.current)
  const countOf = (setId: number, kind: DollKind): number => holdings.find((holding) => holding.setId === setId)?.[kind] ?? 0

  // 前に使った人形のうち、持っているものだけを「名前 数」で並べる
  const past = sets
    .filter((set) => !set.current)
    .flatMap((set) => KINDS.map((kind) => ({ name: set[kind].name, count: countOf(set.id, kind) })))
    .filter((figure) => figure.count !== 0)

  return (
    <div role="group" aria-label={`${displayName} の人形`} className="flex flex-col gap-2">
      {current === undefined ? (
        <p className="text-xs text-muted-foreground">
          いまの人形が選ばれていません。
          <Link href="/dolls/" className="underline underline-offset-4">
            人形
          </Link>
          のページで選ぶと、ここから渡せます。
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {KINDS.map((kind) => {
            const { name } = current[kind]
            const count = countOf(current.id, kind)
            return (
              <li key={kind} aria-label={name} className="flex items-center gap-2 text-sm">
                <Button type="button" variant="ghost" size="icon" {...iconButtonName(`${displayName} から${name}を1つ取り上げる`)} disabled={busy || count <= 0} onClick={() => onChange(kind, -1)}>
                  <Minus aria-hidden="true" />
                </Button>
                <Button type="button" variant="ghost" size="icon" {...iconButtonName(`${displayName} に${name}を1つ渡す`)} disabled={busy} onClick={() => onChange(kind, 1)}>
                  <Plus aria-hidden="true" />
                </Button>
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <Quantity value={count} unit={UNIT} />
              </li>
            )
          })}
        </ul>
      )}
      {current !== undefined && (
        <Button type="button" variant="outline" size="sm" className="self-start" aria-label={`${displayName} の人形を配信画面に出す`} disabled={busy} onClick={onShow}>
          <MonitorUp aria-hidden="true" />
          配信画面に出す
        </Button>
      )}
      {past.length > 0 && <p className="text-xs text-muted-foreground">{`これまでの人形: ${past.map((figure) => `${figure.name} ${figure.count}${UNIT}`).join('・')}`}</p>}
    </div>
  )
}
