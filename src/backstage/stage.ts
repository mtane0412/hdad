/**
 * 裏方のページ（overlay/backstage/index.html）のエントリスクリプト
 *
 * OBSに置くWebのページのうち、映すものを持たないもの（チャットの読み上げ・配信画面の取り込み・BGM）を1枚にまとめる
 * （issue #108）。ブラウザソースはその数だけ Chromium のレンダラを立ち上げるので、裏方をそれぞれ別のソースに
 * 置くと配信中のメモリを食う。
 *
 * 合成ページ（overlay/stage/）の素材にはしない。裏方は映すものを持たないので位置も大きさも持たず、素材にすると
 * 構成が持つ rect（位置と大きさ）が意味を失う。また、読み上げの起動の失敗は配信画面の小さな箱の中に出しても
 * 配信者が見ないので、「素材の失敗はその箱の中だけに出す」という約束とも前提が合わない。
 *
 * どの裏方を動かすかは「このブラウザソースが何をするか」という構造の指定なので、合成ページの ?overlay=<名前> と
 * 同じくURLに持たせる（配信中に変える設定ではないため、issue #86 でWorkerへ移した「設定」とは扱いを分ける）。
 * 裏方そのものは src/speech/task.ts・src/screen/task.ts・src/bgm/task.ts にあり、単独ページを持つものは
 * そのページと同じものを呼ぶ。
 *
 * 注意: 1つの裏方の失敗で、もう一方は動かし続ける（合成ページが素材について設けた例外と同じ。
 * 1枚にまとめたせいで、片方の失敗がもう一方まで巻き込むことがないようにする）。失敗はその裏方の箱に出す。
 * 注意: OBSに載せるページの約束どおり、React もログインも持ち込まない。
 */
import { BGM_NOUN, startBgm } from '../bgm/task'
import { showError } from '../core/mount'
import { ParamError, parseParams, type ParamSchema } from '../core/params'
import { SCREEN_NOUN, startScreen } from '../screen/task'
import { SPEECH_NOUN, startSpeech } from '../speech/task'

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
  screen: {
    type: 'boolean',
    // 既定では動かさない。OBSのWebSocketサーバーと Gyazo のアクセストークンの両方が要るので、
    // 何も用意していない配信者のブラウザソースが起動のたびに失敗を出さないようにする
    default: false,
    description: '配信画面の取り込みを動かす（OBS の obs-websocket を使う）',
  },
  bgm: {
    type: 'boolean',
    // 既定では鳴らさない。OBSに貼ってある裏方のブラウザソースが、曲を選んだ途端に黙って鳴り出さないようにする
    default: false,
    description: 'BGMを鳴らす（流す曲と音量は管理画面の「BGM」で選ぶ）',
  },
} as const satisfies ParamSchema

/**
 * 裏方1つの箱をページに追加し、その中身を入れる要素を返す。
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
  if (!params.speech && !params.screen && !params.bgm) {
    throw new ParamError(['speech・screen・bgm: 動かす裏方がありません（どれかを true にしてください）'])
  }

  // BGMは待つものが無いので、読み上げの起動より先に始める（読み上げが VOICEVOX を待つあいだに鳴り始められる）
  if (params.bgm) {
    const box = addTaskBox(root, BGM_NOUN)
    startBgm({ key: params.key, box }).catch((error: unknown) => showError(error, BGM_NOUN, box))
  }

  if (params.speech) {
    const box = addTaskBox(root, SPEECH_NOUN)
    await startSpeech({ key: params.key, box })
      .then(({ origin }) => showStatus(box, `${origin} につながっています。チャットを読み上げます`))
      .catch((error: unknown) => showError(error, SPEECH_NOUN, box))
  }

  if (params.screen) {
    const box = addTaskBox(root, SCREEN_NOUN)
    await startScreen({ key: params.key, box })
      .then(({ url, intervalSeconds }) => showStatus(box, `${url} につながっています。${intervalSeconds}秒ごとに画面を撮ります`))
      .catch((error: unknown) => showError(error, SCREEN_NOUN, box))
  }
}

// 読み上げの起動が Worker と VOICEVOX を待つため、起動は非同期になる。
// ページ全体の失敗（キーが無い・動かす裏方が無い）はページ全体に出す
start().catch((error: unknown) => {
  showError(error, NOUN)
  throw error
})
