/**
 * ゲームの正解者に渡す人形の選択欄（issue #420）
 *
 * チャットで推理のページと、トリガーのページの漢字クイズのカードに置き、正解者にいまの人形を渡すか（渡さない・ふつうの人形・
 * スーパー人形）をゲームごとに選ぶ。個数は1で固定する。選び直したら保存ボタンを待たずにその場で保存する（いまの人形の選び直しと
 * 同じ。置き場所のカードの保存ボタンと混ぜると、音の設定の未保存の印と食い違うため）。
 *
 * 注意: 選択欄は保存できた値だけを出す。保存できなければ理由を出し、選択欄は保存済みの値のまま残す。
 * 注意: 読み込めなければ「渡さない」と見せず、理由を出す（Fail-Fast）。
 */
import { useEffect, useId, useState } from 'react'
import { errorMessage, usePageActions } from '@/admin/page-actions'
import { LoadFailure } from '@/components/load-failure'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Skeleton } from '@/components/ui/skeleton'
import type { DollApi } from './api'
import { DOLL_KIND_LABELS, isDollKind, type DollKind, type DollPrizeGame } from './doll'

/** 選択欄で「渡さない」を表す値 */
const NONE = 'none'

type Loaded = { status: 'loading' } | { status: 'ready'; kind: DollKind | null } | { status: 'failed'; message: string }

interface DollPrizeFieldProps {
  api: Pick<DollApi, 'prize' | 'savePrize'>
  game: DollPrizeGame
}

export const DollPrizeField = ({ api, game }: DollPrizeFieldProps) => {
  const id = useId()
  const actions = usePageActions()
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.prize(game).then(
      (kind) => {
        if (!cancelled) setLoaded({ status: 'ready', kind })
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ status: 'failed', message: errorMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, game])

  if (loaded.status === 'loading') return <Skeleton className="h-16 w-full sm:max-w-xs" aria-label="正解者に渡す人形を読み込んでいます" />
  if (loaded.status === 'failed') return <LoadFailure title="正解者に渡す人形を表示できません" message={loaded.message} />

  const save = async (kind: DollKind | null): Promise<string> => {
    setLoaded({ status: 'ready', kind: await api.savePrize(game, kind) })
    return '正解者に渡す人形を保存しました'
  }

  return (
    <div className="flex flex-col gap-2">
      {actions.feedback}
      <div className="flex flex-col gap-2 sm:max-w-xs">
        <Label htmlFor={id}>正解者に渡す人形</Label>
        <NativeSelect
          id={id}
          className="w-full"
          value={loaded.kind ?? NONE}
          disabled={actions.busy}
          onChange={(event) => {
            const { value } = event.currentTarget
            // 選択肢は「渡さない」と人形の種類だけから作っているので、それ以外の値は来ない
            void actions.run(() => save(isDollKind(value) ? value : null))
          }}
        >
          <NativeSelectOption value={NONE}>渡さない</NativeSelectOption>
          {(['normal', 'super'] as const).map((kind) => (
            <NativeSelectOption key={kind} value={kind}>
              {DOLL_KIND_LABELS[kind]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <p className="text-sm text-muted-foreground">正解した人に、いまの人形を1つ渡します。いまの人形は人形のページで選びます。</p>
    </div>
  )
}
