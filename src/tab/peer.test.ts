/**
 * タブの映像を運ぶ接続の送り方の指定のテスト
 *
 * RTCPeerConnection そのものはテストで動かせないので、トラックごとの送り方の指定を組み立てる部分だけを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { sendEncodingsFor, VIDEO_MAX_BITRATE } from './peer'

describe('sendEncodingsFor', () => {
  it('映像はビットレートの上限を Chrome の既定の 2.5Mbps より高くする', () => {
    expect(sendEncodingsFor('video')).toEqual([{ maxBitrate: VIDEO_MAX_BITRATE }])
    expect(VIDEO_MAX_BITRATE).toBeGreaterThan(2_500_000)
  })

  it('音は Chrome の既定のまま送る', () => {
    expect(sendEncodingsFor('audio')).toBeUndefined()
  })
})
