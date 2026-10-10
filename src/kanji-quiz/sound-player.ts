/**
 * 漢字クイズの音の再生
 *
 * 鳴らす時刻の表（sound-cues.ts）の1行を受け取って、Audio 要素で鳴らす。BGM はループで鳴らし、下げる指示で
 * 音量を0まで下げてから止める。効果音は1回ずつ鳴らす（カウントダウンのように続けて鳴っても重なってよい）。
 * DOM（Audio 要素）を扱うため、何をいつ鳴らすかの判断（sound-cues.ts）と分けてテストの対象外にしている
 * （市町村紹介の src/town-tour/sound-player.ts と同じ分け方）。
 *
 * 音量の変化は requestAnimationFrame ではなくタイマーで刻み、刻むたびに経過時間から音量を決める
 * （OBSのブラウザソースは画面に映っていないと描画を間引くことがあるため。src/bgm/player.ts と同じ）。
 *
 * 注意: 再生を始められなかった（ブラウザが自動再生を拒んだ・音声を読めなかった）ら onError で知らせる。
 * 黙って無音のまま続けない。
 */
import type { KanjiQuizSoundCue } from './sound-cues'

/** 音量を刻む間隔（ミリ秒） */
const FADE_STEP_MS = 50

export interface KanjiQuizSoundPlayer {
  /** 表の1行を行う。失敗は onError で知らせる */
  play(cue: KanjiQuizSoundCue): void
  /** 鳴らしている音をすべて止める（1回の出題を流し終えたとき） */
  stop(): void
}

/** 鳴らしている音声1つと、その後始末 */
interface Playing {
  readonly audio: HTMLAudioElement
  readonly release: () => void
}

/**
 * 漢字クイズの音の再生を用意する。
 *
 * @param onError 再生を始められなかった・鳴らしている途中で音声を読めなくなったときに呼ぶ
 */
export const createKanjiQuizSoundPlayer = (onError: (error: Error) => void): KanjiQuizSoundPlayer => {
  let bgm: (Playing & { fadeTimer: number | undefined }) | null = null
  /** 鳴らしている効果音 */
  const effects = new Set<Playing>()

  /**
   * 音声を用意し、鳴らしはじめる。始められない・読めなくなったら、片付けてから知らせる。
   *
   * 配信中に何度も流すので、止めた音声を持ち続けない。見張りを先に外すのは、捨てた音声の読み込みの失敗を
   * 「鳴らしている音の失敗」として知らせないためである。
   *
   * @param what 失敗を知らせる文に出す、何の音か
   * @param isCurrent まだ鳴らすつもりでいるか。止めた後の失敗は知らせない
   * @param forget 鳴らしている音の記録から外す
   */
  const open = (url: string, volume: number, what: string, isCurrent: (playing: Playing) => boolean, forget: (playing: Playing) => void): Playing => {
    const audio = new Audio(url)
    audio.volume = volume
    const fail = (message: string): void => {
      if (!isCurrent(playing)) return
      forget(playing)
      playing.release()
      onError(new Error(message))
    }
    const onAudioError = (): void => fail(`${what}の音声を読めませんでした（素材が消えた・通信が切れた可能性があります）`)
    const playing: Playing = {
      audio,
      release: () => {
        audio.removeEventListener('error', onAudioError)
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      },
    }
    audio.addEventListener('error', onAudioError)
    // OBSのブラウザソースでは自動再生が許されるが、普通のブラウザのタブでは操作前の再生を拒まれることがある
    audio.play().catch((error: unknown) => fail(`${what}を再生できませんでした: ${String(error)}`))
    return playing
  }

  const stopBgm = (): void => {
    if (bgm === null) return
    window.clearInterval(bgm.fadeTimer)
    bgm.release()
    bgm = null
  }

  const startBgm = (url: string, volume: number): void => {
    stopBgm()
    const playing = open(
      url,
      volume,
      '漢字クイズの BGM',
      (candidate) => bgm?.audio === candidate.audio,
      () => {
        if (bgm !== null) window.clearInterval(bgm.fadeTimer)
        bgm = null
      },
    )
    playing.audio.loop = true
    bgm = { ...playing, fadeTimer: undefined }
  }

  /** BGM を duration ミリ秒かけて0まで下げ、止める */
  const fadeOutBgm = (duration: number): void => {
    const playing = bgm
    if (playing === null) return
    window.clearInterval(playing.fadeTimer)
    const from = playing.audio.volume
    const startedAt = performance.now()
    playing.fadeTimer = window.setInterval(() => {
      const progress = duration === 0 ? 1 : Math.min((performance.now() - startedAt) / duration, 1)
      playing.audio.volume = from * (1 - progress)
      if (progress >= 1 && bgm === playing) stopBgm()
    }, FADE_STEP_MS)
  }

  /** 効果音を1回鳴らす。鳴り終えたら手放す（短いので、終わるまで持っていてよい） */
  const playEffect = (url: string, volume: number): void => {
    const playing = open(url, volume, '漢字クイズの効果音', (candidate) => effects.has(candidate), (candidate) => effects.delete(candidate))
    effects.add(playing)
    playing.audio.addEventListener(
      'ended',
      () => {
        if (!effects.delete(playing)) return
        playing.release()
      },
      { once: true },
    )
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
      for (const playing of effects) playing.release()
      effects.clear()
    },
  }
}
