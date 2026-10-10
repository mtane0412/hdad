/**
 * 裏方のページの「配信の停止」（issue #302）
 *
 * 漢字クイズが時間切れになり、猶予のあいだに取り消されなかったら、Worker が配信を止める命令を WebSocket（STOP_SOCKET_PATH）で押し出す。
 * 受け取ったら、同じPCで動いている OBS（obs-websocket）へ StopStream を送り、止められたか（止められなければその理由）を Worker へ知らせる
 * （POST /api/overlay/kanji-quiz/stop/result）。Twitch の API には配信を終わらせる手段が無いので、OBS から止める。
 * 裏方をまとめたページ（overlay/backstage/ の ?stop=true）だけがここを呼ぶ。
 *
 * OBS のつなぎ先は、画面の取り込みと同じ設定（GET /api/overlay/screen のホスト・ポート・パスワード）を使い、接続は src/screen/connection.ts に任せる。
 *
 * 注意: 起動のときに OBS につながらなければ投げて、呼び出し側に画面へ出させる（Fail-Fast。止める命令が届いてから初めて気づくのでは遅い）。
 * 注意: 命令が届いたときに接続が切れていたら、つなぎ直してから送る。止められなかったら黙らず理由を Worker へ知らせ、失敗の記録に残させる。
 * 注意: OBSに載せるページの約束どおり、React もログインも持ち込まない。
 */
import { showError } from '../core/mount'
import { connectSocket, socketUrl } from '../core/socket'
import { createScreenApi } from '../screen/api'
import { connectObs, obsSocketUrl, type ObsConnection, type ObsSocketLike } from '../screen/connection'
import { STOP_SOCKET_HINT, STOP_SOCKET_PATH, createKanjiQuizApi } from './api'
import { parseStreamStopOrder } from './call'

/** エラー表示でこの裏方を指す呼び名 */
export const STOP_NOUN = '配信の停止'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 1回ぶんの停止に使うもの。テストで差し替えるため、OBS への接続と Worker への知らせを受け取る */
export interface StreamStopDeps {
  /** いまの OBS への接続 */
  current(): ObsConnection
  /** OBS へつなぎ直し、新しい接続を返す */
  reconnect(): Promise<ObsConnection>
  /** 止められたかを Worker へ知らせる（止められたら error は null） */
  reportStop(quizId: string, error: string | null): Promise<void>
}

/**
 * OBS へ StopStream を送り、結果を Worker へ知らせる。
 *
 * @returns 止められなかった理由。止められたら null
 * @throws Worker へ知らせられなかった場合
 */
export const executeStreamStop = async ({ current, reconnect, reportStop }: StreamStopDeps, quizId: string): Promise<string | null> => {
  let error: string | null = null
  try {
    const connection = current().isOpen() ? current() : await reconnect()
    await connection.request('StopStream')
  } catch (stopError) {
    error = messageOf(stopError)
  }
  await reportStop(quizId, error)
  return error
}

export interface StreamStopTaskOptions {
  /** オーバーレイ用キー（OBS の設定の読み出し・命令の受け取り・結果の知らせに使う） */
  readonly key: string
  /** 失敗と知らせを出す箱（ほかの裏方を巻き込まないよう、出す先をこの箱に閉じる） */
  readonly box: HTMLElement
}

/**
 * 配信の停止を始める。命令の受け取りは、つながりしだい始まる（つなぎ直しは src/core/socket.ts が続ける）。
 *
 * @returns つないだ OBS のつなぎ先（画面に「どこへつないだか」を出すために返す）
 * @throws 起動に失敗した場合（設定が読めない・OBSにつながらない）
 */
export const startStreamStop = async ({ key, box }: StreamStopTaskOptions): Promise<{ readonly url: string }> => {
  const settings = await createScreenApi((input, init) => fetch(input, init), key).read()
  const url = obsSocketUrl(settings.host, settings.port)
  const connect = (): Promise<ObsConnection> =>
    connectObs({ url, password: settings.password, createSocket: (target) => new WebSocket(target) as unknown as ObsSocketLike })
  // 命令が届いてから初めて気づかないよう、起動のときにつないでおく
  let connection = await connect()
  const api = createKanjiQuizApi((input, init) => fetch(input, init), key)

  /** 止めた結果をその場で読めるように出す。OBSのブラウザソースではコンソールを見られない（画面の取り込みと同じ理由） */
  const status = document.createElement('p')
  status.className = 'backstage-status'
  status.setAttribute('role', 'status')
  box.append(status)

  const deps: StreamStopDeps = {
    current: () => connection,
    reconnect: async () => {
      connection = await connect()
      return connection
    },
    reportStop: (quizId, error) => api.reportStop(quizId, error),
  }

  const stop = async (text: string): Promise<void> => {
    const { quizId } = parseStreamStopOrder(text)
    const error = await executeStreamStop(deps, quizId)
    const time = new Date().toLocaleTimeString('ja-JP')
    if (error === null) status.textContent = `${time} に漢字クイズの時間切れで配信を止めました`
    else showError(new Error(`${time} に配信を止められませんでした: ${error}`), STOP_NOUN, box)
  }

  connectSocket(
    socketUrl(STOP_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        // 読めない命令・結果を知らせられなかったときは、箱に出す（止まらなかったことに配信者が気づけるように）
        stop(text).catch((error: unknown) => showError(error, STOP_NOUN, box))
      },
      onStatus: () => {
        // 切断・再接続は出さない。つなぎ直しは続き、命令は Worker が「受け取る裏方がいない」として記録する
      },
      onWarning: (message) => showError(new Error(message), STOP_NOUN, box),
    },
    STOP_SOCKET_HINT,
  )

  return { url }
}
