/**
 * 合成ページ（素材 `tab`）の受け手のふるまいのテスト
 *
 * WebRTC の接続そのもの（RTCPeerConnection）はブラウザでしか作れないので、偽物に差し替えて、
 * 連絡への応じ方だけを確かめる。
 * - つながったとき・名乗り直しを頼まれたときに名乗る
 * - 自分あての offer にだけ answer を返し、届いた映像を映す
 * - 送り手が映すのをやめたとき・接続が切れたときは、何も映さない（エラーにしない）
 */
import { describe, expect, it } from 'vitest'
import type { FromViewer } from './signal'
import { createTabReceiver, type ReceiverPeerHandlers } from './receiver'

/** 作られた接続の n 番目（0 から数える）。無ければテストを失敗させる */
const nth = <T>(items: readonly T[], index: number): T => {
  const item = items[index]
  if (item === undefined) throw new Error(`${index + 1}本目の接続が作られていません`)
  return item
}

/** テストで映像の代わりに使う目印 */
type FakeStream = { readonly label: string }

/** 作られた接続を覚えておき、映像の到着や切断をテストから起こせるようにする */
const createHarness = () => {
  const sent: FromViewer[] = []
  const shown: (FakeStream | null)[] = []
  const warnings: string[] = []
  const peers: { offerSdp: string | null; closed: boolean; handlers: ReceiverPeerHandlers<FakeStream> }[] = []
  const receiver = createTabReceiver<FakeStream>({
    viewerId: 'OBSの受け手',
    send: (message) => sent.push(message),
    openPeer: (handlers) => {
      const peer = { offerSdp: null as string | null, closed: false, handlers }
      peers.push(peer)
      return {
        answer: async (offerSdp) => {
          peer.offerSdp = offerSdp
          return `回答（${offerSdp}への）`
        },
        close: () => {
          peer.closed = true
        },
      }
    },
    onStream: (stream) => shown.push(stream),
    onWarning: (message) => warnings.push(message),
  })
  return { receiver, sent, shown, warnings, peers }
}

/** answer を作る非同期の処理が終わるのを待つ */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createTabReceiver', () => {
  it('つながったら名乗る', () => {
    const { receiver, sent } = createHarness()

    receiver.opened()

    expect(sent).toEqual([{ type: 'hello', viewerId: 'OBSの受け手' }])
  })

  it('名乗り直しを頼まれたら名乗る', () => {
    const { receiver, sent } = createHarness()

    receiver.receive({ type: 'who' })

    expect(sent).toEqual([{ type: 'hello', viewerId: 'OBSの受け手' }])
  })

  it('自分あての offer に answer を返す', async () => {
    const { receiver, sent, peers } = createHarness()

    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み1' })
    await settle()

    expect(peers.map((peer) => peer.offerSdp)).toEqual(['申し込み1'])
    expect(sent).toEqual([{ type: 'answer', viewerId: 'OBSの受け手', sdp: '回答（申し込み1への）' }])
  })

  it('ほかの合成ページあての offer には応じない', async () => {
    const { receiver, sent, peers } = createHarness()

    receiver.receive({ type: 'offer', viewerId: '別のシーンの受け手', sdp: '申し込み1' })
    await settle()

    expect(peers).toEqual([])
    expect(sent).toEqual([])
  })

  it('届いた映像を映す', () => {
    const { receiver, shown, peers } = createHarness()

    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み1' })
    nth(peers, 0).handlers.onStream({ label: '資料のタブ' })

    expect(shown).toEqual([{ label: '資料のタブ' }])
  })

  it('映像と音で同じ映像が2回届いても、映すよう知らせるのは1回だけにする', () => {
    // WebRTC は映像と音を別々に届けるが、どちらも同じ映像（stream）を指す。知らせ直すと合成ページが
    // <video> にセットし直し、1回目の再生が「新しい読み込みで中断された」と失敗する
    const { receiver, shown, peers } = createHarness()
    const capturedTab = { label: '資料のタブ' }

    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み1' })
    nth(peers, 0).handlers.onStream(capturedTab)
    nth(peers, 0).handlers.onStream(capturedTab)

    expect(shown).toEqual([capturedTab])
  })

  it('映すのをやめたあとに同じ映像がまた届いたら、映し直す', () => {
    // 止めたことで「何も映していない」に戻るので、同じ映像でも知らせ直す
    const { receiver, shown, peers } = createHarness()
    const capturedTab = { label: '資料のタブ' }
    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み1' })
    nth(peers, 0).handlers.onStream(capturedTab)
    receiver.receive({ type: 'stop' })

    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み2' })
    nth(peers, 1).handlers.onStream(capturedTab)

    expect(shown).toEqual([capturedTab, null, capturedTab])
  })

  it('新しい offer が来たら、前の接続を閉じて作り直す', () => {
    // 送り手が映すタブを切り替えたときに起こる
    const { receiver, peers } = createHarness()

    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み1' })
    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み2' })

    expect(peers.map((peer) => peer.closed)).toEqual([true, false])
  })

  it('閉じた古い接続から映像が届いても映さない', () => {
    const { receiver, shown, peers } = createHarness()

    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み1' })
    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み2' })
    nth(peers, 0).handlers.onStream({ label: '前のタブ' })

    expect(shown).toEqual([])
  })

  it('送り手が映すのをやめたら、接続を閉じて何も映さない', () => {
    const { receiver, shown, peers } = createHarness()
    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み1' })
    nth(peers, 0).handlers.onStream({ label: '資料のタブ' })

    receiver.receive({ type: 'stop' })

    expect(nth(peers, 0).closed).toBe(true)
    expect(shown).toEqual([{ label: '資料のタブ' }, null])
  })

  it('接続が切れたら何も映さない（エラーにはしない）', () => {
    // タブを閉じた・送り手のページを閉じたなど、配信中に普通に起こる
    const { receiver, shown, warnings, peers } = createHarness()
    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み1' })
    nth(peers, 0).handlers.onStream({ label: '資料のタブ' })

    nth(peers, 0).handlers.onClosed()

    expect(shown).toEqual([{ label: '資料のタブ' }, null])
    expect(warnings).toEqual([])
  })

  it('answer を作れなかった接続は閉じる', async () => {
    const closed: boolean[] = []
    const receiver = createTabReceiver<FakeStream>({
      viewerId: 'OBSの受け手',
      send: () => undefined,
      openPeer: () => {
        const index = closed.push(false) - 1
        return {
          answer: async () => {
            throw new Error('接続の経路（ICE）を集め終えられませんでした')
          },
          close: () => {
            closed[index] = true
          },
        }
      },
      onStream: () => undefined,
      onWarning: () => undefined,
    })

    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '申し込み1' })
    await settle()

    expect(closed).toEqual([true])
  })

  it('answer を作れなかったら知らせる', async () => {
    const warnings: string[] = []
    const receiver = createTabReceiver<FakeStream>({
      viewerId: 'OBSの受け手',
      send: () => undefined,
      openPeer: () => ({
        answer: async () => {
          throw new Error('申し込みの形が壊れています')
        },
        close: () => undefined,
      }),
      onStream: () => undefined,
      onWarning: (message) => warnings.push(message),
    })

    receiver.receive({ type: 'offer', viewerId: 'OBSの受け手', sdp: '壊れた申し込み' })
    await settle()

    expect(warnings).toEqual(['タブの映像を受け取れませんでした: 申し込みの形が壊れています'])
  })
})
