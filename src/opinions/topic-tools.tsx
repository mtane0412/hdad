/**
 * 意見ボードのページ（/opinions/）の、論点の見出しと整理の操作（issue #308）
 *
 * LLM が細かく分けすぎた論点を、配信者が整えるための部品である。
 * - 名前を変える: 論点の名前を書き換える
 * - ほかの論点とまとめる: この論点の意見をまとめ先へ移し、この論点を消す（まとめ先の名前が残る。LLM にまとめ直させない）
 *
 * Worker の呼び出しと結果の表示・まとめる前の確認はページ（opinion-page.tsx）が持ち、ここは入力と選択だけを持つ。
 * 値の検証（名前の長さ・重なり）は Worker だけが持つ。
 *
 * 注意: 書きかけ（名前を書き換えている・まとめ先を選んでいる）のあいだは、ページを離れる前に確認を出す（useUnsavedChanges）。
 */
import { useId, useState } from 'react'
import { useUnsavedChanges } from '@/app/router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import type { AdminTopic } from './api'

/** 論点の整理のページの操作 */
export interface TopicActions {
  readonly busy: boolean
  /** 名前を書き換える。保存できたか */
  rename(topicId: number, title: string): Promise<boolean>
  /** まとめる（ページが確かめてから行う） */
  merge(topic: AdminTopic, into: AdminTopic): void
}

/** 書きかけの操作 */
type TopicForm = { readonly type: 'rename'; readonly title: string } | { readonly type: 'merge'; readonly intoId: string }

/**
 * 論点の見出しと、名前を変える・ほかの論点とまとめる操作。
 *
 * @param topics 同じテーマの論点（まとめ先の候補。論点が1つならまとめる操作を出さない）
 */
export const TopicHeader = ({ topic, topics, actions }: { topic: AdminTopic; topics: readonly AdminTopic[]; actions: TopicActions }) => {
  const [form, setForm] = useState<TopicForm | null>(null)
  useUnsavedChanges(form !== null)
  const titleId = useId()
  const intoId = useId()
  const others = topics.filter(({ id }) => id !== topic.id)
  const firstOther = others[0]

  const rename = async (title: string): Promise<void> => {
    if (await actions.rename(topic.id, title)) setForm(null)
  }
  const merge = (selectedId: string): void => {
    const into = others.find(({ id }) => String(id) === selectedId)
    if (into === undefined) return
    setForm(null)
    actions.merge(topic, into)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">{topic.title}</h2>
        {form === null && (
          <>
            <Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={() => setForm({ type: 'rename', title: topic.title })}>
              名前を変える
            </Button>
            {firstOther !== undefined && (
              <Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={() => setForm({ type: 'merge', intoId: String(firstOther.id) })}>
                ほかの論点とまとめる
              </Button>
            )}
          </>
        )}
      </div>

      {form?.type === 'rename' && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={titleId}>論点の名前</Label>
            <Input id={titleId} value={form.title} onChange={(event) => setForm({ type: 'rename', title: event.currentTarget.value })} />
          </div>
          <Button type="button" size="sm" disabled={actions.busy} onClick={() => void rename(form.title)}>
            名前を保存
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={() => setForm(null)}>
            やめる
          </Button>
        </div>
      )}

      {form?.type === 'merge' && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={intoId}>まとめ先</Label>
            <NativeSelect id={intoId} value={form.intoId} onChange={(event) => setForm({ type: 'merge', intoId: event.currentTarget.value })}>
              {others.map((other) => (
                <NativeSelectOption key={other.id} value={String(other.id)}>
                  {other.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <Button type="button" size="sm" disabled={actions.busy} onClick={() => merge(form.intoId)}>
            まとめる
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={actions.busy} onClick={() => setForm(null)}>
            やめる
          </Button>
        </div>
      )}
    </div>
  )
}
