/**
 * タブの映像を運ぶ WebRTC の接続（RTCPeerConnection）
 *
 * 送り手（sender.ts）と受け手（receiver.ts）のふるまいが使う接続1本を、ブラウザの RTCPeerConnection で作る。
 * ふるまいの側は接続を差し替えてテストするので、ここはブラウザの API をそのまま呼ぶ薄い部分だけにする。
 *
 * - 映像は H.264 を優先する（#163 の試作で、Chrome の既定の VP8 はソフトウェアで符号化されて送り手のページだけで
 *   CPU を 72% 使い、遅延は約 97ms だった。H.264 は Mac のハードウェア符号化（VideoToolbox）に回り、8%・約 28〜52ms）
 * - ICE の候補は集め終えてから SDP にまとめて送る（同じPCの中でつなぐので、STUN も TURN も使わず、すぐに集まる）
 *
 * 注意: H.264 で送れないブラウザでは、VP8 へ黙って切り替えずに失敗させる（Fail-Fast）。負荷と遅延が大きく変わるため。
 */
import type { ReceiverPeer, ReceiverPeerHandlers } from './receiver'
import type { SenderPeer, SenderPeerHandlers } from './sender'

/** ICE の候補を集め終えるまで待つ上限（ミリ秒）。同じPCの中なら一瞬で集まるので、待ち続けるのは異常と見なす */
const ICE_GATHERING_TIMEOUT_MS = 5000

/** ICE の候補を集め終えるまで待ち、候補を含んだ SDP を返す */
const gatheredSdp = (pc: RTCPeerConnection): Promise<string> =>
  new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      const sdp = pc.localDescription?.sdp
      if (sdp === undefined) reject(new Error('接続の申し込みを作れませんでした'))
      else resolve(sdp)
    }
    const check = (): void => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check)
      reject(new Error('接続の経路（ICE）を集め終えられませんでした'))
    }, ICE_GATHERING_TIMEOUT_MS)
    pc.addEventListener('icegatheringstatechange', check)
    check()
  })

/**
 * 映像の送り先で H.264 を先頭に並べ、合成ページとの交渉で選ばれるようにする。
 *
 * @throws このブラウザが H.264 で送れない場合
 */
const preferH264 = (pc: RTCPeerConnection): void => {
  const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? []
  const h264 = codecs.filter((codec) => codec.mimeType === 'video/H264')
  if (h264.length === 0) throw new Error('このブラウザは映像を H.264 で送れません')
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.sender.track?.kind !== 'video') continue
    transceiver.setCodecPreferences([...h264, ...codecs.filter((codec) => codec.mimeType !== 'video/H264')])
  }
}

/** 送り手の接続を1本作る（合成ページ1つぶん） */
export const openSenderPeer = (stream: MediaStream, handlers: SenderPeerHandlers): SenderPeer => {
  const pc = new RTCPeerConnection()
  for (const track of stream.getTracks()) pc.addTrack(track, stream)
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') handlers.onConnected()
    if (pc.connectionState === 'failed') handlers.onFailed()
  })
  return {
    offer: async () => {
      preferH264(pc)
      await pc.setLocalDescription(await pc.createOffer())
      return gatheredSdp(pc)
    },
    accept: (answerSdp) => pc.setRemoteDescription({ type: 'answer', sdp: answerSdp }),
    // 映像そのもの（stream）は他の合成ページへの接続とも共有しているので、ここでは止めない
    close: () => pc.close(),
  }
}

/** 受け手の接続を1本作る */
export const openReceiverPeer = (handlers: ReceiverPeerHandlers<MediaStream>): ReceiverPeer => {
  const pc = new RTCPeerConnection()
  pc.addEventListener('track', (event) => {
    // 映像と音は同じ stream に入って別々に届くので、ここは届くたびに知らせる。同じ stream を2回知らせても
    // 映し直させないのは受け手のふるまい（receiver.ts）の役目である（映し直すと再生が中断される）
    const [stream] = event.streams
    if (stream !== undefined) handlers.onStream(stream)
  })
  pc.addEventListener('connectionstatechange', () => {
    // disconnected は戻ることがあるので待ち、戻らないと決まった failed で閉じる
    if (pc.connectionState === 'failed') handlers.onClosed()
  })
  return {
    answer: async (offerSdp) => {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
      await pc.setLocalDescription(await pc.createAnswer())
      return gatheredSdp(pc)
    },
    close: () => pc.close(),
  }
}
