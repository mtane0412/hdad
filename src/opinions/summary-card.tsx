/**
 * 配信後のまとめの枠（/opinions/。issue #309）
 *
 * 締め切ったテーマについて、LLM が作った「合意が見える点・意見が分かれた点・残った問い」を出す。
 * 機械が作ったものと一目で分かるよう、「AIのまとめ」の見出しと注記を付け、意見の一覧（配信者が確かめる材料）とは別の枠にする。
 * 配信者のメモは混ぜない。まとめが無ければ（作っている途中・作れなかった・意見が無かった）その旨を出し、いつでも作らせられる。
 *
 * 人数は出さない。作り直しの操作と通信は呼び出し側（opinion-page.tsx）が持ち、ここは表示と、押されたことの通知だけを持つ。
 * 作り直しを渡さなければ（ダッシュボードの振り返り。src/stats/session-opinions.tsx）、読むだけの枠にしてボタンを置かない。
 */
import { Tag } from '@/components/data/data-display'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { StoredOpinionSummary } from './api'

/** まとめの欄。worker/opinion-summary.ts の SUMMARY_SECTIONS と合わせる */
const SECTIONS = [
  { key: 'agreements', label: '合意が見える点' },
  { key: 'disagreements', label: '意見が分かれた点' },
  { key: 'openQuestions', label: '残った問い' },
] as const

export interface SummaryCardProps {
  summary: StoredOpinionSummary | null
  /** 作り直し。渡さなければ読むだけの枠にする（ボタンを置かない） */
  remake?: { busy: boolean; onRemake(): void }
}

export const SummaryCard = ({ summary, remake }: SummaryCardProps) => (
  <Card role="group" aria-label="AIのまとめ" className="border-dashed">
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        AIのまとめ
        <Tag tone="gray">機械が作成</Tag>
      </CardTitle>
      <CardDescription>
        意見を読んだAIが作ったまとめです。配信者が確かめたものではなく、間違いや偏りを含むことがあります。人数は数えていません。
      </CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      {summary === null ? (
        <p className="text-sm text-muted-foreground">まとめはまだありません（作っている途中か、作れなかったか、まとめる意見が無かった可能性があります）。</p>
      ) : (
        SECTIONS.map(({ key, label }) => (
          <section key={key} className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{label}</h3>
            {summary[key].length === 0 ? (
              <p className="text-sm text-muted-foreground">なし</p>
            ) : (
              <ul className="list-disc pl-5">
                {summary[key].map((item, index) => (
                  // 同じ文が2回出ることもあるので、並び順を鍵に含める
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
      {summary !== null && <p className="text-xs text-muted-foreground">{`作成: ${new Date(summary.createdAt).toLocaleString('ja-JP')}`}</p>}
      {remake !== undefined && (
        <div>
          <Button type="button" size="sm" variant="outline" disabled={remake.busy} onClick={remake.onRemake}>
            {summary === null ? 'まとめを作る' : 'まとめを作り直す'}
          </Button>
        </div>
      )}
    </CardContent>
  </Card>
)
