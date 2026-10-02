/**
 * つなぎ直しが長引いているかを画面に出すための現在時刻
 *
 * 音声認識がつなぎ直しているあいだだけ1秒ごとに現在時刻を更新し、「途切れています（n秒）」を数え上げる
 * （recognition-label.ts の describeRecognition に渡す）。聞いているあいだは時計を止め、描き直しを起こさない。
 */
import { useEffect, useState } from 'react'
import type { RecognizerState } from './recognizer'

const TICK_MS = 1_000

export const useStallClock = (recognizer: RecognizerState): number => {
  const [now, setNow] = useState(() => Date.now())
  const reconnecting = recognizer.status.kind === 'reconnecting'

  useEffect(() => {
    setNow(Date.now())
    if (!reconnecting) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [reconnecting])

  return now
}
