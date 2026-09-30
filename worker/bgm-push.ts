/**
 * BGMの「いま流している曲」の押し出し
 *
 * 流す曲や音量が変わったら、裏方のページ（overlay/backstage/ の ?bgm=true）と合成ページの素材「再生中の曲」へ
 * アラートの配送先（worker/alert-channel.ts）を通して押し出す。管理画面からの切り替え（worker/bgm-routes.ts）と、
 * Jev による切り替え（worker/bgm-jev.ts）の両方が使う。
 *
 * 注意: 失敗は投げる。呼び出し側が管理画面へ返すか、収集の失敗として記録する。
 */
import { pushBgm, type AlertChannelNamespace } from './alert-channel'
import { nowPlayingOf, type BgmPlayback, type BgmTrack } from './bgm-config'
import { loadOverlayKey } from './overlay-key'
import type { KeyValueStore } from './store'

/**
 * いま流している曲を押し出す。
 *
 * @throws Error オーバーレイ用キーが未発行・流す曲が一覧に無い・押し出しに失敗した場合
 */
export const pushBgmNowPlaying = async (
  store: KeyValueStore,
  alerts: AlertChannelNamespace,
  tracks: readonly BgmTrack[],
  playback: BgmPlayback,
): Promise<void> => {
  const overlayKey = await loadOverlayKey(store)
  // キーはログインのときに発行されるので、BGMを流せている以上は必ずある。無ければ壊れているので黙らない
  if (overlayKey === null) throw new Error('オーバーレイ用キーが未発行のため、BGMの音声のURLを作れません')
  await pushBgm(alerts, nowPlayingOf(tracks, playback, overlayKey))
}
