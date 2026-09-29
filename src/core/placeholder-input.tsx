/**
 * 差し込み語を押して入れられる、文言の入力欄
 *
 * 差し込み語を手で打つと綴りや括弧を間違えやすく、間違いに気づくのが「配信中に置き換わらなかったとき」になるため、
 * 押して入れられるようにする（docs/principles.md の2）。並べる語は呼び出し側が決める（置き換わらない語を押させない）。
 * トリガーの管理画面（src/admin/trigger-page.tsx）とチャットボットの画面（src/bot/bot-page.tsx）が使う。
 *
 * 入れる位置はカーソルの位置なので、入力欄の要素を持つこのコンポーネントがカーソルを読み、
 * 文言の組み立て（placeholder.ts の insertPlaceholder）だけを分けてテストする。
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { insertPlaceholder } from './placeholder'

interface PlaceholderInputProps {
  /** 入力欄のID。見出し（Label）と結びつけるときに渡す */
  id?: string
  /** 欄の名前。ボタンの読み上げ（「〜に {user} を挿入」）に使い、id が無ければ入力欄の aria-label にもする */
  name: string
  /** 押して入れられる差し込み語 */
  placeholders: readonly string[]
  value: string
  maxLength: number
  /** 入力例（空欄のときに薄く出す） */
  example: string
  disabled?: boolean
  onChange(value: string): void
}

export const PlaceholderInput = ({ id, name, placeholders, value, maxLength, example, disabled, onChange }: PlaceholderInputProps) => {
  const inputRef = useRef<HTMLInputElement>(null)
  /** 差し込み語を入れたあとにカーソルを置く位置。入力欄の値が書き換わってからでないと動かせないので、描き終わってから動かす */
  const [cursor, setCursor] = useState<number | null>(null)

  useEffect(() => {
    const input = inputRef.current
    if (cursor === null || input === null) return
    input.focus()
    input.setSelectionRange(cursor, cursor)
    setCursor(null)
  }, [cursor])

  const insert = (placeholder: string): void => {
    const input = inputRef.current
    // ボタンは入力欄と一緒に描かれるので、ここへは来ない（型を絞るための確認）
    if (input === null) return
    const inserted = insertPlaceholder(value, placeholder, input.selectionStart ?? value.length, input.selectionEnd ?? value.length)
    onChange(inserted.value)
    setCursor(inserted.cursor)
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        id={id}
        // 見出しと結びつかない欄（表の中など）では、欄の名前を読み上げに与える
        aria-label={id === undefined ? name : undefined}
        ref={inputRef}
        type="text"
        maxLength={maxLength}
        value={value}
        placeholder={example}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <div className="flex flex-wrap gap-1">
        {placeholders.map((placeholder) => (
          <Button
            key={placeholder}
            type="button"
            variant="outline"
            size="xs"
            className="font-mono"
            disabled={disabled}
            // どの欄に入るかは見た目では分かるが読み上げでは分からないので、欄の名前を添える
            aria-label={`${name}に ${placeholder} を挿入`}
            onClick={() => insert(placeholder)}
          >
            {placeholder}
          </Button>
        ))}
      </div>
    </div>
  )
}
