/**
 * ワイプの順番の進め方
 *
 * 届いた発言を1件ずつ順に、アイコン付きでワイプに出す。読み上げているあいだだけ吹き出しを出し、読み終えたら
 * 少し残してから次の1件へ進む。次が無ければすぐには引っ込めず、しばらく残して次の発言を待つ（そのあいだに届けば
 * 引っ込めずに次の人へ替える）。ミュート中は読み上げず、文の長さに応じた時間だけ出す。
 *
 * 合成・再生・DOM・時間待ちはすべて引数で受け取り、ここは「いつ何を出し、いつ読むか」だけを持つ
 * （テストで差し替えるため。つなぐのは src/overlay/stage.ts の mountWipe）。待ちの列は読み上げと同じもの
 * （src/speech/queue.ts。上限を超えたら古いほうから捨てる）を使う。
 *
 * 注意: 1件の失敗（アイコンを引けない・読み上げに失敗した）では止めず、失敗を知らせてその1件だけを飛ばす
 * （読み上げと同じ例外。1件のために以降ずっと何も出なくなると、OBSの再読み込みが要るため）。
 * アイコンを引けなかった1件は出さない。アイコンの欠けたワイプを映すより、失敗を素材の箱に出して気づけるようにする。
 * 注意: モデレーターに消された発言は、出している途中でもすぐ引っ込め（読み終わりの余韻も残さない）、待ちからも外す。
 */
import { advanceSpeech, enqueueSpeech, type SpeechQueue } from '../speech/queue'
import { silentDurationOf, type WipeComment } from './comment'

/** 読み終えてから吹き出しを残しておく時間（ミリ秒）。読み終わりと同時に消えると、最後の言葉を目で追えないため */
export const HOLD_AFTER_SPEECH_MS = 800

/**
 * 次の発言が無いとき、引っ込めずに残しておく時間（ミリ秒）。読み終わりですぐ引っ込めると、ワイプが一瞬しか映らず
 * 誰が言ったのかを見届けられないため
 */
export const LINGER_MS = 6000

/** ワイプに出す1件と、その人のアイコン */
export interface ShownComment {
  readonly comment: WipeComment
  readonly profileImageUrl: string
}

/** 順番の進め方が使うもの。どれもテストで差し替える */
export interface WipeRunnerOptions {
  /** 発言した人のアイコンのURLを引く */
  lookupIcon(login: string): Promise<string>
  /** 1件を読み上げる。鳴らし終えるか、signal で止められたら解決する */
  speak(text: string, signal: AbortSignal): Promise<void>
  /** いまミュートしているか */
  muted(): boolean
  /** 決めた時間だけ待つ。signal で止められたら、待たずに解決する */
  wait(ms: number, signal: AbortSignal): Promise<void>
  /** ワイプに1件を出す（前の1件と入れ替える） */
  show(shown: ShownComment): void
  /** ワイプを引っ込める */
  hide(): void
  /** 1件ぶんの失敗を知らせる */
  onError(error: unknown): void
}

export interface WipeRunner {
  /** 届いた発言を並べる */
  enqueue(comment: WipeComment): void
  /** 当てはまる発言を外す（モデレーターの消去）。出している途中なら、すぐ引っ込める */
  remove(matches: (comment: WipeComment) => boolean): void
  /** 鳴っている1件を止める（ミュート）。吹き出しは読み終えたときと同じく少し残してから次へ進む */
  stopSpeaking(): void
}

/**
 * 決めた時間だけ待つ。signal で止められたら、時間を待たずに解決する（WipeRunnerOptions の wait の本物）。
 */
export const waitOrAbort = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish)
  })

