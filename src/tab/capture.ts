/**
 * Chrome のタブ1枚の取り込み
 *
 * 拡張（extension/）が chrome.tabCapture.getMediaStreamId で得たIDを getUserMedia に渡し、そのタブの映像と音を取る。
 * IDは取り込む側（consumerTabId）にこのページのタブを指定して発行されているので、ほかのページでは使えない。
 *
 * 映像は 1920×1080・30fps までに抑える（合成ページの推奨の大きさが配信画面と同じ 1920×1080 のため。
 * #163 の試作でこの条件の負荷と遅延を確かめてある）。
 *
 * 注意: 取り込んでいるあいだ、元のタブの音は Chrome からは聞こえなくなる（#163 で確かめた）。配信者は OBS のモニターで聞く。
 */
import type { CapturedTab } from './tab-page'

/** 取り込む映像の上限 */
const MAX_WIDTH = 1920
const MAX_HEIGHT = 1080
const MAX_FRAME_RATE = 30

/**
 * Chrome だけが受け付けるタブの取り込みの指定。標準の型に無いので、標準の型を広げて書く
 * （Chrome は mandatory の中の chromeMediaSource・chromeMediaSourceId を読む）
 */
interface ChromeTabConstraints extends MediaTrackConstraints {
  mandatory: Record<string, string | number>
}

interface ChromeTabStreamConstraints extends MediaStreamConstraints {
  audio: ChromeTabConstraints
  video: ChromeTabConstraints
}

/**
 * 拡張から届いたIDでタブを取り込む。
 *
 * @throws IDの期限が切れている（数秒で使えなくなる）・タブが閉じられている場合など
 */
export const captureTab = async (streamId: string): Promise<CapturedTab<MediaStream>> => {
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
  const constraints: ChromeTabStreamConstraints = {
    audio: { mandatory: source },
    video: { mandatory: { ...source, maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT, maxFrameRate: MAX_FRAME_RATE } },
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  return {
    stream,
    // タブが閉じられると映像のトラックが終わる
    onEnded: (listener) => {
      for (const track of stream.getVideoTracks()) track.addEventListener('ended', listener, { once: true })
    },
    stop: () => {
      for (const track of stream.getTracks()) track.stop()
    },
  }
}
