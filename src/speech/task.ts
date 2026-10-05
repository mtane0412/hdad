/**
 * チャットの読み上げの起動
 *
 * Twitchのチャットを匿名IRCで受けて、同じPCで動いている VOICEVOX ENGINE（既定 http://localhost:50021）か、
 * さくらのAI Engine（Worker 経由。issue #225）に読み上げさせる。読み上げの単独ページ（speech/reader/index.html）と、裏方をまとめたページ
 * （overlay/backstage/index.html。issue #108）の両方がここを呼ぶ。
 *
 * 読み上げ文の組み立ては text.ts、順番待ちは queue.ts、合成は voicevox.ts（ローカル）か sakura.ts（さくら）、再生は audio.ts にあり、
 * ここはそれらをつなぐだけである。OBSに載せるページの約束どおり React もログインも持ち込まない。
 * チャットの受け取りはチャットボックス（src/chat/）と同じ匿名IRCなので、Twitchのトークンは持たない。
 *
 * 読み上げの設定（話者・速度・音量・長さ・名前を読むか・読み上げない人）は Worker が持ち、
 * オーバーレイ用キーで /api/overlay/speech から読む（issue #86）。以前はすべてURLのクエリに埋めていたが、
 * それだと配信中に音量ひとつ変えるにもURLを貼り替えることになるためである。設定は起動のあとも一定間隔で
 * 読み直し、次に読む1件から反映する（サイドスーパーと同じポーリング。押し出しを使うほどの即時性は要らない）。
 *
 * 下部バーのミュート（issue #238）は、30秒の読み直しを待つと「その場で黙らせる」には遅いので、Worker から WebSocket
 * （/api/overlay/speech/mute/socket）で押し出してもらう。ミュートしたら鳴っている1件を止めて待ちを捨て、ミュート中に届いたコメントは
 * 読まずに捨てる（戻したときに溜まった分を一気に読まない）。起動のときとつなぎ直したときは、保存済みのミュートを設定と一緒に読む。
 *
 * 注意: 合成先・ホスト・ポートだけは起動のときにしか使えない。つなぎ先が変わるとつなぎ直しが要るためで、
 * 変わったことに気づいたらOBSの再読み込みが要ることを画面に出す（黙って古いつなぎ先のまま読み続けない）。
 * 注意: 起動のときの失敗（VOICEVOX が動いていない・設定やチャンネル名が読めない）は投げて呼び出し側に
 * 画面へ出させ、この裏方は止める（Fail-Fast。読み上げが動いていないことに配信中に気づけないため）。
 * 一方、鳴らしている途中の1件の失敗では止めずにその1件を飛ばす。1件のために以降ずっと無音になると、
 * OBSの再読み込みが要るためである。設定の読み直しの失敗も止めず、前に読んだ設定のまま読み上げを続ける。
 */
import { loadChannel } from '../chat/channel'
import { connectChat } from '../chat/connection'
import { showError } from '../core/mount'
import { connectSocket, socketUrl } from '../core/socket'
import { createSpeechOverlayApi, parseSpeechMute, SPEECH_MUTE_SOCKET_HINT, SPEECH_MUTE_SOCKET_PATH, type SpeechSettings } from './api'
import { playSpeech } from './audio'
import { advanceSpeech, EMPTY_SPEECH_QUEUE, enqueueSpeech, type SpeechQueue } from './queue'
import { speechEndpointOf } from './engine'
import { createSakuraSpeech } from './sakura'
import { speechTextOf } from './text'
import { createVoicevox, voicevoxOrigin, type Voicevox } from './voicevox'

/** エラー表示でこの裏方を指す呼び名 */
export const SPEECH_NOUN = 'チャットの読み上げ'

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

export interface SpeechTaskOptions {
  /** オーバーレイ用キー（読み上げの設定を Worker から読むために使う） */
  readonly key: string
  /**
   * 失敗と知らせを出す箱。
   *
   * 単独ページではページ全体（body）、裏方のページではこの裏方の箱を渡す。
   * 1つの裏方の失敗でもう一方を止めないため、出す先を箱に閉じる（合成ページが素材ごとの箱に出すのと同じ）。
   */
  readonly box: HTMLElement
}

/** 読み上げを始めた結果 */
export interface StartedSpeech {
  /** つないだ先の起点。ローカルなら VOICEVOX ENGINE、さくらなら合成を頼む Worker（画面に「どこへつないだか」を出すために返す） */
  readonly origin: string
}

