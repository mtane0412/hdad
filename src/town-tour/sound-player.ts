/**
 * 市町村紹介の音の再生（issue #244）
 *
 * 鳴らす時刻の表（sound-cues.ts）の1行を受け取って、Audio 要素で鳴らす。BGM はループで鳴らし、下げる指示で
 * 音量を0まで下げてから止める。効果音は1回ずつ鳴らす（重なってもよい）。
 * DOM（Audio 要素）を扱うため、何をいつ鳴らすかの判断（sound-cues.ts）と分けてテストの対象外にしている
 * （BGM の src/bgm/player.ts と同じ分け方）。
 *
 * 音量の変化は requestAnimationFrame ではなくタイマーで刻み、刻むたびに経過時間から音量を決める
 * （OBSのブラウザソースは画面に映っていないと描画を間引くことがあるため。src/bgm/player.ts と同じ）。
 *
 * 注意: 再生を始められなかった（ブラウザが自動再生を拒んだ・音声を読めなかった）ら onError で知らせる。
 * 黙って無音のまま続けない。
 */
import type { SoundCue } from './sound-cues'

/** 音量を刻む間隔（ミリ秒） */
const FADE_STEP_MS = 50

/** 鳴らしている BGM */
interface PlayingBgm {
  readonly audio: HTMLAudioElement
  /** 音声を読めなかったときの見張り。止めるときに外す */
  readonly onAudioError: () => void
  /** 下げている途中のタイマー。下げていなければ undefined */
  fadeTimer: number | undefined
}

export interface TownTourSoundPlayer {
  /** 表の1行を行う。失敗は onError で知らせる */
  play(cue: SoundCue): void
  /** 鳴らしている音をすべて止める（再生の終わり・紹介を作れなかったとき） */
  stop(): void
}

/**
 * 音声を止め、読み込みも捨てる。
 *
 * 配信中に何度も流すので、止めた音声を持ち続けない。見張りを先に外すのは、捨てた音声の読み込みの失敗を
 * 「鳴らしている音の失敗」として知らせないためである。
 */
const release = (audio: HTMLAudioElement, onAudioError: () => void): void => {
  audio.removeEventListener('error', onAudioError)
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
}

/**
 * 市町村紹介の音の再生を用意する。
 *
 * @param onError 再生を始められなかった・鳴らしている途中で音声を読めなくなったときに呼ぶ
 */
export const createTownTourSoundPlayer = (onError: (error: Error) => void): TownTourSoundPlayer => {
  let bgm: PlayingBgm | null = null
  /** 鳴らしている効果音と、その読み込みの失敗の見張り */
  const effects = new Map<HTMLAudioElement, () => void>()

  const stopBgm = (): void => {
    if (bgm === null) return
    window.clearInterval(bgm.fadeTimer)
    release(bgm.audio, bgm.onAudioError)
    bgm = null
  }

  const stopEffect = (audio: HTMLAudioElement): void => {
    const onAudioError = effects.get(audio)
    if (onAudioError === undefined) return
    effects.delete(audio)
    release(audio, onAudioError)
  }

  /**
   * 音声を鳴らしはじめる。始められなければ片付けてから知らせる。
   *
   * @param isCurrent まだ鳴らすつもりでいるか。始まる前に止めた（stop で再生を中断した）音の失敗は知らせない
   */
  const start = (audio: HTMLAudioElement, what: string, isCurrent: () => boolean, cleanUp: () => void): void => {
    // OBSのブラウザソースでは自動再生が許されるが、普通のブラウザのタブでは操作前の再生を拒まれることがある
    audio.play().catch((error: unknown) => {
      if (!isCurrent()) return
      cleanUp()
      onError(new Error(`${what}を再生できませんでした: ${String(error)}`))
    })
  }

  const startBgm = (url: string, volume: number): void => {
    stopBgm()
    const audio = new Audio(url)
    audio.loop = true
    audio.volume = volume
    // 先に止めてから知らせる。止めておけば、続く play() の失敗は isCurrent で弾かれ、同じ失敗を二重に知らせない
    const onAudioError = (): void => {
      if (bgm !== playing) return
      stopBgm()
      onError(new Error('市町村紹介の BGM の音声を読めませんでした（素材が消えた・通信が切れた可能性があります）'))
    }
    audio.addEventListener('error', onAudioError)
    const playing: PlayingBgm = { audio, onAudioError, fadeTimer: undefined }
    bgm = playing
    start(audio, '市町村紹介の BGM', () => bgm === playing, stopBgm)
  }

  /** BGM を duration ミリ秒かけて0まで下げ、止める */
  const fadeOutBgm = (duration: number): void => {
    const playing = bgm
    if (playing === null) return
    window.clearInterval(playing.fadeTimer)
    const from = playing.audio.volume
    const startedAt = performance.now()
    playing.fadeTimer = window.setInterval(() => {
      const progress = Math.min((performance.now() - startedAt) / duration, 1)
      playing.audio.volume = from * (1 - progress)
      if (progress < 1) return
      if (bgm === playing) stopBgm()
    }, FADE_STEP_MS)
  }

  const playEffect = (url: string, volume: number): void => {
    const audio = new Audio(url)
    audio.volume = volume
    const onAudioError = (): void => {
      stopEffect(audio)
      onError(new Error('市町村紹介の効果音の音声を読めませんでした（素材が消えた・通信が切れた可能性があります）'))
    }
    audio.addEventListener('error', onAudioError)
    // 鳴り終えたら手放す（効果音は短いので、終わるまで持っていてよい）
    audio.addEventListener('ended', () => stopEffect(audio), { once: true })
    effects.set(audio, onAudioError)
    start(audio, '市町村紹介の効果音', () => effects.has(audio), () => stopEffect(audio))
  }

  return {
    play: (cue) => {
      switch (cue.type) {
        case 'bgmStart':
          startBgm(cue.url, cue.volume)
          return
        case 'bgmFadeOut':
          fadeOutBgm(cue.duration)
          return
        case 'effect':
          playEffect(cue.url, cue.volume)
          return
      }
    },
    stop: () => {
      stopBgm()
      for (const audio of [...effects.keys()]) stopEffect(audio)
    },
  }
}
