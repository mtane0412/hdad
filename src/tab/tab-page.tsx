/**
 * タブの映像の送り手のページ（/tab/）
 *
 * Chrome のタブ1枚の映像と音を取り込み、合成ページの素材「タブの映像」へ WebRTC で送る（issue #164）。
 * 配信中はこのページを Chrome で開いたままにしておく。映すタブは、映したいタブで拡張（extension/）のショートカットか
 * ボタンを押して決める。拡張は chrome.tabCapture.getMediaStreamId で得たIDを、このページの URL の # に入れて渡すだけで、
 * 取り込みと送信はこのページが配信者のセッションで行う（拡張にログインや鍵を持たせないため）。
 *
 * 映すタブは1枚ずつで、別のタブでショートカットを押すとそのタブに切り替わる。
 * 連絡への応じ方は sender.ts、WebRTC の接続は peer.ts、中継先への接続は socket.ts にあり、ここはそれらをつないで
 * 状態を出すだけにする（テストではどれも偽物に差し替える）。
 *
 * 拡張はこのページからダウンロードさせる（GET /api/admin/tab/extension.zip）。Worker がこの置き場所を信頼する設定を
 * 入れて返すので、配信者が置き場所を書かずに済む（issue #168）。
 *
 * 注意: 取り込んだタブが閉じられたら、エラーにせず「映していません」に戻す。配信中に普通に起こる操作のため。
 * 注意: 拡張から届いたIDは数秒で使えなくなる（#163 で、5秒後は使え、10秒後は失敗した）ので、受け取ったらすぐ取り込む。
 */
import { useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/admin/page-actions'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createTabSender, type SenderPeer, type SenderPeerHandlers } from './sender'
import { readStreamHash, type FromSender, type FromViewer } from './signal'
import type { TabSocket, TabSocketHandlers } from './socket'

/** 取り込んだタブ1枚 */
export interface CapturedTab<S> {
  /** 映像と音 */
  stream: S
  /** 取り込みが終わったとき（タブが閉じられたとき）に呼ぶものを登録する */
  onEnded(listener: () => void): void
  /** 取り込みをやめる */
  stop(): void
}

export interface TabPageProps<S> {
  /** 送り手として中継先へつなぐ */
  connect(handlers: TabSocketHandlers<FromViewer>): TabSocket<FromSender>
  /** 拡張から届いたストリームIDでタブを取り込む */
  capture(streamId: string): Promise<CapturedTab<S>>
  /** 合成ページ1つぶんの WebRTC の接続を作る */
  openPeer(stream: S, handlers: SenderPeerHandlers): SenderPeer
}

/** 拡張の zip。この置き場所を信頼する設定が入る（worker/tab-extension.ts） */
const EXTENSION_ZIP_PATH = '/api/admin/tab/extension.zip'

/** 拡張から受け取った # を、読み終えたら URL から消す（読み込み直したときに、期限の切れたIDで取り込み直さないように） */
const clearHash = (): void => window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)

