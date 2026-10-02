/**
 * ヘルプボタン
 *
 * 画面に常に並べるほどではないが、初めて使うときに要る説明（外部サービス側の設定・入力値の目安など）を、
 * ？のアイコンを押したときだけ吹き出しで出す。ページの各項目には説明文を並べず、要る説明はここに入れる。
 *
 * 注意: ボタンの名前は「<topic>の説明」にする。アイコンだけのボタンなので、読み上げとホバーに名前を渡す。
 */
import { CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { iconButtonName } from '@/core/icon-button'

/**
 * @param topic 何の説明か（ボタンの名前「<topic>の説明」になる）
 * @param children 吹き出しに出す説明
 */
export const HelpButton = ({ topic, children }: { topic: string; children: ReactNode }) => (
  <Popover>
    <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-sm" {...iconButtonName(`${topic}の説明`)} />}>
      <CircleHelp aria-hidden="true" />
    </PopoverTrigger>
    {/* 説明が長くても画面からはみ出さないよう、高さを抑えて中だけを送る */}
    <PopoverContent align="end" className="max-h-[70vh] w-80 overflow-y-auto">
      {children}
    </PopoverContent>
  </Popover>
)
