/**
 * 下部バーに置く、文字起こしのオン・オフと状態（issue #235）
 *
 * どのページを見ていても、文字起こしをオン・オフでき、オンのあいだは「聞いています」などの状態が見えるようにする。
 * 認識が途切れた・止まったことに気づけないまま配信が終わらないようにするためである。
 * 状態を押すとコネクターのページ（詳しい様子と始め直しのボタンがある）へ移る。
 *
 * ボタンは下部バーの音楽プレーヤーの操作に合わせ、文字を出さずアイコンだけにする（名前は読み上げとホバーで出す）。
 * オンのあいだはアイコンを強調色にする。状態は言葉でも出す（途切れたことを色だけで伝えないため）。
 *
 * 注意: 値を受け取って描くだけの RecognitionControlView を分けているのは、テストで文脈を組み立てずに確かめるためである。
 */
import { Mic, MicOff } from 'lucide-react'
import { Link } from '@/app/router'
import { Toggle } from '@/components/ui/toggle'
import { iconButtonName } from '@/core/icon-button'
import { useRecognition, type RecognitionContextValue } from './recognition-context'
import { describeRecognition, type RecognitionTone } from './recognition-label'
import { useStallClock } from './use-stall-clock'

/** 詳しい様子と始め直しのボタンがあるページ */
const SETTINGS_PATH = '/connectors/'

/** 下部バーの切り替えボタンの見た目。押されているときは背景ではなくアイコンの色で示す（音楽プレーヤーのシャッフル・リピートと同じ） */
const PLAYER_TOGGLE_CLASS =
  'size-9 rounded-full text-muted-foreground aria-pressed:bg-transparent aria-pressed:text-primary hover:aria-pressed:bg-muted'

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

export const RecognitionControl = () => <RecognitionControlView value={useRecognition()} />

export const RecognitionControlView = ({ value }: { value: RecognitionContextValue }) => {
  const now = useStallClock(value.recognizer)
  const { label, tone } = describeRecognition(value, now)

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Toggle
        className={PLAYER_TOGGLE_CLASS}
        pressed={value.enabled}
        onPressedChange={(pressed) => value.setEnabled(pressed)}
        {...iconButtonName('文字起こし')}
      >
        {value.enabled ? <Mic aria-hidden="true" className="size-5" /> : <MicOff aria-hidden="true" className="size-5" />}
      </Toggle>
      {value.enabled && (
        <Link
          href={SETTINGS_PATH}
          aria-label={`文字起こしの様子: ${label}`}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RecognitionDot tone={tone} />
          <span className="truncate">{label}</span>
        </Link>
      )}
    </div>
  )
}
