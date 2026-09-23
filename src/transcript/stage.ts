/**
 * 文字起こしの中継ページ（transcript/index.html）のエントリスクリプト
 *
 * OBSのブラウザソースに置き、同じPCで動いているゆかコネNEO（ws://localhost:11901/）から音声認識の結果を
 * 受け取る。確定した発話だけを拾い、重複と取り消しを整理する（message.ts）。
 *
 * いまの段階では受け取った内容を画面に出すだけで、Worker へは送らない。OBS内蔵のブラウザから ws:// へ
 * 繋がるか（混在コンテンツを許すか）を先に確かめるためのページだからである（issue #64 の「先に確かめること」）。
 * 繋がることを確かめてから、POST /api/overlay/transcript への送信を足す。
 *
 * 素材ページの約束どおり、React もログインも持ち込まない。
 */
import { showError } from '../core/mount'
import { parseParams, type ParamSchema } from '../core/params'
import { connectTranscript, transcriptSocketUrl } from './connection'
import { EMPTY_TRANSCRIPT_STATE, nextTranscriptState, readTranscriptMessage, type TranscriptState } from './message'
import { createTranscriptView } from './view'

const NOUN = '文字起こしの中継'

const schema = {
  host: {
    type: 'string',
    default: 'localhost',
    // ブラウザが混在コンテンツを許すのはループバックだけなので、そのどちらかしか受け取らない
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

const start = (): void => {
  const root = document.querySelector<HTMLElement>('[data-transcript]')
  if (!root) throw new Error('data-transcript 属性を持つ要素が見つかりません')

  const params = parseParams(schema, new URLSearchParams(location.search))
  const view = createTranscriptView(root)
  const url = transcriptSocketUrl(params.host, params.port)
  view.setStatus(`${url} につないでいます…`, false)

  let state: TranscriptState = EMPTY_TRANSCRIPT_STATE

  connectTranscript(params.host, params.port, {
    onData: (data) => {
      try {
        const { state: next, action } = nextTranscriptState(state, readTranscriptMessage(data))
        state = next
        if (action?.kind === 'send') view.addLine(action.messageId, action.text)
        if (action?.kind === 'remove') view.removeLine(action.messageId)
      } catch (error) {
        // 読めない1件のために中継全体を止めない。画面に知らせたうえで、原因を追えるよう記録する
        view.setNotice(error instanceof Error ? error.message : String(error))
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
