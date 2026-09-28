/**
 * 配信画面の取り込みの起動
 *
 * 同じPCで動いている OBS（obs-websocket。既定 ws://localhost:4455）につなぎ、現在のプログラムシーンを
 * 一定の間隔で1枚撮って Worker へ押し込む。Worker がそれを Gyazo へ上げ、そこで作られるOCRのテキストを
 * あらすじとサイドスーパーの3つ目の材料にする（issue #122）。裏方をまとめたページ
 * （overlay/backstage/index.html）だけがここを呼ぶ。
 *
 * 接続と要求は connection.ts、届いた1件の読み取りは protocol.ts、Worker の呼び出しは api.ts にあり、
 * ここはそれらをつなぐだけである。OBSに載せるページの約束どおり、React もログインも持ち込まない。
 *
 * 撮るのは現在のプログラムシーン1枚だけで、ソースを列挙しない。ゲームだけでなくブラウザや資料のウィンドウも
 * 材料になるうえ、ソース名を設定に持たせずに済む（配信者が入力するものが増えない）。
 *
 * 注意: 起動のときの失敗（設定が読めない・OBSにつながらない）は投げて呼び出し側に画面へ出させ、この裏方は
 * 止める（Fail-Fast。読み上げと同じ扱いで、撮れていないことに配信中に気づけないため）。一方、1回の撮影の
 * 失敗では止めず、次の撮影へ進む。1回のために以降ずっと撮らなくなると、OBSの再読み込みが要るためである。
 * 注意: 接続が切れていたら、次の撮影のときにつなぎ直す。撮影は一定の間隔でしか起きないので、切れているあいだ
 * つなぎ直しを試み続ける必要がない。
 * 注意: ホスト・ポート・パスワードは起動のときにしか使えない。変わったことに気づいたらOBSの再読み込みが
 * 要ることを画面に出す（黙って古いつなぎ先のまま撮り続けない。読み上げと同じ）。撮影の間隔だけは、
 * 読み直すたびに次の1枚から効く。
 */
import { showError } from '../core/mount'
import { createScreenApi, type ScreenSettings } from './api'
import { connectObs, obsSocketUrl, type ObsConnection, type ObsSocketLike } from './connection'
import { imageOfDataUrl } from './protocol'

/** エラー表示でこの裏方を指す呼び名 */
export const SCREEN_NOUN = '配信画面の取り込み'

/**
 * 撮る画像の幅（ピクセル）。高さは元の比率のまま OBS が決める。
 *
 * 1280幅と1920幅の両方でブラウザの本文がOCRで読めることを実測で確かめてあるので、狭いほうを使う
 * （GetSourceScreenshot は obs-websocket が重い要求としているため。issue #122）。
 */
const IMAGE_WIDTH = 1280

/** 撮る形式。PNG は文字の輪郭が崩れないので、OCRの読み取りに向く */
const IMAGE_FORMAT = 'png'

/** つなぎ先が変わったときに画面へ出す文面。取り込みは古いつなぎ先のまま続くので、直し方を添える */
const RECONNECT_NEEDED = new Error(
  'OBSのホスト・ポート・パスワードが変わりました。新しいつなぎ先で撮るには、OBSでこのブラウザソースを再読み込みしてください（それまでは前のつなぎ先のまま撮ります）',
)

export interface ScreenTaskOptions {
  /** オーバーレイ用キー（設定の読み出しと送信に使う） */
  readonly key: string
  /**
   * 失敗と知らせを出す箱。
   *
   * 1つの裏方の失敗でもう一方を止めないため、出す先をこの箱に閉じる（読み上げと同じ）。
   */
  readonly box: HTMLElement
}

/** 取り込みを始めた結果 */
export interface StartedScreen {
  /** つないだ OBS のつなぎ先（画面に「どこへつないだか」を出すために返す） */
  readonly url: string
  /** 起動のときの撮影の間隔（秒） */
  readonly intervalSeconds: number
}

/** つなぎ先が同じかどうか。違えばOBSの再読み込みが要る */
const sameEndpoint = (a: ScreenSettings, b: ScreenSettings): boolean => a.host === b.host && a.port === b.port && a.password === b.password

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 取り込みを始める。
 *
 * @throws 起動に失敗した場合（設定が読めない・OBSにつながらない）
 */
