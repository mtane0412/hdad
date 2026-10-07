/**
 * 読み上げの声（設定の読み直し・合成先・ミュートの受け取り）
 *
 * 1件の文を合成して鳴らすまでに要るものをまとめる。チャットの読み上げ（task.ts。裏方）と、ワイプの素材
 * （src/overlay/stage.ts の mountWipe）の両方がここを呼び、どの発言をいつ読むかはそれぞれが決める。
 *
 * - 設定（話者・速度・音量・長さ・名前を読むか・読み上げない人）は Worker が持ち、オーバーレイ用キーで /api/overlay/speech から
 *   読む（issue #86）。起動のあとも30秒おきに読み直し、次に読む1件から反映する
 * - 合成は同じPCの VOICEVOX ENGINE か、さくらのAI Engine（Worker 経由。issue #225）に任せる
 * - 下部バーのミュート（issue #238）は、Worker から WebSocket（/api/overlay/speech/mute/socket）で押し出してもらう。
 *   起動のときとつなぎ直したときは、保存済みのミュートを設定と一緒に読む
 *
 * 注意: 合成先・ホスト・ポートだけは起動のときにしか使えない。つなぎ先が変わるとつなぎ直しが要るためで、
 * 変わったことに気づいたらOBSの再読み込みが要ることを画面に出す（黙って古いつなぎ先のまま読み続けない）。
 * 注意: 起動のときの失敗（VOICEVOX が動いていない・設定が読めない）は投げて呼び出し側に画面へ出させる（Fail-Fast）。
 * 設定の読み直しの失敗は止めず、前に読んだ設定のまま続ける。
 */
import { showError } from '../core/mount'
import { connectSocket, socketUrl } from '../core/socket'
import { createSpeechOverlayApi, parseSpeechMute, SPEECH_MUTE_SOCKET_HINT, SPEECH_MUTE_SOCKET_PATH, type SpeechSettings } from './api'
import { playSpeech } from './audio'
import { speechEndpointOf } from './engine'
import { createSakuraSpeech } from './sakura'
import { createVoicevox, voicevoxOrigin, type Voicevox } from './voicevox'

/**
 * 設定を読み直す間隔（ミリ秒）。
 *
 * 配信中に管理画面で音量や話者を変えたとき、これだけ待てば次の1件から効く。
 * サイドスーパーの素材（src/overlay/stage.ts の SIDE_SUPER_INTERVAL_MS）と同じ間隔にしてある。
 */
const POLL_INTERVAL_MS = 30000

/** つなぎ先が変わったときに画面へ出す文面。読み上げは古いつなぎ先のまま続くので、直し方を添える */
const RECONNECT_NEEDED = new Error(
  '読み上げの合成先か、VOICEVOX のホストかポートが変わりました。新しいつなぎ先で読み上げるには、OBSでこのブラウザソースを再読み込みしてください（それまでは前のつなぎ先のまま読み上げます）',
)

export interface SpeechVoiceOptions {
  /** オーバーレイ用キー（読み上げの設定を Worker から読むために使う） */
  readonly key: string
  /** 失敗と知らせを出す箱 */
  readonly box: HTMLElement
  /** エラー表示で、この声を使うもの（裏方・素材）を指す呼び名 */
  readonly noun: string
  /**
   * ミュートを受け取ったときに呼ぶ。押し出しと、つなぎ直したときの読み直しのたびに呼ぶ（同じ値でも呼ぶ）。
   * 鳴っている1件を止めるのは呼び出し側が行う（何を止めるかは使い方で違うため）
   */
  readonly onMute: (muted: boolean) => void
}

export interface SpeechVoice {
  /** いまの設定。30秒おきに読み直したものが入る */
  settings(): SpeechSettings
  /** いまミュートしているか */
  muted(): boolean
  /**
   * 1件を、その時点の設定（話者・速度・音量）で合成して鳴らす。
   * 鳴らし終えるか、signal で止められたら解決する（合成を待つあいだに止められたら鳴らさない）
   *
   * @throws 合成か再生に失敗した場合
   */
  speak(text: string, signal: AbortSignal): Promise<void>
}

/** 声の準備ができた結果 */
export interface StartedSpeechVoice {
  readonly voice: SpeechVoice
  /** つないだ先の起点。ローカルなら VOICEVOX ENGINE、さくらなら合成を頼む Worker */
  readonly origin: string
}

