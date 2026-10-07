/**
 * チャットの読み上げの起動
 *
 * Twitchのチャットを匿名IRCで受けて、同じPCで動いている VOICEVOX ENGINE（既定 http://localhost:50021）か、
 * さくらのAI Engine（Worker 経由。issue #225）に読み上げさせる。読み上げの単独ページ（speech/reader/index.html）と、裏方をまとめたページ
 * （overlay/backstage/index.html。issue #108）の両方がここを呼ぶ。
 *
 * 読み上げ文の組み立ては text.ts、順番待ちは queue.ts、合成は voicevox.ts（ローカル）か sakura.ts（さくら）、再生は audio.ts にあり、
 * 設定の読み直し・合成先・ミュートの受け取りは voice.ts にあり（ワイプの素材と共有する）、ここはそれらをつなぐだけである。
 * OBSに載せるページの約束どおり React もログインも持ち込まない。
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
 * 注意: 構成にワイプ（素材の種類 wipe）があれば読み上げを始めずに投げる。ワイプが同じチャットを自分で読み上げるので、
 * 両方が動くと同じ発言が二重に読まれるためである（黙って片方を止めず、裏方の読み上げを外すよう画面に出す）。
 */
import { loadChannel } from '../chat/channel'
import { connectChat } from '../chat/connection'
import { createOverlayLayoutApi } from '../overlay/api'
import { wipeOverlayNameOf } from '../wipe/layout'
import { advanceSpeech, EMPTY_SPEECH_QUEUE, enqueueSpeech, type SpeechQueue } from './queue'
import { speechTextOf } from './text'
import { startSpeechVoice } from './voice'

/** エラー表示でこの裏方を指す呼び名 */
export const SPEECH_NOUN = 'チャットの読み上げ'

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
 * @throws 起動に失敗した場合（構成にワイプがある・設定が読めない・VOICEVOX が動いていない・さくらが話者を拒んだ・チャンネル名が読めない）
 */
export const startSpeech = async ({ key, box }: SpeechTaskOptions): Promise<StartedSpeech> => {
  const wipeOverlay = wipeOverlayNameOf(await createOverlayLayoutApi((input, init) => fetch(input, init), key).read())
  if (wipeOverlay !== null) {
    throw new Error(
      `オーバーレイ「${wipeOverlay}」のワイプがチャットを読み上げるので、ここでは読み上げません（同じ発言が二重に読まれるため）。裏方のURLを ?speech=false にするか、ワイプを構成から外してください`,
    )
  }

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

  const { voice, origin } = await startSpeechVoice({
    key,
    box,
    noun: SPEECH_NOUN,
    // ミュートしたら鳴っている1件を止め、待ちを捨てる（戻しても読まない）
    onMute: (muted) => {
      if (!muted) return
      queue = EMPTY_SPEECH_QUEUE
      discardCount += 1
      playback.abort()
    },
  })

  const pump = async (): Promise<void> => {
    if (speaking) return
    speaking = true
    try {
      while (queue.current !== null) {
        const text = queue.current
        const discardsBefore = discardCount
        playback = new AbortController()
        try {
          await voice.speak(text, playback.signal)
        } catch (error) {
          // 読めなかった1件のために、以降の読み上げを止めない。原因を追えるよう記録だけ残す
          console.error('読み上げできませんでした', text, error)
        }
        // 合成か再生を待つあいだにミュートで捨てられていたら、待ちはもう空から並び直しているので進めない
        if (discardCount !== discardsBefore) continue
        queue = advanceSpeech(queue)
      }
    } finally {
      speaking = false
    }
  }

  const { login } = await loadChannel((input, init) => fetch(input, init))
  connectChat(login, {
    onEvent: (event) => {
      // ミュート中に届いたコメントは、戻したあとも読まないので並べない
      if (event.type !== 'message' || voice.muted()) return
      // 読むかどうかの判断も、届いた時点の設定で行う（読み上げない人を追加したら次の発言から効く）
      const settings = voice.settings()
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
