/**
 * BGMの再生
 *
 * 裏方のページで曲をループで鳴らし、切り替えるときは前の曲を消えていくように下げながら次の曲を上げてつなぐ。
 * DOM（Audio 要素）を扱うため、何をするかの判断（change.ts）と分けてテストの対象外にしている
 * （読み上げの src/speech/audio.ts と同じ分け方）。
 *
 * 音量の変化は requestAnimationFrame ではなくタイマーで刻む。OBSのブラウザソースは画面に映っていないと
 * 描画を間引くことがあり、描画に合わせて刻むとフェードが止まったままになるためである。刻むたびに経過時間から
 * 音量を決めるので、タイマーが遅れてもフェードの長さは変わらない。
 *
 * 注意: 再生を始められなかった（ブラウザが自動再生を拒んだ・音声を読めなかった）ら投げる。黙って無音のまま続けない。
 */
import type { BgmChange } from './change'

/** 曲を切り替えるときに、前の曲を下げ・次の曲を上げる長さ（ミリ秒） */
const FADE_MS = 2000
/** 音量だけを変えるときの長さ（ミリ秒）。つまみを動かした感触が残る程度に短くする */
const VOLUME_FADE_MS = 300
/** 音量を刻む間隔（ミリ秒） */
const FADE_STEP_MS = 50

/** 1つの Audio 要素の音量を、経過時間に沿って from から to へ動かす。途中で別のフェードが始まったら前のものは止める */
const createFader = (audio: HTMLAudioElement) => {
  let timer: number | undefined
  return {
    /** 音量を to まで動かし、動かし終えたら解決する */
    fadeTo: (to: number, duration: number): Promise<void> =>
      new Promise((resolve) => {
        window.clearInterval(timer)
        const from = audio.volume
        const startedAt = performance.now()
        timer = window.setInterval(() => {
          const progress = Math.min((performance.now() - startedAt) / duration, 1)
          audio.volume = from + (to - from) * progress
          if (progress < 1) return
          window.clearInterval(timer)
          resolve()
        }, FADE_STEP_MS)
      }),
    stop: (): void => window.clearInterval(timer),
  }
}

/** 鳴らしている1曲 */
interface Playing {
  readonly audio: HTMLAudioElement
  readonly fader: ReturnType<typeof createFader>
  /** 音声を読めなかったときの見張り。止めるときに外す */
  readonly onAudioError: () => void
}

export interface BgmPlayer {
  /**
   * 決めたこと（change.ts の bgmChangeOf）を行う。
   *
   * @throws 次の曲の再生を始められなかった場合
   */
  apply(change: BgmChange): Promise<void>
}

/**
 * BGMの再生を用意する。
 *
 * @param onError 鳴らしている途中で音声を読めなくなったときに呼ぶ（読み込みの途中で通信が切れた場合など）
 */
export const createBgmPlayer = (onError: (error: Error) => void): BgmPlayer => {
  let playing: Playing | null = null

  /**
   * 曲を止め、見張りを外して読み込みも捨てる。
   *
   * src を外して読み込みを捨てるのは、配信中に何度も切り替えるので止めた曲の音声を持ち続けないためである。
   * 見張りを先に外すのは、捨てた音声の読み込みの失敗を「鳴らしている曲の失敗」として知らせないためである。
   */
  const release = (target: Playing): void => {
    target.fader.stop()
    target.audio.removeEventListener('error', target.onAudioError)
    target.audio.pause()
    target.audio.removeAttribute('src')
    target.audio.load()
  }

  /** 鳴らしている曲を下げきってから止める */
  const fadeOut = async (target: Playing): Promise<void> => {
    await target.fader.fadeTo(0, FADE_MS)
    release(target)
  }

  /** 次の曲を音量0で鳴らし始め、上げていく。鳴らし始められなければ片付けてから投げる */
  const fadeIn = async (url: string, volume: number): Promise<Playing> => {
    const audio = new Audio(url)
    audio.loop = true
    audio.volume = 0
    const onAudioError = (): void => onError(new Error('BGMの音声を読めませんでした（素材が消えた・通信が切れた可能性があります）'))
    audio.addEventListener('error', onAudioError)
    const next: Playing = { audio, fader: createFader(audio), onAudioError }
    // OBSのブラウザソースでは自動再生が許されるが、普通のブラウザのタブでは操作前の再生を拒まれることがある
    await audio.play().catch((error: unknown) => {
      release(next)
      throw new Error(`BGMを再生できませんでした: ${String(error)}`)
    })
    void next.fader.fadeTo(volume, FADE_MS)
    return next
  }

  return {
    apply: async (change) => {
      switch (change.type) {
        case 'none':
          return
        case 'volume':
          if (playing) void playing.fader.fadeTo(change.volume, VOLUME_FADE_MS)
          return
        case 'stop': {
          const previous = playing
          playing = null
          if (previous) await fadeOut(previous)
          return
        }
        case 'switch': {
          const previous = playing
          // 次の曲を先に鳴らし始めてから前の曲を下げる。次の曲を鳴らせなかったら前の曲は流したままにする
          // （切り替えの失敗で配信が無音になるより、前の曲が続くほうが害が小さい）
          playing = await fadeIn(change.url, change.volume)
          if (previous) await fadeOut(previous)
          return
        }
      }
    },
  }
}
