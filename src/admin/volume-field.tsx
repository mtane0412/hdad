/**
 * 音量のつまみ（トリガーのページの音の設定）
 *
 * 市町村紹介の音（town-tour-sound-card.tsx）とツイスターの BGM（twister-card.tsx）で共通の、0〜1 の音量を
 * ％のつまみで選ぶ欄。つまみの横に今の値を％で出す。
 *
 * 注意: jsdom では Base UI の Slider のつまみが隠れたままなので、テストでは外枠の role="group" の名前（label）から探す。
 */
import { Slider } from '@/components/ui/slider'

/** 音量のつまみの最大（％）。保存する値は 0〜1 */
const MAX_VOLUME_PERCENT = 100

/** 0〜1 の音量を、つまみと表示に使う％にする */
const toPercent = (volume: number): number => Math.round(volume * MAX_VOLUME_PERCENT)

interface VolumeFieldProps {
  id: string
  label: string
  /** 音量（0〜1） */
  volume: number
  onChange(volume: number): void
}

export const VolumeField = ({ id, label, volume, onChange }: VolumeFieldProps) => (
  <div className="flex flex-col gap-2">
    <span id={id} className="text-sm leading-none font-medium">
      {label}
    </span>
    <div className="flex h-8 items-center gap-3">
      <Slider
        aria-labelledby={id}
        min={0}
        max={MAX_VOLUME_PERCENT}
        value={[toPercent(volume)]}
        onValueChange={(next) => onChange((Array.isArray(next) ? (next[0] ?? 0) : next) / MAX_VOLUME_PERCENT)}
      />
      <output className="w-12 text-right font-mono text-xs tabular-nums">{toPercent(volume)}%</output>
    </div>
  </div>
)
