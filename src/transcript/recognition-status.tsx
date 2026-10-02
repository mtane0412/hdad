/**
 * サイドバーに出す、音声認識の状態（issue #189）
 *
 * 文字起こしをオンにしているあいだだけ、サイドバーの末尾に「文字起こし: 聞いています」などを出す。
 * どのページを見ていても、認識が途切れた・止まったことに気づけるようにするためである（気づけないまま配信が終わらないように）。
 * 押すとコネクターのページ（オン・オフと詳しい様子がある）へ移る。
 */
import { Mic } from 'lucide-react'
import { Link } from '@/app/router'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { useRecognition } from './recognition-context'
import { describeRecognition, type RecognitionTone } from './recognition-label'
import { useStallClock } from './use-stall-clock'

/** オン・オフと詳しい様子があるページ */
const SETTINGS_PATH = '/connectors/'

const TONE_CLASSES: Readonly<Record<RecognitionTone, string>> = {
  idle: 'bg-muted-foreground',
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-destructive',
}

/** 状態の色の丸。色だけでは伝わらないので、必ず言葉と並べて使う */
export const RecognitionDot = ({ tone }: { tone: RecognitionTone }) => (
  <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${TONE_CLASSES[tone]}`} />
)

export const RecognitionStatus = () => {
  const value = useRecognition()
  const now = useStallClock(value.recognizer)
  if (!value.enabled) return null
  const { label, tone } = describeRecognition(value, now)
  const text = `文字起こし: ${label}`

  return (
    <SidebarMenuItem>
      <SidebarMenuButton tooltip={text} render={<Link href={SETTINGS_PATH} />}>
        <Mic aria-hidden="true" />
        <span className="truncate">{text}</span>
        <RecognitionDot tone={tone} />
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
