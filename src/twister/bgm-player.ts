/**
 * ツイスターの BGM の再生
 *
 * 1回の対戦の流し方（bgm.ts の TwisterBgmPlan）を受け取り、Audio 要素でループで鳴らし、決めた時刻から音量を0まで下げて止める。
 * DOM（Audio 要素）とタイマーを扱うため、何をいつ鳴らすかの判断（bgm.ts）と分けてテストの対象外にしている
 * （市町村紹介の src/town-tour/sound-player.ts と同じ分け方）。
 *
 * 時刻は requestAnimationFrame ではなくタイマーで数える（OBSのブラウザソースは画面に映っていないと描画を間引くことがあるため。
 * src/bgm/player.ts と同じ）。
 *
 * 注意: 再生を始められなかった（ブラウザが自動再生を拒んだ・音声を読めなかった）ら onError で知らせる。黙って無音のまま続けない。
 */
import type { TwisterBgmPlan } from './bgm'

/** 音量を刻む間隔（ミリ秒） */
const FADE_STEP_MS = 50

export interface TwisterBgmPlayer {
  /** 1回の対戦の BGM を鳴らしはじめる。鳴らしている BGM があれば止めてから鳴らす */
  start(plan: TwisterBgmPlan): void
  /** 鳴らしている BGM を止める */
  stop(): void
}

/**
 * ツイスターの BGM の再生を用意する。
 *
 * @param onError 再生を始められなかった・鳴らしている途中で音声を読めなくなったときに呼ぶ
 */
export const createTwisterBgmPlayer = (onError: (error: Error) => void): TwisterBgmPlayer => {
  /** 鳴らしている BGM と、その後始末 */
  let current: { readonly audio: HTMLAudioElement; readonly release: () => void } | null = null

  const stop = (): void => {
    current?.release()
    current = null
  }

  const start = (plan: TwisterBgmPlan): void => {
    stop()
    const audio = new Audio(plan.url)
    audio.loop = true
    audio.volume = plan.volume
    let fadeTimer: number | undefined
    const onAudioError = (): void => {
      if (current?.audio !== audio) return
      stop()
      onError(new Error('ツイスターの BGM の音声を読めませんでした（素材が消えた・通信が切れた可能性があります）'))
    }
    // 対戦の終わりに向けて、経過時間から音量を決めて0まで下げ、下げ終えたら止める
    const fadeStartTimer = window.setTimeout(() => {
      const startedAt = performance.now()
      fadeTimer = window.setInterval(() => {
        const progress = plan.fadeOutMs === 0 ? 1 : Math.min((performance.now() - startedAt) / plan.fadeOutMs, 1)
        audio.volume = plan.volume * (1 - progress)
        if (progress >= 1 && current?.audio === audio) stop()
      }, FADE_STEP_MS)
    }, plan.fadeOutAtMs)
    // 配信中に何度も流すので、止めた音声を持ち続けない。見張りを先に外すのは、捨てた音声の読み込みの失敗を知らせないため
    const release = (): void => {
      window.clearTimeout(fadeStartTimer)
      window.clearInterval(fadeTimer)
      audio.removeEventListener('error', onAudioError)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    audio.addEventListener('error', onAudioError)
    current = { audio, release }
    // OBSのブラウザソースでは自動再生が許されるが、普通のブラウザのタブでは操作前の再生を拒まれることがある
    audio.play().catch((error: unknown) => {
      if (current?.audio !== audio) return
      stop()
      onError(new Error(`ツイスターの BGM を再生できませんでした: ${String(error)}`))
    })
  }

  return { start, stop }
}