export const startScreen = async ({ key, box }: ScreenTaskOptions): Promise<StartedScreen> => {
  const api = createScreenApi((input, init) => fetch(input, init), key)
  // 1回目は起動の一部として扱う。ここで失敗したら画面に出して原因が分かるようにする
  let settings: ScreenSettings = await api.read()
  /** 起動のときのつなぎ先。以後これと違う設定が届いたら、OBSの再読み込みが要ると知らせる */
  const connectedTo = settings
  const url = obsSocketUrl(settings.host, settings.port)
  const connect = (): Promise<ObsConnection> =>
    connectObs({ url, password: connectedTo.password, createSocket: (target) => new WebSocket(target) as unknown as ObsSocketLike })

  // OBSにつながらないまま配信を始めないよう、撮り始める前に確かめる
  let connection: ObsConnection = await connect()

  /** 撮った結果をその場で読めるように出す。OBSのブラウザソースではコンソールを見られない（中継ページと同じ理由） */
  const status = document.createElement('p')
  status.className = 'screen-status'
  status.setAttribute('role', 'status')
  const notice = document.createElement('pre')
  notice.className = 'screen-notice'
  notice.setAttribute('role', 'alert')
  notice.hidden = true
  box.append(status, notice)

  const setNotice = (message: string | null): void => {
    notice.textContent = message ?? ''
    notice.hidden = message === null
  }

  /** 1枚撮って Worker へ送る */
  const capture = async (): Promise<void> => {
    if (!connection.isOpen()) connection = await connect()

    const scene = await connection.request('GetCurrentProgramScene')
    // OBS 5.5 から sceneName に変わり、それより前は currentProgramSceneName だった。どちらでも撮れるようにする
    const sceneName = scene.sceneName ?? scene.currentProgramSceneName
    if (typeof sceneName !== 'string' || sceneName === '') {
      throw new Error('OBS の応答から、いま映しているシーンの名前を読み取れませんでした')
    }

    const shot = await connection.request('GetSourceScreenshot', {
      sourceName: sceneName,
      imageFormat: IMAGE_FORMAT,
      imageWidth: IMAGE_WIDTH,
    })
    if (typeof shot.imageData !== 'string') throw new Error('OBS の応答に imageData がありません')

    const recorded = await api.send(imageOfDataUrl(shot.imageData))
    const 時刻 = new Date().toLocaleTimeString('ja-JP')
    status.textContent = recorded
      ? `${時刻} に「${sceneName}」を撮りました`
      : `${時刻} に「${sceneName}」を撮りましたが、配信していないので記録されませんでした`
    setNotice(null)
  }

  /** つなぎ先が変わったことを、すでに画面へ出したか。撮るたびに貼り出し続けないための印 */
  let reconnectNoticed = false

  /**
   * 次の撮影を予約する。
   *
   * setInterval ではなく毎回 setTimeout を張り直すのは、撮影の間隔を設定から読み直して次の1枚に効かせるためと、
   * 1枚の撮影が間隔より長くかかったときに撮影が重ならないようにするためである。
   */
  const scheduleNext = (): void => {
    window.setTimeout(() => void tick(), settings.intervalSeconds * 1000)
  }

  const tick = async (): Promise<void> => {
    try {
      // 撮影の間隔を次の1枚に効かせるため、撮るたびに設定を読み直す（撮影は分単位なので、読み直しは負担にならない）
      const latest = await api.read()
      settings = latest
      if (!reconnectNoticed && !sameEndpoint(latest, connectedTo)) {
        reconnectNoticed = true
        showError(RECONNECT_NEEDED, SCREEN_NOUN, box)
      }
    } catch (error) {
      // 一時的な通信の失敗で取り込みを止めない。前に読んだ設定のまま続け、原因は記録に残す
      console.error('画面の取り込みの設定を読み込めませんでした', error)
    }

    try {
      await capture()
    } catch (error) {
      // 1回撮れなかったからといって、以降の撮影を止めない。原因は画面と記録の両方に残す
      setNotice(`画面を撮れませんでした: ${messageOf(error)}`)
      console.error('画面を撮れませんでした', error)
    }

    scheduleNext()
  }

  // 1枚目は起動の直後ではなく、間隔を1つ待ってから撮る（OBSの起動直後の画面を材料にしないため）
  scheduleNext()

  return { url, intervalSeconds: settings.intervalSeconds }
}
