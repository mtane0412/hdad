/**
 * テキストのページ（/texts/）
 *
 * 配信で「今何をしているか」「何を目指しているか」を見せるため、配信者が自由に書いた文字（issue #294）を
 * 追加・名前の変更・削除・本文の書き換えをする画面である。書いたテキストは、オーバーレイのページで素材「テキスト」に選ぶと
 * 合成ページに映り、保存するとすぐ合成ページへ押し出される。配信中に本文だけを書き換えるなら、下部バー（text-bar.tsx）からもできる。
 *
 * テキストごとに「自動で書き換える」を入れると、指示文に沿って配信中に LLM が本文を書き直す（issue #295。Worker の cron が書く）。
 * 自動の最中に本文を手で書き換えたら手動に切り替わり（form.ts の editBody）、いまの本文を誰が書いたかを本文の下に出す。
 *
 * テキストは1件ずつ別々に保存する（1件を書き換えるために、ほかのテキストの書きかけまで送らないため）。
 * 値の検証は Worker（worker/text.ts）だけが持ち、画面は返ってきた問題点を並べるだけにする（form.ts）。
 *
 * 注意: 保存していない変更（書きかけの本文・追加しかけのテキスト）があるあいだは、ページを離れる前に確認を出す（useUnsavedChanges）。
 * 注意: テキストを消すと、それを映している素材は合成ページで箱にエラーを出す（黙って空にしない）。消す前に確かめる。
 */
import { useEffect, useId, useState } from 'react'
import { usePageActions, errorMessage } from '@/admin/page-actions'
import { Link, useUnsavedChanges } from '@/app/router'
import { LoadFailure } from '@/components/load-failure'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { TextApi } from './api'
import type { TextEntry } from './entry'
import { draftOf, editBody, textFailureLines, toTextInput, type TextDraft } from './form'

/** 何も書いていない入力欄 */
const EMPTY_DRAFT: TextDraft = { name: '', mode: 'manual', body: '', instruction: '' }

const sameDraft = (left: TextDraft, right: TextDraft): boolean =>
  left.name === right.name && left.mode === right.mode && left.body === right.body && left.instruction === right.instruction

/** LLM が本文を書いた時刻を、時と分で出す */
const writtenAtFormat = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' })

/** いまの本文を誰が書いたか（保存済みのテキストだけ） */
const writerNote = (text: TextEntry): string =>
  text.writtenBy === 'llm' ? `LLMが書いた本文です（${writtenAtFormat.format(new Date(text.updatedAt))}）` : '手で書いた本文です'

/**
 * 名前・本文・自動の切り替え・指示文の入力欄の組。保存済みのテキストと、追加の入力欄で同じものを使う。
 *
 * @param saved 保存済みのテキスト。渡すと、いまの本文を誰が書いたかを本文の下に出す
 */
