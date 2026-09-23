/**
 * 文字起こしの中継ページ（transcript/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースに置き、同じPCで動いているゆかコネNEO（ws://localhost:11901/）から音声認識の結果を
 * 受け取って、確定した発話だけを Worker へ押し込む。あらすじ（issue #65）の材料になる。
 *
 * 受け取った1件から送る値を作るところは message.ts、Worker の呼び出しは api.ts、画面は view.ts にあり、
 * ここはそれらをつなぐだけである。
 *
 * Worker は配信していないときの発話を捨てるので、配信の前後に開いたままでも構わない（捨てられたことは画面に出す）。
 * 素材ページの約束どおり、React もログインも持ち込まず、オーバーレイ用キー（?key=）で Worker に受け付けてもらう。
 *
 * 注意: 送信に失敗した発話は覚えているものから外す（forgetTranscript）。ゆかコネNEO は確定した1件を、
 * 表示の残り時間が尽きるまで繰り返し押し出してくるので、外しておけばひとりでに送り直される。
 */
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { createTranscriptApi } from './api'
import { connectTranscript, transcriptSocketUrl } from './connection'
import { EMPTY_TRANSCRIPT_STATE, forgetTranscript, nextTranscriptState, readTranscriptMessage, type TranscriptState } from './message'
import { createTranscriptView } from './view'

const NOUN = '文字起こしの中継'

const schema = {
  key: {
    type: 'string',
    default: '',
    // Workerが発行するキー（worker/secret.ts の randomToken）は、URLにそのまま載せられる文字だけでできている
    pattern: /^[A-Za-z0-9_-]{32,}$/,
    example: '管理用API（/api/me）の overlayKey の値',
    description: 'オーバーレイ用キー（必須）',
  },
  host: {
    type: 'string',
    default: 'localhost',
    // ブラウザが ws:// への接続（混在コンテンツ）を許すのはループバックだけなので、そのどちらかしか受け取らない
    pattern: /^(?:localhost|127\.0\.0\.1)$/,
    example: 'localhost または 127.0.0.1',
    description: 'ゆかコネNEO が動いているホスト（OBSと同じPCなので localhost のまま使う）',
  },
  port: {
    type: 'number',
    default: 11901,
    min: 1,
    max: 65535,
    integer: true,
    description: 'ゆかコネNEO の WebSocket のポート番号（レジストリ HKCU\\Software\\YukarinetteConnectorNeo\\WebSocket の値。既定は 11901）',
  },
} as const satisfies ParamSchema

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const start = (): void => {
  const root = document.querySelector<HTMLElement>('[data-transcript]')
  if (!root) throw new Error('data-transcript 属性を持つ要素が見つかりません')

  const params = parseParams(schema, new URLSearchParams(location.search))
  if (params.key === '') {
    throw new ParamError(['key: オーバーレイ用キーを指定してください（例: ?key=<キー>）'])
  }

  const view = createTranscriptView(root)
  const api = createTranscriptApi((input, init) => fetch(input, init), params.key)
  const url = transcriptSocketUrl(params.host, params.port)
  view.setStatus(`${url} につないでいます…`, false)

  let state: TranscriptState = EMPTY_TRANSCRIPT_STATE

  /** 確定した発話を Worker へ送り、結果を画面に出す */
  const send = (messageId: string, text: string): void => {
    view.addLine(messageId, text)
    void api
      .send(messageId, text)
      .then((recorded) => view.setLineState(messageId, recorded ? 'recorded' : 'discarded'))
      .catch((error: unknown) => {
        // 送れなかった1件のために中継を止めない。覚えているものから外し、次に同じ1件が届いたら送り直す
        state = forgetTranscript(state, messageId)
        view.setLineState(messageId, 'failed')
        view.setNotice(`Workerへ送れませんでした: ${messageOf(error)}`)
      })
  }

  /** ゆかコネNEO があとから取り消した発話を、Worker からも消す */
  const remove = (messageId: string): void => {
    view.setLineState(messageId, 'deleted')
    void api.remove(messageId).catch((error: unknown) => {
      view.setNotice(`Workerから取り消せませんでした: ${messageOf(error)}`)
    })
  }

  connectTranscript(params.host, params.port, {
    onData: (data) => {
      try {
        const { state: next, action } = nextTranscriptState(state, readTranscriptMessage(data))
        state = next
        if (action?.kind === 'send') send(action.messageId, action.text)
        if (action?.kind === 'remove') remove(action.messageId)
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

try {
  start()
} catch (error) {
  showError(error, NOUN)
  throw error
}
