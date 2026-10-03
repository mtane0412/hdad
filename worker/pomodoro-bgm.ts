/**
 * ポモドーロの休憩中のBGMの切り替え
 *
 * 休憩に入ったら、ポモドーロの設定（worker/pomodoro-config.ts）で選んだ休憩の曲へ切り替え、休憩が明けたら休憩の前の曲へ戻す（issue #208）。
 * 呼ぶのは Workerのタイマー（worker/pomodoro-timer.ts）だけで、休憩の前に何を流していたかはタイマーの状態に預ける。
 *
 * 休憩の曲は繰り返しで流す。繰り返しを切っていると、5分の休憩のあいだに曲が終わって次の曲（作業用の曲）へ進んでしまうためである。
 * 戻すのは「流す曲」と「繰り返すか」だけで、音量とシャッフルは休憩中に配信者が変えたものをそのまま使う（配信者の操作を巻き戻さない）。
 *
 * どちらも切り替えた時刻を記録する。Jev による自動の切り替え（worker/bgm-jev.ts）は切り替えから BGM_SWITCH_COOLDOWN_MS（10分）は
 * 曲を変えないので、5分の休憩のあいだ休憩の曲が Jev に変えられることはない（この関係は pomodoro-bgm.test.ts が確かめる）。
 *
 * 注意: 曲がBGMの一覧から消えていれば、黙って無音にせず投げる。呼び出し側が失敗として記録する。
 */
import type { AlertChannelNamespace } from './alert-channel'
import { loadBgmPlayback, loadBgmTracks, saveBgmPlayback, saveBgmSwitchedAt } from './bgm-config'
import { pushBgmNowPlaying } from './bgm-push'
import type { KeyValueStore } from './store'

/** 休憩の前に流していた曲と、繰り返していたか。休憩が明けたらここへ戻す */
export interface BgmBeforeBreak {
  /** 休憩の前に流していた曲の素材のID。止めていたなら null */
  readonly mediaId: string | null
  readonly repeat: boolean
}

/**
 * 流す曲と繰り返すかを変えて保存し、押し出す。
 *
 * @throws Error 流す曲がBGMの一覧に無い・押し出しに失敗した場合
 */
const switchBgm = async (store: KeyValueStore, alerts: AlertChannelNamespace, mediaId: string | null, repeat: boolean, now: number): Promise<void> => {
  const tracks = await loadBgmTracks(store)
  if (mediaId !== null && !tracks.some((track) => track.mediaId === mediaId)) {
    throw new Error(`素材「${mediaId}」の曲がBGMの一覧にないため、ポモドーロの区切りで曲を切り替えられません`)
  }
  const next = { ...(await loadBgmPlayback(store)), mediaId, repeat }
  await saveBgmPlayback(store, next)
  await saveBgmSwitchedAt(store, now)
  await pushBgmNowPlaying(store, alerts, tracks, next)
}

/**
 * 休憩の曲へ切り替える。
 *
 * @param breakMediaId 休憩の曲の素材のID（ポモドーロの設定で選んだもの）
 * @returns 休憩の前に流していた曲と、繰り返していたか（休憩が明けたら restoreBgmAfterBreak に渡す）
 * @throws Error 休憩の曲がBGMの一覧に無い・押し出しに失敗した場合
 */
export const switchToBreakBgm = async (store: KeyValueStore, alerts: AlertChannelNamespace, breakMediaId: string, now: number): Promise<BgmBeforeBreak> => {
  const { mediaId, repeat } = await loadBgmPlayback(store)
  await switchBgm(store, alerts, breakMediaId, true, now)
  return { mediaId, repeat }
}

/**
 * 休憩の前に流していた曲へ戻す。
 *
 * @throws Error 休憩の前の曲がBGMの一覧から消えている・押し出しに失敗した場合
 */
export const restoreBgmAfterBreak = (store: KeyValueStore, alerts: AlertChannelNamespace, before: BgmBeforeBreak, now: number): Promise<void> =>
  switchBgm(store, alerts, before.mediaId, before.repeat, now)
