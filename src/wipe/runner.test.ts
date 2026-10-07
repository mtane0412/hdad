/**
 * ワイプの順番の進め方（runner.ts）のテスト
 *
 * 合成も再生もDOMも持ち込まず、読み上げ・待ち時間・表示を差し替えて「いつ何を出し、いつ読むか」だけを確かめる。
 * 特に重要なのは次の点。
 * - 1件ずつ順に出し、読み上げているあいだだけ吹き出しを出すこと（読み終えたら少し残してから次へ）
 * - ミュート中は読まず、文の長さに応じた時間だけ出して次へ進むこと
 * - 次の発言が無ければ、引っ込めずにしばらく残し、そのあいだに届いた発言へはそのまま替えること
 * - アイコンを引けなかった1件は、失敗を知らせて飛ばし、以降を止めないこと
 * - モデレーターに消された発言は、出している途中でも引っ込め、待ちからも外すこと
 */
import { describe, expect, it, vi } from 'vitest'
import { silentDurationOf, type WipeComment } from './comment'
import { HOLD_AFTER_SPEECH_MS, LINGER_MS, createWipeRunner, waitOrAbort, type ShownComment } from './runner'

/** 前提: たねのぶさんの「こんにちは」 */
const greeting: WipeComment = {
  messageId: 'メッセージID-1',
  login: 'tanenob',
  displayName: 'たねのぶ',
  fragments: [{ type: 'text', text: 'こんにちは' }],
  spoken: 'こんにちは',
}

/** 前提: こわいはなしさんの「今から怖い話をするね」 */
const scaryTalk: WipeComment = {
  messageId: 'メッセージID-2',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  fragments: [{ type: 'text', text: '今から怖い話をするね' }],
  spoken: '今から怖い話をするね',
}

const iconOf = (login: string): string => `https://static-cdn.jtvnw.net/jtv_user_pictures/${login}-profile_image-300x300.png`

/** 待っている非同期の処理（アイコンの読み出し・読み上げの続き）を進める */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 読み上げを差し替える。読み終わりはテストが finish で決める */
const createFakeSpeech = () => {
  const spoken: { text: string; signal: AbortSignal; finish: () => void }[] = []
  const speak = (text: string, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      spoken.push({ text, signal, finish: resolve })
      // 止められたら、本物（src/speech/audio.ts の playSpeech）と同じく失敗にせず終える
      signal.addEventListener('abort', () => resolve())
    })
  return { spoken, speak }
}

/**
 * 前提の組み立て。
 * keepLingering を true にすると、次の発言を待って残す時間（LINGER_MS）の待ちだけは、止める合図が来るまで終わらない
 * （残しているあいだに起きることを確かめるため）。それ以外の待ちは長さだけ記録してすぐ進める
 */
const setup = (
  options: { muted?: boolean; failingLogins?: readonly string[]; keepLingering?: boolean; pendingIconLogins?: readonly string[] } = {},
) => {
  /** アイコンを引き終えるのをテストが決める人の、引き終える処理（pendingIconLogins に挙げた人だけ） */
  const iconResolvers = new Map<string, () => void>()
  const speech = createFakeSpeech()
  const events: string[] = []
  const shown: ShownComment[] = []
  const waits: number[] = []
  const errors: unknown[] = []
  const iconLookups: string[] = []
  const runner = createWipeRunner({
    lookupIcon: async (login) => {
      iconLookups.push(login)
      if (options.failingLogins?.includes(login)) throw new Error(`${login} のアイコンを引けませんでした`)
      if (options.pendingIconLogins?.includes(login)) {
        await new Promise<void>((resolve) => iconResolvers.set(login, resolve))
      }
      return iconOf(login)
    },
    speak: speech.speak,
    muted: () => options.muted ?? false,
    wait: (ms, signal) => {
      waits.push(ms)
      if (!(options.keepLingering === true && ms === LINGER_MS)) return Promise.resolve()
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve()))
    },
    show: (comment) => {
      shown.push(comment)
      events.push(`出す: ${comment.comment.displayName}`)
    },
    hide: () => events.push('引っ込める'),
    onError: (error) => errors.push(error),
  })
  return { runner, speech, events, shown, waits, errors, iconLookups, iconResolvers }
}

