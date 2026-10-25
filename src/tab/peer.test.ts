/**
 * タブの映像を運ぶ接続の送り方の指定のテスト
 *
 * RTCPeerConnection はテストで動かせないので、偽物に差し替え、送り手の接続が映像と音をどう足したか
 * （addTransceiver に渡した指定）を確かめる。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSenderPeer } from './peer'

/** addTransceiver に渡されたものを覚えておく偽物の接続 */
class FakePeerConnection {
  static added: { kind: string; init: RTCRtpTransceiverInit }[] = []
  addTransceiver(track: { kind: string }, init: RTCRtpTransceiverInit): void {
    FakePeerConnection.added.push({ kind: track.kind, init })
  }
  addEventListener(): void {}
}

/** 映像と音のトラックを1本ずつ持つ、取り込んだタブの映像の代わり */
const tabStream = { getTracks: () => [{ kind: 'video' }, { kind: 'audio' }] } as unknown as MediaStream

const handlers = { onConnected: () => {}, onFailed: () => {} }

afterEach(() => {
  FakePeerConnection.added = []
  vi.unstubAllGlobals()
})

describe('openSenderPeer', () => {
  it('映像はビットレートの上限を 8Mbps にして送る（Chrome の既定の 2.5Mbps では 1080p の動画が粗くなる）', () => {
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    openSenderPeer(tabStream, handlers)

    const video = FakePeerConnection.added.find((added) => added.kind === 'video')
    expect(video?.init.sendEncodings).toEqual([{ maxBitrate: 8_000_000 }])
    expect(video?.init.streams).toEqual([tabStream])
  })

  it('音は送り方を指定せず、Chrome の既定のまま送る', () => {
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    openSenderPeer(tabStream, handlers)

    const audio = FakePeerConnection.added.find((added) => added.kind === 'audio')
    expect(audio).toBeDefined()
    expect(audio?.init.sendEncodings).toBeUndefined()
    expect(audio?.init.streams).toEqual([tabStream])
  })
})