export const TabPage = <S,>({ connect, capture, openPeer }: TabPageProps<S>) => {
  /** 映しているタブの題名（null は映していない） */
  const [title, setTitle] = useState<string | null>(null)
  const [connectedCount, setConnectedCount] = useState(0)
  const [failure, setFailure] = useState<string | null>(null)
  const [relayLost, setRelayLost] = useState(false)
  /** 「止める」から呼ぶ処理。取り込みと接続は useEffect の中で持つので、そこから渡してもらう */
  const stopRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    let disposed = false
    let current: CapturedTab<S> | null = null
    /** 取り込みの頼みの番号。前の取り込みが遅れて終わっても、新しい頼みを上書きしないために使う */
    let latestRequest = 0
    let socket: TabSocket<FromSender> | null = null

    const sender = createTabSender<S>({
      send: (message) => {
        socket?.send(message)
      },
      // 接続は合成ページの名前によらず同じ作り方なので、名前は渡さない
      openPeer: (_viewerId, stream, handlers) => openPeer(stream, handlers),
      onConnectedCount: setConnectedCount,
      onWarning: setFailure,
    })
    socket = connect({
      onMessage: (message) => sender.receive(message),
      onOpen: () => {
        setRelayLost(false)
        sender.opened()
      },
      onStatus: (status) => setRelayLost(status === 'disconnected'),
      onWarning: setFailure,
    })

    const release = (): void => {
      current?.stop()
      current = null
    }
    const stop = (): void => {
      release()
      sender.stop()
      setTitle(null)
    }
    stopRef.current = stop

    /** URL の # に拡張からのIDがあれば、取り込んで映し始める */
    const takeOver = async (): Promise<void> => {
      let handoff
      try {
        handoff = readStreamHash(window.location.hash)
      } catch (error) {
        clearHash()
        setFailure(errorMessage(error))
        return
      }
      if (handoff === null) return
      clearHash()
      latestRequest += 1
      const request = latestRequest
      try {
        const next = await capture(handoff.streamId)
        if (disposed || request !== latestRequest) {
          next.stop()
          return
        }
        release()
        current = next
        // タブが閉じられたら映すのをやめる（エラーにはしない）
        next.onEnded(() => {
          if (current === next) stop()
        })
        sender.start(next.stream)
        setTitle(handoff.title)
        setFailure(null)
      } catch (error) {
        if (request !== latestRequest) return
        setFailure(`タブを取り込めませんでした: ${errorMessage(error)}（拡張から届いたIDは数秒で使えなくなります。映したいタブでもう一度ショートカットを押してください）`)
      }
    }

    const onHashChange = (): void => {
      void takeOver()
    }
    window.addEventListener('hashchange', onHashChange)
    void takeOver()

    return () => {
      disposed = true
      window.removeEventListener('hashchange', onHashChange)
      release()
      // 合成ページに映すのをやめたことを知らせてから切る（知らせないと、最後の絵が残ったまましばらく固まる）
      sender.stop()
      socket.close()
    }
  }, [connect, capture, openPeer])

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>映しているタブ</CardTitle>
          <CardDescription>このページは配信中ずっと開いたままにしてください。閉じると合成ページには何も映らなくなります。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {title === null ? (
            <p className="text-muted-foreground">映していません</p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Badge>映しています</Badge>
              <strong className="min-w-0 flex-1 truncate">{title}</strong>
              <Button type="button" variant="outline" onClick={() => stopRef.current()}>
                止める
              </Button>
            </div>
          )}
          {title !== null && (
            <p className="text-sm text-muted-foreground">
              {connectedCount > 0
                ? `合成ページ ${connectedCount} か所に映しています`
                : '合成ページとまだつながっていません。OBSに合成ページを読み込み、素材「タブの映像」を置いてください'}
            </p>
          )}
          {relayLost && <p className="text-sm text-muted-foreground">中継先との接続が切れました。つなぎ直しています…</p>}
        </CardContent>
      </Card>
      {failure !== null && (
        <Alert variant="destructive">
          <AlertTitle>うまくいきませんでした</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>拡張を入れる</CardTitle>
          <CardDescription>はじめに一度だけ行います。拡張は、いま開いている HDAD のこのページにだけタブを渡します。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* アプリの外（/api/*）なので Link ではなく普通の a で開く */}
          <a href={EXTENSION_ZIP_PATH} download className={buttonVariants({ variant: 'outline', className: 'self-start' })}>
            拡張をダウンロード
          </a>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>ダウンロードした zip を展開します（hdad-tab というフォルダができます）</li>
            <li>Chrome で chrome://extensions を開き、右上の「デベロッパー モード」を有効にします</li>
            <li>「パッケージ化されていない拡張機能を読み込む」を押し、hdad-tab フォルダを選びます</li>
          </ol>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>映すタブの選び方</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>映したいタブを開きます</li>
            <li>拡張のショートカット（既定は Alt+Shift+T）を押すか、ツールバーの拡張のボタンを押します</li>
            <li>別のタブで同じ操作をすると、そのタブに切り替わります</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  )
}
