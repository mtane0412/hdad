/**
 * アプリの枠で動かす音声認識の状態を、画面に出す言葉と色の種類にする
 *
 * 下部バー（recognition-control.tsx）とコネクターのページの区画（recognition-section.tsx）で同じ言い方にするため、
 * ここだけが決める。
 *
 * 注意: Chrome は黙っているだけでも数秒ごとに認識を終えるので、つなぎ直しが一瞬で済んでいるあいだは
 * 「聞いています」のまま出す。STALL_MS を超えて戻らないときだけ、途切れていると出す（見慣れて見落とさないため）。
 */
import type { RecognitionContextValue } from './recognition-context'

/** 画面に出す色の種類。idle は灰、ok は緑、warn は黄、error は赤 */
export type RecognitionTone = 'idle' | 'ok' | 'warn' | 'error'

export interface RecognitionLabel {
  label: string
  tone: RecognitionTone
}

/** つなぎ直しがこれより長引いたら、途切れていると出す（ミリ秒） */
export const STALL_MS = 5_000

const SECONDS_PER_MINUTE = 60

/** 長さ（ミリ秒）を「n秒」「n分m秒」で表す */
export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < SECONDS_PER_MINUTE) return `${seconds}秒`
  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}分${seconds % SECONDS_PER_MINUTE}秒`
}

/**
 * いまの状態を言い表す。
 *
 * @param now 現在時刻。つなぎ直しがどれだけ長引いているかに使う
 */
export const describeRecognition = (value: Pick<RecognitionContextValue, 'phase' | 'error' | 'recognizer'>, now: number): RecognitionLabel => {
  switch (value.phase) {
    case 'off':
      return { label: 'オフ', tone: 'idle' }
    case 'unsupported':
      return { label: 'このブラウザでは使えません', tone: 'error' }
    case 'waiting':
      return { label: '別のタブで認識中', tone: 'idle' }
    case 'failed':
      return { label: '止まっています', tone: 'error' }
    case 'running':
      break
  }
  const { status } = value.recognizer
  switch (status.kind) {
    case 'stopped':
      return { label: '止めています', tone: 'idle' }
    case 'starting':
      return { label: '始めています', tone: 'idle' }
    case 'listening':
      return { label: '聞いています', tone: 'ok' }
    case 'reconnecting': {
      const stalled = now - status.since
      if (stalled < STALL_MS) return { label: '聞いています', tone: 'ok' }
      return { label: `途切れています（${formatDuration(stalled)}）`, tone: 'warn' }
    }
    case 'failed':
      return { label: '止まっています', tone: 'error' }
  }
}
