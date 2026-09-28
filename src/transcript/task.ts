/**
 * 文字起こしの中継の起動
 *
 * 同じPCで動いているゆかコネNEO（ws://localhost:11901/）から音声認識の結果を受け取って、確定した発話だけを
 * Worker へ押し込む。あらすじ（issue #65）の材料になる。中継の単独ページ（transcript/relay/index.html）と、
 * 裏方をまとめたページ（overlay/backstage/index.html。issue #108）の両方がここを呼ぶ。
 *
 * 受け取った1件から送る値を作るところは message.ts、Worker の呼び出しは api.ts、画面は view.ts にあり、
 * ここはそれらをつなぐだけである。
 *
 * Worker は配信していないときの発話を捨てるので、配信の前後に開いたままでも構わない（捨てられたことは画面に出す）。
 * OBSに載せるページの約束どおり、React もログインも持ち込まず、オーバーレイ用キーで Worker に受け付けてもらう。
 *
 * 注意: 送信に失敗した発話は覚えているものから外す（forgetTranscript）。ゆかコネNEO は確定した1件を、
 * 表示の残り時間が尽きるまで繰り返し押し出してくるので、外しておけばひとりでに送り直される。
 * 外すのはやり直せる失敗のときだけで（api.ts の isRetryable）、本文やキーの誤りでは外さない。
 */
import { createTranscriptApi, isRetryable } from './api'
import { connectTranscript, transcriptSocketUrl } from './connection'
import { EMPTY_TRANSCRIPT_STATE, forgetTranscript, nextTranscriptState, readTranscriptMessage, type TranscriptState } from './message'
import { createTranscriptView } from './view'

/** エラー表示でこの裏方を指す呼び名 */
export const TRANSCRIPT_NOUN = '文字起こしの中継'

export interface TranscriptTaskOptions {
  /** オーバーレイ用キー（Worker に受け付けてもらうために使う） */
  readonly key: string
  /** ゆかコネNEO が動いているホスト（ループバックだけ） */
  readonly host: string
  /** ゆかコネNEO の WebSocket のポート番号 */
  readonly port: number
  /** 接続の状態と拾えた確定文を出す要素 */
  readonly root: HTMLElement
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 中継を始める。
 *
 * @throws 起動に失敗した場合（つなぎ先のURLを組み立てられないなど）
 */
export const startTranscript = ({ key, host, port, root }: TranscriptTaskOptions): void => {
  const view = createTranscriptView(root)
  const api = createTranscriptApi((input, init) => fetch(input, init), key)
  const url = transcriptSocketUrl(host, port)
  view.setStatus(`${url} につないでいます…`, false)

  let state: TranscriptState = EMPTY_TRANSCRIPT_STATE

  /** 確定した発話を Worker へ送り、結果を画面に出す */
  const send = (messageId: string, text: string): void => {
    view.addLine(messageId, text)
    void api
      .send(messageId, text)
      .then((recorded) => view.setLineState(messageId, recorded ? 'recorded' : 'discarded'))
      .catch((error: unknown) => {
        // 送れなかった1件のために中継を止めない。やり直せる失敗なら覚えているものから外し、
        // ゆかコネNEO が同じ1件を押し出し直したときに送り直す。本文やキーの誤り（4xx）は送り直しても
        // 同じ答えになるので忘れない（忘れると、押し出しのたびに同じ失敗を繰り返す）
        if (isRetryable(error)) state = forgetTranscript(state, messageId)
        view.setLineState(messageId, 'failed')
        view.setNotice(`Workerへ送れませんでした: ${messageOf(error)}`)
      })
  }

  connectTranscript(host, port, {
    onData: (data) => {
      try {
        const { state: next, action } = nextTranscriptState(state, readTranscriptMessage(data))
        state = next
        if (action) send(action.messageId, action.text)
      } catch (error) {
        // 読めない1件のために中継全体を止めない。画面に知らせたうえで、原因を追えるよう記録する
        view.setNotice(messageOf(error))
        console.error('ゆかコネNEO から届いたデータを読み取れませんでした', data, error)
      }
    },
    onStatus: (status) => {
      if (status === 'connected') {
        view.setStatus(`${url} につながっています`, true)
        view.setNotice(null)
      } else {
        view.setStatus(`${url} との接続が切れました。つなぎ直します…`, false)
      }
    },
    onWarning: (message) => view.setNotice(message),
  })
}
