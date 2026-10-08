/**
 * 下部バーに置く、テキストの本文の書き換え（issue #294）
 *
 * 配信中にどのページを見ていても、合成ページに映しているテキスト（「今やってること」など）の本文をすぐ書き換えられるようにする。
 * ボタンを押すと小さな窓を開き、書き換えるテキストを名前で選んで本文を直し、保存するとすぐ合成ページへ押し出される。
 * 名前の変更・追加・削除はバーを狭く保つために置かず、テキストのページ（/texts/。text-page.tsx）だけに残す。
 *
 * 自動で書き換えているテキスト（issue #295）も書き換えられるが、保存すると手動に切り替わる（form.ts の editBody。人が書いた文を
 * 機械に上書きさせないため）。そのことを窓の中で先に伝える。
 *
 * 窓を開くたびにテキストを読み直す（ページや別の窓で書き換えた本文を、古いまま上書きしないため）。
 * ボタンは下部バーのほかの操作に合わせ、文字を出さずアイコンだけにする（名前は読み上げとホバーで出す）。
 *
 * 注意: 読めない・断られたときは、黙らずに窓の中へ理由を出す（Fail-Fast）。断られたら窓を閉じず、書きかけを残す。
 * 注意: 書きかけは窓を閉じると捨てる（バーはページを移っても残るので、窓を閉じたあとまで書きかけを抱えない）。
 *   窓を開いて書きかけているあいだだけ、ページの再読み込みの前に確認を出す（useUnsavedChanges）。
 */
import { NotebookPen } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import { Link, useUnsavedChanges } from '@/app/router'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { iconButtonName } from '@/core/icon-button'
import type { TextApi } from './api'
import type { TextEntry } from './entry'
import { draftOf, editBody, textFailureLines, toTextInput } from './form'

/** テキストの追加・名前の変更・削除ができるページ */
const TEXT_PAGE_PATH = '/texts/'

/** 窓を開いてから読み込んだテキスト。読み込み中・読めなかった（理由を添える）・読めた、のどれか */
type Loaded = { readonly status: 'loading' } | { readonly status: 'failed'; readonly message: string } | { readonly status: 'ready'; readonly texts: readonly TextEntry[] }

export const TextBar = ({ api }: { api: TextApi }) => {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  /** 書き換えるテキストのID。窓を開くたびに、前に選んだものがまだあればそれ、無ければ最初のテキストにする */
  const [selectedId, setSelectedId] = useState<number>()
  /** 書きかけの本文 */
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  /** 断られた理由（1行ずつ） */
  const [failure, setFailure] = useState<readonly string[]>()
  /** いちばん新しく始めた読み込みの世代。窓を開き直して読み込みが重なったとき、古い読み込みの結果で上書きしないために使う */
  const latestLoad = useRef(0)

  const selected = loaded.status === 'ready' ? loaded.texts.find((text) => text.id === selectedId) : undefined
  const dirty = open && selected !== undefined && body !== selected.body
  useUnsavedChanges(dirty)

  const select = (text: TextEntry | undefined): void => {
    setSelectedId(text?.id)
    setBody(text?.body ?? '')
    setFailure(undefined)
  }

  const load = async (): Promise<void> => {
    latestLoad.current += 1
    const generation = latestLoad.current
    setLoaded({ status: 'loading' })
    setFailure(undefined)
    try {
      const texts = await api.list()
      if (generation !== latestLoad.current) return
      setLoaded({ status: 'ready', texts })
      select(texts.find((text) => text.id === selectedId) ?? texts[0])
    } catch (error) {
      if (generation !== latestLoad.current) return
      setLoaded({ status: 'failed', message: errorMessage(error) })
    }
  }

  const changeOpen = (next: boolean): void => {
    setOpen(next)
    if (next) void load()
  }

  const save = async (): Promise<void> => {
    if (selected === undefined) return
    setBusy(true)
    try {
      await api.update(selected.id, toTextInput(editBody(draftOf(selected), body)))
      setOpen(false)
    } catch (error) {
      setFailure(textFailureLines(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" className="size-9 shrink-0 rounded-full text-muted-foreground" {...iconButtonName('テキストを書き換える')} />}
      >
        <NotebookPen aria-hidden="true" className="size-5" />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80">
        {loaded.status === 'loading' && <p className="text-muted-foreground">テキストを読み込んでいます…</p>}
        {loaded.status === 'failed' && (
          <p role="alert" className="text-destructive">
            テキストを読み込めませんでした（{loaded.message}）
          </p>
        )}
        {loaded.status === 'ready' && loaded.texts.length === 0 && (
          <p className="text-muted-foreground">
            テキストがありません。
            <Link href={TEXT_PAGE_PATH} className="underline underline-offset-4">
              テキストのページ
            </Link>
            で追加してください。
          </p>
        )}
        {loaded.status === 'ready' && selected !== undefined && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-text`}>書き換えるテキスト</Label>
              <NativeSelect
                id={`${id}-text`}
                className="w-full"
                value={String(selected.id)}
                onChange={(event) => select(loaded.texts.find((text) => String(text.id) === event.currentTarget.value))}
              >
                {loaded.texts.map((text) => (
                  <NativeSelectOption key={text.id} value={String(text.id)}>
                    {text.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-body`}>本文</Label>
              <Textarea id={`${id}-body`} value={body} rows={4} onChange={(event) => setBody(event.currentTarget.value)} />
              {selected.mode === 'auto' && <p className="text-xs text-muted-foreground">LLMが自動で書き換えています。保存すると手動に切り替わります</p>}
            </div>
            {failure !== undefined && (
              <p role="alert" className="text-xs whitespace-pre-line text-destructive">
                {failure.join('\n')}
              </p>
            )}
            <div className="flex items-center justify-between gap-2">
              <Link href={TEXT_PAGE_PATH} className="text-xs text-muted-foreground underline underline-offset-4">
                テキストのページ
              </Link>
              <Button type="button" size="sm" disabled={busy || body === selected.body} onClick={() => void save()}>
                保存する
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