/**
 * 設定を読み、合成先が使えることを確かめてから、設定の読み直しとミュートの受け取りを始める。
 *
 * @throws 起動に失敗した場合（設定が読めない・VOICEVOX が動いていない・さくらが話者を拒んだ）
 */
export const startSpeechVoice = async ({ key, box, noun, onMute }: SpeechVoiceOptions): Promise<StartedSpeechVoice> => {
  const api = createSpeechOverlayApi((input, init) => fetch(input, init), key)
  // 1回目は起動の一部として扱う。ここで失敗したら画面に出して原因が分かるようにする
  const initial = await api.read()
  let settings: SpeechSettings = initial
  /** ミュートしているか。下部バーからの押し出しと、起動・つなぎ直しのときの読み出しだけで変える */
  let muted = initial.muted
  /** 起動のときのつなぎ先。以後これと違う設定が届いたら、OBSの再読み込みが要ると知らせる */
  const connectedTo = speechEndpointOf(settings)
  const origin = settings.engine === 'sakura' ? location.origin : voicevoxOrigin(settings.host, settings.port)

  const voicevox: Voicevox =
    settings.engine === 'sakura'
      ? createSakuraSpeech((input, init) => fetch(input, init), key)
      : createVoicevox((input, init) => fetch(input, init), {
          origin,
          // つながらないとき、ENGINE の設定で許可すべきオリジンとして画面に出すために渡す
          pageOrigin: location.origin,
        })
  // 読み上げ先が動いていない（さくらなら話者が使えない）まま配信を始めないよう、つなぎ始める前に確かめる
  await voicevox.checkReady()

  /** つなぎ先が変わったことを、すでに画面へ出したか。30秒ごとに貼り出し続けないための印 */
  let reconnectNoticed = false
  window.setInterval(() => {
    void api
      .read()
      .then((latest) => {
        // ミュートはここでは変えない。押し出しで切り替えた直後に、KV から古い値を読んで戻してしまわないためである
        settings = latest
        if (reconnectNoticed || speechEndpointOf(latest) === connectedTo) return
        reconnectNoticed = true
        showError(RECONNECT_NEEDED, noun, box)
      })
      .catch((error: unknown) => {
        // 一時的な通信の失敗で読み上げを止めない。前に読んだ設定のまま続け、原因は記録に残す
        console.error('読み上げの設定を読み込めませんでした', error)
      })
  }, POLL_INTERVAL_MS)

  const applyMute = (next: boolean): void => {
    muted = next
    onMute(next)
  }

  /**
   * 押し出されたミュートを受け取った回数。つなぎ直しの読み出しを待つあいだに新しい押し出しが届いたら、
   * 読み出した（古いかもしれない）値でそれを上書きしないために使う
   */
  let notificationCount = 0

  connectSocket(
    socketUrl(SPEECH_MUTE_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          const { muted: next } = parseSpeechMute(text)
          notificationCount += 1
          applyMute(next)
        } catch (error) {
          showError(error, noun, box)
        }
      },
      onOpen: () => {
        // つながっていない間に切り替えられていても取りこぼさないよう、保存済みのミュートを読み直す
        const notificationsBefore = notificationCount
        void api
          .read()
          .then((latest) => {
            // 読み出しを待つあいだに押し出しが届いていたら、そちらが新しいので読み出した値は使わない
            if (notificationCount === notificationsBefore) applyMute(latest.muted)
          })
          .catch((error: unknown) => {
            // 読み直しに失敗しても読み上げは止めない。次の押し出しで正しい状態に戻る
            console.error('読み上げのミュートを読み直せませんでした', error)
          })
      },
      // 切断と再接続は onOpen で読み直すので、ここでは何もしない
      onStatus: () => undefined,
      onWarning: (message) => showError(new Error(message), noun, box),
    },
    SPEECH_MUTE_SOCKET_HINT,
  )

  const voice: SpeechVoice = {
    settings: () => settings,
    muted: () => muted,
    speak: async (text, signal) => {
      // 声と音量は、その1件を鳴らす時点の設定で決める（読み上げの途中で変えても次の1件から効く）
      const { speaker, speed, volume } = settings
      const audio = await voicevox.synthesize(text, { speaker, speed })
      // 合成を待つあいだに止められたら鳴らさない
      if (signal.aborted) return
      await playSpeech(audio, volume, signal)
    },
  }
  return { voice, origin }
}