const TextFields = ({ value, saved, onChange }: { value: TextDraft; saved?: TextEntry; onChange(value: TextDraft): void }) => {
  const id = useId()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-name`}>名前</Label>
        <Input id={`${id}-name`} value={value.name} placeholder="例: 目標" onChange={(event) => onChange({ ...value, name: event.currentTarget.value })} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-body`}>本文</Label>
        <Textarea
          id={`${id}-body`}
          value={value.body}
          rows={4}
          placeholder="例: ログイン画面を作り終える"
          onChange={(event) => onChange(editBody(value, event.currentTarget.value))}
        />
        {saved !== undefined && <p className="text-xs text-muted-foreground">{writerNote(saved)}</p>}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={`${id}-auto`}
          checked={value.mode === 'auto'}
          onCheckedChange={(checked) => onChange({ ...value, mode: checked ? 'auto' : 'manual' })}
        />
        <Label htmlFor={`${id}-auto`}>自動で書き換える</Label>
      </div>
      {value.mode === 'auto' && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-instruction`}>指示文</Label>
          <Textarea
            id={`${id}-instruction`}
            value={value.instruction}
            rows={2}
            placeholder="例: いまやっている作業を20字で"
            onChange={(event) => onChange({ ...value, instruction: event.currentTarget.value })}
          />
          <p className="text-xs text-muted-foreground">配信中、喋った内容やチャットをもとに LLM が5分おきに本文を書き直します。本文を手で書き換えると自動は止まります。</p>
        </div>
      )}
    </div>
  )
}

export const TextPage = ({ api }: { api: TextApi }) => {
  /** 保存済みのテキスト（追加した順）。読み込むまでは undefined */
  const [saved, setSaved] = useState<TextEntry[]>()
  const [loadError, setLoadError] = useState<string>()
  /** テキストごとの書きかけ（IDごと）。保存済みと同じなら未保存の変更は無い */
  const [drafts, setDrafts] = useState<ReadonlyMap<number, TextDraft>>(new Map())
  /** 追加の入力欄の中身 */
  const [added, setAdded] = useState<TextDraft>(EMPTY_DRAFT)
  const actions = usePageActions(textFailureLines)

  useEffect(() => {
    let cancelled = false
    api.list().then(
      (texts) => {
        if (cancelled) return
        setSaved(texts)
        setDrafts(new Map(texts.map((text) => [text.id, draftOf(text)])))
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  const currentDraft = (text: TextEntry): TextDraft => drafts.get(text.id) ?? draftOf(text)
  const changed = saved !== undefined && (saved.some((text) => !sameDraft(currentDraft(text), draftOf(text))) || !sameDraft(added, EMPTY_DRAFT))
  useUnsavedChanges(changed)

  if (loadError !== undefined) return <LoadFailure title="テキストを読み込めませんでした" message={loadError} />
  if (saved === undefined) return <Skeleton className="h-48 w-full" />

  /** 保存済みの1件を、Workerが返したもので置き換え、書きかけもその中身にする */
  const replace = (text: TextEntry): void => {
    setSaved((previous) => previous?.map((current) => (current.id === text.id ? text : current)))
    setDrafts((previous) => new Map(previous).set(text.id, draftOf(text)))
  }

  const save = (text: TextEntry): Promise<void> =>
    actions.run(async () => {
      const updated = await api.update(text.id, toTextInput(currentDraft(text)))
      replace(updated)
      return `「${updated.name}」を保存しました`
    })

  const add = (): Promise<void> =>
    actions.run(async () => {
      const text = await api.create(toTextInput(added))
      setSaved((previous) => [...(previous ?? []), text])
      setDrafts((previous) => new Map(previous).set(text.id, draftOf(text)))
      setAdded(EMPTY_DRAFT)
      return `「${text.name}」を追加しました`
    })

  const askRemove = (text: TextEntry): void =>
    actions.ask({
      title: `「${text.name}」を消しますか？`,
      description: 'このテキストを映している素材は、合成ページでエラーを出します。オーバーレイのページで別のテキストを選ぶか、素材を外してください。',
      actionLabel: 'テキストを消す',
      run: async () => {
        await api.remove(text.id)
        setSaved((previous) => previous?.filter((current) => current.id !== text.id))
        setDrafts((previous) => {
          const next = new Map(previous)
          next.delete(text.id)
          return next
        })
        return `「${text.name}」を消しました`
      },
    })

  return (
    <div className="flex flex-col gap-6">
      {actions.feedback}
      <Card>
        <CardHeader>
          <CardTitle>テキスト</CardTitle>
          <CardDescription>
            配信画面に映す文字です。<Link href="/overlay/" className="underline underline-offset-4">オーバーレイ</Link>で素材「テキスト」を置いて映すテキストを選ぶと、保存するたびにすぐ映ります。配信中に本文だけを書き換えるなら、下部バーからもできます。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {saved.length === 0 && <p className="text-sm text-muted-foreground">まだテキストがありません。下で追加してください。</p>}
          {saved.map((text) => {
            const draft = currentDraft(text)
            return (
              <section key={text.id} role="group" aria-label={`テキスト「${text.name}」`} className="flex flex-col gap-3 rounded-lg border p-4">
                <TextFields value={draft} saved={text} onChange={(next) => setDrafts((previous) => new Map(previous).set(text.id, next))} />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={actions.busy || sameDraft(draft, draftOf(text))} onClick={() => void save(text)}>
                    保存する
                  </Button>
                  <Button type="button" variant="outline" className="text-destructive" disabled={actions.busy} onClick={() => askRemove(text)}>
                    消す
                  </Button>
                </div>
              </section>
            )
          })}
        </CardContent>
      </Card>
      <Card role="group" aria-label="テキストを追加">
        <CardHeader>
          <CardTitle>テキストを追加</CardTitle>
          <CardDescription>名前はオーバーレイのページで映すテキストを選ぶときに使います。ほかのテキストと同じ名前にはできません。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <TextFields value={added} onChange={setAdded} />
          <div>
            <Button type="button" disabled={actions.busy} onClick={() => void add()}>
              追加する
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