describe('createWipeRunner（読み上げ中）', () => {
  it('届いた発言をアイコン付きで出し、その文を読み上げる', async () => {
    const { runner, speech, shown, events } = setup()

    runner.enqueue(greeting)
    await flush()

    expect(shown).toEqual([{ comment: greeting, profileImageUrl: iconOf('tanenob') }])
    expect(speech.spoken.map(({ text }) => text)).toEqual(['こんにちは'])
    // 読み終わるまでは引っ込めない
    expect(events).toEqual(['出す: たねのぶ'])
  })

  it('読み終えて次の発言が無ければ、しばらく残してから引っ込める', async () => {
    const { runner, speech, events, waits } = setup()

    runner.enqueue(greeting)
    await flush()
    speech.spoken[0]?.finish()
    await flush()

    // 読み終わりの余韻のあと、次の発言を待ってしばらく残す
    expect(waits).toEqual([HOLD_AFTER_SPEECH_MS, LINGER_MS])
    expect(events).toEqual(['出す: たねのぶ', '引っ込める'])
  })

  it('残しているあいだは引っ込めない', async () => {
    const { runner, speech, events } = setup({ keepLingering: true })

    runner.enqueue(greeting)
    await flush()
    speech.spoken[0]?.finish()
    await flush()

    expect(events).toEqual(['出す: たねのぶ'])
  })

  it('残しているあいだに次の発言が届いたら、引っ込めずにすぐ次の人へ替えて読む', async () => {
    const { runner, speech, events } = setup({ keepLingering: true })

    runner.enqueue(greeting)
    await flush()
    speech.spoken[0]?.finish()
    await flush()
    runner.enqueue(scaryTalk)
    await flush()

    expect(events).toEqual(['出す: たねのぶ', '出す: 怖い話す人'])
    expect(speech.spoken.map(({ text }) => text)).toEqual(['こんにちは', '今から怖い話をするね'])
  })

  it('続けて届いた発言は、前の1件を読み終えてから順に出す', async () => {
    const { runner, speech, events } = setup()

    runner.enqueue(greeting)
    runner.enqueue(scaryTalk)
    await flush()
    // 1件目を読んでいるあいだは、2件目を出さない
    expect(speech.spoken.map(({ text }) => text)).toEqual(['こんにちは'])

    speech.spoken[0]?.finish()
    await flush()

    // 次が待っていれば、引っ込めずにそのまま次の人へ替える
    expect(events).toEqual(['出す: たねのぶ', '出す: 怖い話す人'])
    expect(speech.spoken.map(({ text }) => text)).toEqual(['こんにちは', '今から怖い話をするね'])
  })

  it('読み上げに失敗した1件は失敗を知らせ、以降の発言は続けて出す', async () => {
    const events: string[] = []
    const errors: unknown[] = []
    const failing = createWipeRunner({
      lookupIcon: async (login) => iconOf(login),
      speak: async () => {
        throw new Error('VOICEVOX が応答しません')
      },
      muted: () => false,
      wait: async () => undefined,
      show: (comment) => events.push(`出す: ${comment.comment.displayName}`),
      hide: () => events.push('引っ込める'),
      onError: (error) => errors.push(error),
    })

    failing.enqueue(greeting)
    failing.enqueue(scaryTalk)
    await flush()

    expect(errors).toHaveLength(2)
    expect(events).toEqual(['出す: たねのぶ', '出す: 怖い話す人', '引っ込める'])
  })
})

describe('createWipeRunner（ミュート中）', () => {
  it('読み上げずに、文の長さに応じた時間だけ出してから引っ込める', async () => {
    const { runner, speech, events, waits } = setup({ muted: true })

    runner.enqueue(scaryTalk)
    await flush()

    expect(speech.spoken).toEqual([])
    expect(waits).toEqual([silentDurationOf('今から怖い話をするね'), LINGER_MS])
    expect(events).toEqual(['出す: 怖い話す人', '引っ込める'])
  })

  it('読み上げの途中でミュートしたら、鳴っている1件を止めて少し残してから次へ進む', async () => {
    const { runner, speech, events, waits } = setup()

    runner.enqueue(greeting)
    await flush()
    runner.stopSpeaking()
    await flush()

    expect(speech.spoken[0]?.signal.aborted).toBe(true)
    expect(waits).toEqual([HOLD_AFTER_SPEECH_MS, LINGER_MS])
    expect(events).toEqual(['出す: たねのぶ', '引っ込める'])
  })
})

