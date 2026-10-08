/**
 * テキストのページ（/texts/）
 *
 * 配信で「今何をしているか」「何を目指しているか」を見せるため、配信者が自由に書いた文字（issue #294）を
 * 追加・名前の変更・削除・本文の書き換えをする画面である。書いたテキストは、オーバーレイのページで素材「テキスト」に選ぶと
 * 合成ページに映り、保存するとすぐ合成ページへ押し出される。配信中に本文だけを書き換えるなら、下部バー（text-bar.tsx）からもできる。
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
import { Textarea } from '@/components/ui/textarea'
import type { TextApi, TextInput } from './api'
import type { TextEntry } from './entry'
import { textFailureLines } from './form'

/** 何も書いていない入力欄 */
const EMPTY_INPUT: TextInput = { name: '', body: '' }

const sameInput = (left: TextInput, right: TextInput): boolean => left.name === right.name && left.body === right.body

/**
 * 名前と本文の入力欄の組。保存済みのテキストと、追加の入力欄で同じものを使う。
 */
const TextFields = ({ value, onChange }: { value: TextInput; onChange(value: TextInput): void }) => {
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
          onChange={(event) => onChange({ ...value, body: event.currentTarget.value })}
        />
      </div>
    </div>
  )
}

export const TextPage = ({ api }: { api: TextApi }) => {
  /** 保存済みのテキスト（追加した順）。読み込むまでは undefined */
  const [saved, setSaved] = useState<TextEntry[]>()
  const [loadError, setLoadError] = useState<string>()
  /** テキストごとの書きかけ（IDごと）。保存済みと同じなら未保存の変更は無い */
  const [drafts, setDrafts] = useState<ReadonlyMap<number, TextInput>>(new Map())
  /** 追加の入力欄の中身 */
  const [added, setAdded] = useState<TextInput>(EMPTY_INPUT)
  const actions = usePageActions(textFailureLines)

  useEffect(() => {
    let cancelled = false
    api.list().then(
      (texts) => {
        if (cancelled) return
        setSaved(texts)
        setDrafts(new Map(texts.map((text) => [text.id, { name: text.name, body: text.body }])))
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  const draftOf = (text: TextEntry): TextInput => drafts.get(text.id) ?? { name: text.name, body: text.body }
  const changed = saved !== undefined && (saved.some((text) => !sameInput(draftOf(text), text)) || !sameInput(added, EMPTY_INPUT))
  useUnsavedChanges(changed)

  if (loadError !== undefined) return <LoadFailure title="テキストを読み込めませんでした" message={loadError} />
  if (saved === undefined) return <Skeleton className="h-48 w-full" />

  /** 保存済みの1件を、Workerが返したもので置き換え、書きかけもその中身にする */
  const replace = (text: TextEntry): void => {
    setSaved((previous) => previous?.map((current) => (current.id === text.id ? text : current)))
    setDrafts((previous) => new Map(previous).set(text.id, { name: text.name, body: text.body }))
  }

  const save = (text: TextEntry): Promise<void> =>
    actions.run(async () => {
      const updated = await api.update(text.id, draftOf(text))
      replace(updated)
      return `「${updated.name}」を保存しました`
    })

  const add = (): Promise<void> =>
    actions.run(async () => {
      const text = await api.create(added)
      setSaved((previous) => [...(previous ?? []), text])
      setDrafts((previous) => new Map(previous).set(text.id, { name: text.name, body: text.body }))
      setAdded(EMPTY_INPUT)
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
            const draft = draftOf(text)
            return (
              <section key={text.id} role="group" aria-label={`テキスト「${text.name}」`} className="flex flex-col gap-3 rounded-lg border p-4">
                <TextFields value={draft} onChange={(next) => setDrafts((previous) => new Map(previous).set(text.id, next))} />
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={actions.busy || sameInput(draft, text)} onClick={() => void save(text)}>
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
