/**
 * 裏方のページ（overlay/backstage/index.html）のエントリスクリプト
 *
 * OBSに置くWebのページのうち、映すものを持たないもの（チャットの読み上げ・文字起こしの中継）を1枚にまとめる
 * （issue #108）。ブラウザソースはその数だけ Chromium のレンダラを立ち上げるので、裏方をそれぞれ別のソースに
 * 置くと配信中のメモリを食う。
 *
 * 合成ページ（overlay/stage/）の素材にはしない。裏方は映すものを持たないので位置も大きさも持たず、素材にすると
 * 構成が持つ rect（位置と大きさ）が意味を失う。また、読み上げの起動の失敗は配信画面の小さな箱の中に出しても
 * 配信者が見ないので、「素材の失敗はその箱の中だけに出す」という約束とも前提が合わない。
 *
 * どの裏方を動かすかは「このブラウザソースが何をするか」という構造の指定なので、合成ページの ?overlay=<名前> と
 * 同じくURLに持たせる（配信中に変える設定ではないため、issue #86 でWorkerへ移した「設定」とは扱いを分ける）。
 * 裏方そのものは src/speech/task.ts・src/transcript/task.ts にあり、単独ページと同じものを呼ぶ。
 *
 * 注意: 1つの裏方の失敗で、もう一方は動かし続ける（合成ページが素材について設けた例外と同じ。
 * 1枚にまとめたせいで、片方の失敗がもう一方まで巻き込むことがないようにする）。失敗はその裏方の箱に出す。
 * 注意: 素材ページの約束どおり、React もログインも持ち込まない。
 */
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { SPEECH_NOUN, startSpeech } from '../speech/task'
import { startTranscript, TRANSCRIPT_NOUN } from '../transcript/task'

/** ページ全体の失敗（キーが無い・動かす裏方が無い）でエラー表示に使う呼び名 */
const NOUN = '裏方'

const schema = {
  key: {
    type: 'string',
    default: '',
    // Workerが発行するキー（worker/secret.ts の randomToken）は、URLにそのまま載せられる文字だけでできている
    pattern: /^[A-Za-z0-9_-]{32,}$/,
    example: '管理用API（/api/me）の overlayKey の値',
    description: 'オーバーレイ用キー（必須）',
  },
  speech: {
    type: 'boolean',
    default: true,
    description: 'チャットの読み上げを動かす（VOICEVOX ENGINE を使う）',
  },
  transcript: {
    type: 'boolean',
    default: true,
    description: '文字起こしの中継を動かす（ゆかコネNEO を使う）',
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

/**
 * 裏方1つの箱をページに足し、その中身を入れる要素を返す。
 *
 * 見出しを添えるのは、どちらの裏方の表示なのかを一目で分かるようにするためである
 * （片方が失敗しているとき、どちらが失敗しているのか分からないと直しようがない）。
 */
const addTaskBox = (root: HTMLElement, title: string): HTMLElement => {
  const section = document.createElement('section')
  section.className = 'backstage-task'

  const heading = document.createElement('h1')
  heading.className = 'backstage-task-title'
  heading.textContent = title

  const body = document.createElement('div')
  body.className = 'backstage-task-body'

  section.append(heading, body)
  root.append(section)
  return body
}

/** 裏方が動き出したことを、その箱に1行で出す */
const showStatus = (box: HTMLElement, text: string): void => {
  const status = document.createElement('p')
  status.className = 'backstage-status'
  status.setAttribute('role', 'status')
  status.textContent = text
  box.append(status)
}

const start = async (): Promise<void> => {
  const root = document.querySelector<HTMLElement>('[data-backstage]')
  if (!root) throw new Error('data-backstage 属性を持つ要素が見つかりません')

  const params = parseParams(schema, new URLSearchParams(location.search))
  if (params.key === '') {
    throw new ParamError(['key: オーバーレイ用キーを指定してください（例: ?key=<キー>）'])
  }
  if (!params.speech && !params.transcript) {
    throw new ParamError(['speech・transcript: 動かす裏方がありません（どちらかを true にしてください）'])
  }

  // 文字起こしの中継を先に始める。つなぎ始めるまで待つものが無く、読み上げの起動（Workerと VOICEVOX への
  // 問い合わせ）を待たせずに済むためである
  if (params.transcript) {
    const box = addTaskBox(root, TRANSCRIPT_NOUN)
    try {
      startTranscript({ key: params.key, host: params.host, port: params.port, root: box })
    } catch (error) {
      // 1つの裏方の失敗で、もう一方を止めない
      showError(error, TRANSCRIPT_NOUN, box)
    }
  }

  if (params.speech) {
    const box = addTaskBox(root, SPEECH_NOUN)
    await startSpeech({ key: params.key, box })
      .then(({ origin }) => showStatus(box, `${origin} につながっています。チャットを読み上げます`))
      .catch((error: unknown) => showError(error, SPEECH_NOUN, box))
  }
}

// 読み上げの起動が Worker と VOICEVOX を待つため、起動は非同期になる。
// ページ全体の失敗（キーが無い・動かす裏方が無い）はページ全体に出す
start().catch((error: unknown) => {
  showError(error, NOUN)
  throw error
})