export const createWipeRunner =(options: WipeRunnerOptions): WipeRunner => {
  let queue: SpeechQueue<WipeComment> = { current: null, waiting: [] }
  /** いま順番を回しているか。1件ずつ順に出すため、回っているあいだは新しく始めない */
  let running = false
  /** ワイプに何か出しているか。引っ込める知らせを、出していないときに送らないため */
  let showing = false
  /** 出している1件を引っ込める合図（モデレーターの消去） */
  let presentation = new AbortController()
  /** 鳴っている1件を止める合図（ミュートと消去） */
  let playback = new AbortController()
  /** 次の発言を待って残しているのをやめる合図（次の発言が届いたとき・残している発言が消されたとき） */
  let lingering = new AbortController()
  /** いまワイプに出している発言。出していなければ null（残しているあいだに消されたかを見分けるために持つ） */
  let shown: WipeComment | null = null
  /** ログイン名ごとのアイコンの読み出し。同じ人の発言で何度も引かないために覚えておく */
  const icons = new Map<string, Promise<string>>()

  const iconOf = (login: string): Promise<string> => {
    const cached = icons.get(login)
    if (cached !== undefined) return cached
    const loading = options.lookupIcon(login)
    icons.set(login, loading)
    // 引けなかった人は覚えない（次の発言のときに引き直す）。失敗そのものは出すときに知らせる
    loading.catch(() => {
      if (icons.get(login) === loading) icons.delete(login)
    })
    return loading
  }

  /** 1件を出し、読み終えるまで（ミュート中は決めた時間だけ）待つ */
  const present = async (comment: WipeComment): Promise<void> => {
    const profileImageUrl = await iconOf(comment.login)
    // アイコンを待つあいだに消された発言は出さない
    if (presentation.signal.aborted) return
    options.show({ comment, profileImageUrl })
    showing = true
    shown = comment

    // ミュートかどうかは、その1件を出す時点で決める（途中で切り替えたら次の1件から効く）
    if (options.muted()) {
      await options.wait(silentDurationOf(comment.spoken), presentation.signal)
      return
    }
    playback = new AbortController()
    try {
      await options.speak(comment.spoken, playback.signal)
    } catch (error) {
      options.onError(error)
    }
    // 消された発言は、読み終わりの余韻も残さない
    if (presentation.signal.aborted) return
    await options.wait(HOLD_AFTER_SPEECH_MS, presentation.signal)
  }

  /** ワイプを引っ込め、何も出していない状態にする */
  const hideShown = (): void => {
    options.hide()
    showing = false
    shown = null
  }

  const pump = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      for (;;) {
        // 次が待っていれば引っ込めずにそのまま入れ替える（引っ込めてまた出すと、ワイプがちらつく）
        while (queue.current !== null) {
          presentation = new AbortController()
          try {
            await present(queue.current)
          } catch (error) {
            options.onError(error)
          }
          queue = advanceSpeech(queue)
        }
        if (!showing) return
        // 消された発言は残さない。そうでなければ、しばらく残して次の発言を待つ
        if (!presentation.signal.aborted) {
          lingering = new AbortController()
          await options.wait(LINGER_MS, lingering.signal)
          // 残しているあいだに届いた発言は、引っ込めずにそのまま出す
          if (queue.current !== null) continue
        }
        // 残しているあいだに消されていれば、remove がもう引っ込めている
        if (showing) hideShown()
        return
      }
    } finally {
      running = false
    }
  }

  return {
    enqueue(comment) {
      // 前の1件を読んでいるあいだに、次の人のアイコンを引いておく（出すときに待たせないため）
      void iconOf(comment.login)
      queue = enqueueSpeech(queue, comment)
      // 残しているあいだに届いたら、待たずに次の人へ替える
      lingering.abort()
      void pump()
    },

    remove(matches) {
      queue = { current: queue.current, waiting: queue.waiting.filter((comment) => !matches(comment)) }
      if (queue.current !== null && matches(queue.current)) {
        presentation.abort()
        playback.abort()
      }
      // 出したまま残っている前の発言（読み終えて残している・次の人のアイコンを待っている）が消されたら、
      // 次の人を出すのを待たずにすぐ引っ込める。順番が回っている発言とは別に見る
      if (shown !== null && shown !== queue.current && matches(shown)) {
        lingering.abort()
        hideShown()
      }
    },

    stopSpeaking() {
      playback.abort()
    },
  }
}
