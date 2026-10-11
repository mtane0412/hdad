/**
 * ペロペロの効果音の再生（issue #340）
 *
 * 効果音を鳴らす合図の並び（sound-cues.ts の lickSoundCuesOf）を受け取り、合図の時刻ごとに Audio 要素で1回ずつ鳴らす。
 * 音程は再生の速さ（playbackRate）で変え、速さと一緒に音程も変わるよう preservesPitch を切る。
 * DOM（Audio 要素）とタイマーを扱うため、いつ・どの音程で鳴らすかの判断（sound-cues.ts）と分けてテストの対象外にしている
 * （ツイスターの src/twister/bgm-player.ts と同じ分け方）。
 *
 * 時刻は requestAnimationFrame ではなくタイマーで数える（OBSのブラウザソースは画面に映っていないと描画を間引くことがあるため）。
 * 合図ごとに Audio 要素を作り直すのは、前の音が鳴り終わる前に次を重ねて鳴らすため（同じ音声はブラウザの読み込みを使い回す）。
 *
 * 注意: 鳴らせなかった（ブラウザが自動再生を拒んだ・音声を読めなかった）ら onError で知らせる。黙って無音のまま続けない。
 */
import type { LickSoundCue } from './sound-cues'

export interface LickSoundPlayer {
  /** 1回のペロペロの効果音を、流しはじめた今から合図の時刻に鳴らしていく。鳴らしている途中のものがあれば止めてから始める */
  start(url: string, volume: number, cues: readonly LickSoundCue[]): void
  /** 鳴らす予定の効果音を取り消し、鳴っている音を止める */
  stop(): void
}

/**
 * ペロペロの効果音の再生を用意する。
 *
 * @param onError 鳴らせなかったときに呼ぶ
 */
export const createLickSoundPlayer = (onError: (error: Error) => void): LickSoundPlayer => {
  /** 鳴らす予定のタイマーと、鳴らした Audio 要素（止めるときに使う） */
  let timers: number[] = []
  let playing: HTMLAudioElement[] = []
  /** この1回のペロペロで、鳴らせなかったことをもう知らせたか（自動再生を拒まれると合図ごとに失敗するので、知らせるのは1回にする） */
  let reported = false

  const stop = (): void => {
    for (const timer of timers) window.clearTimeout(timer)
    for (const audio of playing) audio.pause()
    timers = []
    playing = []
  }

  const play = (url: string, volume: number, cue: LickSoundCue): void => {
    const audio = new Audio(url)
    audio.volume = volume
    audio.preservesPitch = false
    audio.playbackRate = cue.pitch
    playing = [...playing, audio]
    // 鳴り終えた音は持ち続けない（配信中に何度も流すため）
    audio.addEventListener('ended', () => {
      playing = playing.filter((item) => item !== audio)
    })
    audio.play().catch((error: unknown) => {
      if (reported) return
      reported = true
      onError(new Error(`ペロペロの効果音を鳴らせませんでした: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    })
  }

  const start: LickSoundPlayer['start'] = (url, volume, cues) => {
    stop()
    reported = false
    timers = cues.map((cue) => window.setTimeout(() => play(url, volume, cue), cue.atMs))
  }

  return { start, stop }
}
