/**
 * BGMの管理画面の値の変換
 *
 * 画面（bgm-page.tsx）が使う変換のうち、DOM を持たないものをここに分けてテストする（src/speech/form.ts と同じ分け方）。
 *
 * 注意: ここは変換だけを行い、値の範囲は見ない。範囲の検証は Worker（worker/bgm-config.ts）だけが持ち、
 * 画面とWorkerで二重に持たない。
 */
import type { BgmTrack } from './api'

/** Worker が問題点に書く項目の名前と、画面に見えている名前 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  mediaId: '音声',
  title: '曲名',
  credit: 'クレジット表記',
  creditUrl: 'クレジット先のURL',
  mood: '曲調',
  scene: '流したい場面',
}

/** 曲の項目の問題点（tracks[番号].項目: 理由） */
const TRACK_PROBLEM = /^tracks\[(\d+)\]\.(\w+): (.*)$/
/** 音量の問題点 */
const VOLUME_PROBLEM = /^volume: (.*)$/

/** 百分率の刻み。0.29 * 100 が 28.999… になるような小数の誤差を丸める */
const PERCENT = 100

/**
 * Worker が返した問題点を、画面に見えている名前で読める文にする。
 *
 * 読み替えられないもの（一覧全体の問題など）は、黙って捨てずにそのまま返す。
 */
export const describeBgmProblem = (problem: string): string => {
  const track = TRACK_PROBLEM.exec(problem)
  if (track) {
    const [, index, field, reason] = track
    const label = FIELD_LABELS[field ?? '']
    if (label !== undefined) return `${Number(index) + 1}曲目の${label}: ${reason}`
  }
  const volume = VOLUME_PROBLEM.exec(problem)
  if (volume) return `音量: ${volume[1]}`
  return problem
}

/** 0〜1 の音量を、スライダーの 0〜100 にする */
export const volumePercentOf = (volume: number): number => Math.round(volume * PERCENT)

/** スライダーの 0〜100 を、0〜1 の音量にする */
export const volumeOfPercent = (percent: number): number => percent / PERCENT

/**
 * 上げた音声から、曲の下書きを作る。
 *
 * 曲名はファイル名から拡張子を落としたものを下書きにする（多くの配布元はファイル名に曲名を付けているため）。
 * クレジット表記は配布元ごとに書き方が決まっているので、推測で埋めず空のまま配信者に書いてもらう。
 */
export const newTrackOf = (media: { readonly id: string; readonly name: string }): BgmTrack => ({
  mediaId: media.id,
  title: media.name.replace(/\.[^.]+$/, ''),
  credit: '',
  creditUrl: '',
  mood: '',
  scene: '',
})

/** 上げた素材のうち、まだ曲にしていない音声 */
export const unusedAudioOf = <T extends { readonly id: string; readonly kind: string }>(media: readonly T[], tracks: readonly BgmTrack[]): T[] =>
  media.filter((item) => item.kind === 'audio' && !tracks.some((track) => track.mediaId === item.id))