describe('createWipeRunner（アイコン）', () => {
  it('アイコンを引けなかった1件は出さずに失敗を知らせ、次の発言へ進む', async () => {
    const { runner, speech, events, errors } = setup({ failingLogins: ['tanenob'] })

    runner.enqueue(greeting)
    runner.enqueue(scaryTalk)
    await flush()

    expect(errors).toHaveLength(1)
    expect(events).toEqual(['出す: 怖い話す人'])
    expect(speech.spoken.map(({ text }) => text)).toEqual(['今から怖い話をするね'])
  })

  it('同じ人のアイコンは1回だけ引く', async () => {
    const { runner, speech, iconLookups } = setup()

    runner.enqueue(greeting)
    runner.enqueue({ ...greeting, messageId: 'メッセージID-3', spoken: 'またきました' })
    await flush()
    speech.spoken[0]?.finish()
    await flush()

    expect(iconLookups).toEqual(['tanenob'])
  })

  it('引けなかった人のアイコンは、次の発言のときに引き直す', async () => {
    const { runner, iconLookups } = setup({ failingLogins: ['tanenob'] })

    runner.enqueue(greeting)
    await flush()
    runner.enqueue({ ...greeting, messageId: 'メッセージID-3', spoken: 'またきました' })
    await flush()

    expect(iconLookups).toEqual(['tanenob', 'tanenob'])
  })
})

describe('createWipeRunner（モデレーターによる消去）', () => {
  it('出している発言が消されたら、読み上げを止めてすぐ引っ込める', async () => {
    const { runner, speech, events, waits } = setup()

    runner.enqueue(greeting)
    await flush()
    runner.remove((comment) => comment.messageId === 'メッセージID-1')
    await flush()

    expect(speech.spoken[0]?.signal.aborted).toBe(true)
    // 消された発言は少しでも残さない
    expect(waits).toEqual([])
    expect(events).toEqual(['出す: たねのぶ', '引っ込める'])
  })

  it('残している発言が消されたら、すぐ引っ込める', async () => {
    const { runner, speech, events } = setup({ keepLingering: true })

    runner.enqueue(greeting)
    await flush()
    speech.spoken[0]?.finish()
    await flush()
    runner.remove((comment) => comment.login === 'tanenob')
    await flush()

    expect(events).toEqual(['出す: たねのぶ', '引っ込める'])
  })

  it('次の人のアイコンを待つあいだに、出したままの前の発言が消されたら、すぐ引っ込める', async () => {
    const { runner, speech, events, iconResolvers } = setup({ keepLingering: true, pendingIconLogins: ['kowai_hanashi'] })

    runner.enqueue(greeting)
    await flush()
    speech.spoken[0]?.finish()
    await flush()
    // 残しているあいだに次の人の発言が届き、その人のアイコンを引いている
    runner.enqueue(scaryTalk)
    await flush()
    runner.remove((comment) => comment.login === 'tanenob')
    await flush()

    // 消された発言は、次の人を出すまで待たずに引っ込める
    expect(events).toEqual(['出す: たねのぶ', '引っ込める'])

    iconResolvers.get('kowai_hanashi')?.()
    await flush()

    expect(events).toEqual(['出す: たねのぶ', '引っ込める', '出す: 怖い話す人'])
  })

  it('残している発言と別の人の発言が消されても、引っ込めない', async () => {
    const { runner, speech, events } = setup({ keepLingering: true })

    runner.enqueue(greeting)
    await flush()
    speech.spoken[0]?.finish()
    await flush()
    runner.remove((comment) => comment.login === 'kowai_hanashi')
    await flush()

    expect(events).toEqual(['出す: たねのぶ'])
  })

  it('待っている発言が消されたら、その発言は出さない', async () => {
    const { runner, speech, events } = setup()

    runner.enqueue(greeting)
    runner.enqueue(scaryTalk)
    await flush()
    runner.remove((comment) => comment.login === 'kowai_hanashi')
    speech.spoken[0]?.finish()
    await flush()

    expect(events).toEqual(['出す: たねのぶ', '引っ込める'])
  })
})

describe('waitOrAbort', () => {
  it('決めた時間が過ぎたら解決する', async () => {
    vi.useFakeTimers()
    let resolved = false
    void waitOrAbort(1000, new AbortController().signal).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(resolved).toBe(true)
    vi.useRealTimers()
  })

  it('止める合図が来たら、時間を待たずに解決する', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let resolved = false
    void waitOrAbort(1000, controller.signal).then(() => {
      resolved = true
    })

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toBe(true)
    vi.useRealTimers()
  })

  it('すでに止められていれば、すぐ解決する', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(waitOrAbort(60000, controller.signal)).resolves.toBeUndefined()
  })
})