/**
 * 読み上げを始める。
 *
 * @throws 起動に失敗した場合（設定が読めない・VOICEVOX が動いていない・さくらが話者を拒んだ・チャンネル名が読めない）
 */
export const startSpeech = async ({ key, box }: SpeechTaskOptions): Promise<StartedSpeech> => {
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
        showError(RECONNECT_NEEDED, SPEECH_NOUN, box)
      })
      .catch((error: unknown) => {
        // 一時的な通信の失敗で読み上げを止めない。前に読んだ設定のまま続け、原因は記録に残す
        console.error('読み上げの設定を読み込めませんでした', error)
      })
  }, POLL_INTERVAL_MS)

  let queue: SpeechQueue = EMPTY_SPEECH_QUEUE
  /** いま読み上げの処理を回しているか。1件ずつ順に読むため、回っているあいだは新しく始めない */
  let speaking = false
  /** 鳴っている1件を止める合図。ミュートしたときに使う */
  let playback = new AbortController()
  /**
   * ミュートで待ちを捨てた回数。合成や再生を待つあいだに捨てられたかを見分けるために使う
   * （捨てたあとに解除して新しいコメントが並んでいると、待ちを進めたときにその1件を読まずに消してしまうため）
   */
  let discardCount = 0

  /** ミュートを切り替える。ミュートしたら鳴っている1件を止め、待ちを捨てる（戻しても読まない） */
  const applyMute = (next: boolean): void => {
    muted = next
    if (!next) return
    queue = EMPTY_SPEECH_QUEUE
    discardCount += 1
    playback.abort()
  }

  const pump = async (): Promise<void> => {
    if (speaking) return
    speaking = true
    try {
      while (queue.current !== null) {
        const text = queue.current
        const discardsBefore = discardCount
        try {
          // 声と音量は、その1件を鳴らす時点の設定で決める（読み上げの途中で変えても次の1件から効く）
          const audio = await voicevox.synthesize(text, { speaker: settings.speaker, speed: settings.speed })
          // 合成を待つあいだにミュートで捨てられたら鳴らさず、捨てたあとの待ちから続ける
          if (discardCount !== discardsBefore) continue
          playback = new AbortController()
          await playSpeech(audio, settings.volume, playback.signal)
        } catch (error) {
          // 読めなかった1件のために、以降の読み上げを止めない。原因を追えるよう記録だけ残す
          console.error('読み上げできませんでした', text, error)
        }
        // 鳴らしているあいだにミュートで捨てられていたら、待ちはもう空から並び直しているので進めない
        if (discardCount !== discardsBefore) continue
        queue = advanceSpeech(queue)
      }
    } finally {
      speaking = false
    }
  }

  connectSocket(
    socketUrl(SPEECH_MUTE_SOCKET_PATH, { key }),
    {
      onMessage: (text) => {
        try {
          applyMute(parseSpeechMute(text).muted)
        } catch (error) {
          showError(error, SPEECH_NOUN, box)
        }
      },
      onOpen: () => {
        // つながっていない間に切り替えられていても取りこぼさないよう、保存済みのミュートを読み直す
        void api
          .read()
          .then((latest) => applyMute(latest.muted))
          .catch((error: unknown) => {
            // 読み直しに失敗しても読み上げは止めない。次の押し出しで正しい状態に戻る
            console.error('読み上げのミュートを読み直せませんでした', error)
          })
      },
      // 切断と再接続は onOpen で読み直すので、ここでは何もしない
      onStatus: () => undefined,
      onWarning: (message) => showError(new Error(message), SPEECH_NOUN, box),
    },
    SPEECH_MUTE_SOCKET_HINT,
  )

  const { login } = await loadChannel((input, init) => fetch(input, init))
  connectChat(login, {
    onEvent: (event) => {
      // ミュート中に届いたコメントは、戻したあとも読まないので並べない
      if (event.type !== 'message' || muted) return
      // 読むかどうかの判断も、届いた時点の設定で行う（読み上げない人を追加したら次の発言から効く）
      const text = speechTextOf(event.message, {
        readName: settings.readName,
        maxLength: settings.maxLength,
        ignoreLogins: settings.ignoreLogins,
      })
      if (text === null) return
      queue = enqueueSpeech(queue, text)
      void pump()
    },
    // 切断と再接続は読み上げに関係しない（画面も持たないので知らせる先がない）
    onStatus: () => undefined,
  })

  return { origin }
}
