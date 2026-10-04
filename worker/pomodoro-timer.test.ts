/**
 * ポモドーロのタイマー（pomodoro-timer.ts）のテスト
 *
 * タイマーの状態は Durable Object（AdBreakTimer の別のインスタンス。名前は pomodoro）の storage に持ち、
 * 区切りの時刻にアラームで起こしてもらう。ここでは Worker からの操作（始める・一時停止・再開・止める・読む）と、
 * アラームが鳴ったときの動き（トリガー・BGMの切り替え・次のアラーム）を、本物の AdBreakTimer に storage の代役を渡して確かめる。
 *
 * Twitch・KV・D1・アラートの配送先は代役にする。配信中かどうかは D1 の配信の区切り（stream_sessions）で決まる。
 */
import { describe, expect, it } from 'vitest'
import type { AdBreakTimerNamespace } from './ad-break-timer'
import { saveAlertConfig } from './alert-config'
import { loadBgmPlayback, saveBgmPlayback, saveBgmTracks, type BgmTrack } from './bgm-config'
import { createFakeWorkersAi } from './fake-ai'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeAssets } from './fake-assets'
import { createFakeBucket } from './fake-bucket'
import { createFakeCommentChannel } from './fake-comment-channel'
import { createFakeDatabase } from './fake-database'
import { createFakeDrawChannel } from './fake-draw-channel'
import { createFakeStore } from './fake-store'
import { createFakeTokenVault } from './fake-token-vault'
import { createFakeTabChannel } from './fake-tab-channel'
import { createTimerInstances } from './fake-timer-instances'
import { HttpError, type Env } from './http'
import { savePomodoroSettings } from './pomodoro-config'
import { controlPomodoro, readPomodoroTimer } from './pomodoro-timer'
import { listFailures, recordStreamOffline, recordStreamOnline } from './stats-store'
import { saveToken } from './token'

const MINUTE = 60 * 1000
/** 配信を始めた時刻 */
const streamStartedAt = Date.parse('2026-10-03T11:30:00Z')
/** タイマーを始めた時刻 */
const startedAt = Date.parse('2026-10-03T12:00:00Z')
const broadcasterId = '12345'
const botId = '67890'

const track = (mediaId: string, title: string): BgmTrack => ({ mediaId, title, credit: 'フリーBGM配布所', creditUrl: '', mood: '', scene: '' })
const workTrack = track('media-作業用ピアノ', '作業用ピアノ')
const breakTrack = track('media-休憩のカフェ', '休憩のカフェ')

/** 区切りの時刻を自由に進められる時計 */
const createClock = () => {
  let current = startedAt
  return {
    now: () => current,
    set: (at: number) => {
      current = at
    },
  }
}

/** チャット送信に応える Twitch の代役。送った文言を順に覚える */
const createTwitch = () => {
  const sentMessages: string[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (request.url === 'https://api.twitch.tv/helix/chat/messages') {
      sentMessages.push(((await request.json()) as { message: string }).message)
      return Response.json({ data: [{ message_id: 'sent', is_sent: true }] })
    }
    throw new Error(`テストで想定していない通信です: ${request.url}`)
  }
  return { sentMessages, fetchImpl }
}

/**
 * 配信中で、botを接続済み・作業と休憩のトリガーがあり・休憩の曲を選んである環境を作る。
 * BGMは作業用の曲を繰り返しなしで流している。
 */
const setUp = async ({ streaming = true }: { streaming?: boolean } = {}) => {
  const clock = createClock()
  const twitch = createTwitch()
  const alerts = createFakeAlertChannel()
  const env = {
    STORE: createFakeStore({ 'overlay-key': 'issued-overlay-key-0123456789abcdefghij' }),
    MEDIA: createFakeBucket(),
    DB: createFakeDatabase(),
    ASSETS: createFakeAssets(),
    TWITCH_CLIENT_ID: 'test-client-id',
    TWITCH_CLIENT_SECRET: 'テスト用シークレット',
    TWITCH_BROADCASTER_ID: broadcasterId,
    SESSION_SECRET: 'テスト用のセッション秘密鍵',
    EVENTSUB_SECRET: 'テスト用のWebhookシークレット',
    ALERTS: alerts.namespace,
    DRAW: createFakeDrawChannel().namespace,
    TAB: createFakeTabChannel().namespace,
    COMMENTS: createFakeCommentChannel().namespace,
    AD_BREAKS: undefined as unknown as AdBreakTimerNamespace,
    TOKENS: createFakeTokenVault().namespace,
    AI: createFakeWorkersAi(),
  } satisfies Env
  const timers = createTimerInstances(() => env, { fetch: twitch.fetchImpl, now: clock.now, wait: async () => {} }, clock.set)
  env.AD_BREAKS = timers.namespace

  await saveToken(env.TOKENS, 'bot', {
    accessToken: 'bot-access-token',
    refreshToken: 'bot-refresh-token',
    expiresAt: startedAt + 24 * 60 * MINUTE,
    scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
    userId: botId,
    login: 'haishinsha_bot',
  })
  await saveAlertConfig(env.STORE, {
    triggers: [
      { kind: 'pomodoroWorkBegin', actions: [{ type: 'chat', message: '{round}本目の作業を始めます（{minutes}分）' }] },
      { kind: 'pomodoroBreakBegin', actions: [{ type: 'chat', message: '{round}本目おつかれさまでした。{minutes}分休憩です' }] },
    ],
  })
  await saveBgmTracks(env.STORE, [workTrack, breakTrack])
  await saveBgmPlayback(env.STORE, { mediaId: workTrack.mediaId, volume: 0.4, repeat: false, shuffle: false })
  await savePomodoroSettings(env.STORE, { breakMediaId: breakTrack.mediaId })
  if (streaming) await recordStreamOnline(env.DB, { id: 'stream-1', startedAt: streamStartedAt })

  return { env, clock, twitch, alerts, timers }
}

describe('readPomodoroTimer', () => {
  it('始めていなければ、止めている（null）と返す', async () => {
    const { env } = await setUp()

    expect(await readPomodoroTimer(env.AD_BREAKS)).toEqual({ timer: null })
  })
})

describe('始める', () => {
  it('タイマーを始め、作業の終わる25分後にアラームを仕掛け、合成ページへ押し出し、作業の開始のトリガーを動かす', async () => {
    const { env, twitch, alerts, timers } = await setUp()

    const snapshot = await controlPomodoro(env.AD_BREAKS, 'start')

    expect(snapshot).toEqual({ timer: { startedAt, anchorAt: startedAt, pausedAt: null } })
    expect(timers.alarmOf('pomodoro')).toBe(startedAt + 25 * MINUTE)
    expect(alerts.pushedPomodoro).toEqual([snapshot])
    expect(twitch.sentMessages).toEqual(['1本目の作業を始めます（25分）'])
    expect(await readPomodoroTimer(env.AD_BREAKS)).toEqual(snapshot)
  })

  it('広告の終了のタイマー（名前 ad-break）とはアラームを取り合わない', async () => {
    const { env, timers } = await setUp()

    await controlPomodoro(env.AD_BREAKS, 'start')

    expect(timers.alarmOf('ad-break')).toBeNull()
  })

  it('もう動いていれば、409で断る（始め直して区切りがずれないようにする）', async () => {
    const { env } = await setUp()
    await controlPomodoro(env.AD_BREAKS, 'start')

    const failure = await controlPomodoro(env.AD_BREAKS, 'start').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(HttpError)
    expect(failure).toMatchObject({ status: 409, code: 'pomodoro-running' })
  })

  it('配信していないときは、タイマーは始めるがトリガーは動かさない（配信の前に始めておける）', async () => {
    const { env, twitch } = await setUp({ streaming: false })

    expect((await controlPomodoro(env.AD_BREAKS, 'start')).timer).not.toBeNull()
    expect(twitch.sentMessages).toEqual([])
  })
})

describe('区切りのアラーム', () => {
  it('作業が終わったら、休憩の開始のトリガーを動かし、休憩の曲へ切り替え、休憩の終わる5分後にアラームを仕掛け直す', async () => {
    const { env, twitch, alerts, timers } = await setUp()
    await controlPomodoro(env.AD_BREAKS, 'start')

    await timers.ring('pomodoro')

    expect(twitch.sentMessages.at(-1)).toBe('1本目おつかれさまでした。5分休憩です')
    expect(await loadBgmPlayback(env.STORE)).toMatchObject({ mediaId: breakTrack.mediaId, repeat: true })
    expect(alerts.pushedBgm.map((pushed) => pushed.track?.title)).toEqual(['休憩のカフェ'])
    expect(timers.alarmOf('pomodoro')).toBe(startedAt + 30 * MINUTE)
  })

  it('休憩が明けたら、2本目の作業の開始のトリガーを動かし、休憩の前の曲へ戻す', async () => {
    const { env, twitch, timers } = await setUp()
    await controlPomodoro(env.AD_BREAKS, 'start')
    await timers.ring('pomodoro')

    await timers.ring('pomodoro')

    expect(twitch.sentMessages.at(-1)).toBe('2本目の作業を始めます（25分）')
    expect(await loadBgmPlayback(env.STORE)).toMatchObject({ mediaId: workTrack.mediaId, repeat: false })
    expect(timers.alarmOf('pomodoro')).toBe(startedAt + 55 * MINUTE)
  })

  it('休憩の曲を選んでいなければ、休憩に入っても曲を変えない', async () => {
    const { env, alerts, timers } = await setUp()
    await savePomodoroSettings(env.STORE, { breakMediaId: null })
    await controlPomodoro(env.AD_BREAKS, 'start')

    await timers.ring('pomodoro')

    expect((await loadBgmPlayback(env.STORE)).mediaId).toBe(workTrack.mediaId)
    expect(alerts.pushedBgm).toEqual([])
  })

  it('休憩の曲がBGMの一覧から消えていたら、曲は変えずに失敗として記録し、トリガーとタイマーは続ける', async () => {
    const { env, twitch, timers } = await setUp()
    await saveBgmTracks(env.STORE, [workTrack])
    await controlPomodoro(env.AD_BREAKS, 'start')

    await timers.ring('pomodoro')

    expect((await listFailures(env.DB)).map((failure) => failure.code)).toEqual(['pomodoro-bgm-failed'])
    expect(twitch.sentMessages.at(-1)).toBe('1本目おつかれさまでした。5分休憩です')
    expect(timers.alarmOf('pomodoro')).toBe(startedAt + 30 * MINUTE)
  })

  it('配信が終わっていたら、トリガーを動かさずにタイマーを止め、休憩の前の曲へ戻す（止め忘れを次の配信へ持ち越さない）', async () => {
    const { env, twitch, alerts, timers } = await setUp()
    await controlPomodoro(env.AD_BREAKS, 'start')
    await timers.ring('pomodoro')
    const sentBeforeOffline = twitch.sentMessages.length
    await recordStreamOffline(env.DB, startedAt + 28 * MINUTE)

    await timers.ring('pomodoro')

    expect(twitch.sentMessages).toHaveLength(sentBeforeOffline)
    expect(await readPomodoroTimer(env.AD_BREAKS)).toEqual({ timer: null })
    expect(alerts.pushedPomodoro.at(-1)).toEqual({ timer: null })
    expect((await loadBgmPlayback(env.STORE)).mediaId).toBe(workTrack.mediaId)
    expect(timers.alarmOf('pomodoro')).toBeNull()
  })
})

describe('一時停止と再開', () => {
  it('一時停止したらアラームを外し、再開したら止めていた時間だけ後ろへずらしてアラームを仕掛け直す', async () => {
    const { env, clock, alerts, timers } = await setUp()
    await controlPomodoro(env.AD_BREAKS, 'start')

    clock.set(startedAt + 10 * MINUTE)
    const paused = await controlPomodoro(env.AD_BREAKS, 'pause')
    expect(paused.timer?.pausedAt).toBe(startedAt + 10 * MINUTE)
    expect(timers.alarmOf('pomodoro')).toBeNull()

    clock.set(startedAt + 40 * MINUTE)
    const resumed = await controlPomodoro(env.AD_BREAKS, 'resume')
    expect(resumed.timer).toEqual({ startedAt, anchorAt: startedAt + 30 * MINUTE, pausedAt: null })
    // 残り15分の作業の続きから進むので、作業の終わりは再開の15分後
    expect(timers.alarmOf('pomodoro')).toBe(startedAt + 55 * MINUTE)
    expect(alerts.pushedPomodoro.map((pushed) => pushed.timer?.pausedAt ?? null)).toEqual([null, startedAt + 10 * MINUTE, null])
  })

  it('始めていなければ一時停止できない（409）', async () => {
    const { env } = await setUp()

    await expect(controlPomodoro(env.AD_BREAKS, 'pause')).rejects.toMatchObject({ status: 409, code: 'pomodoro-stopped' })
  })

  it('一時停止していなければ再開できない（409）', async () => {
    const { env } = await setUp()
    await controlPomodoro(env.AD_BREAKS, 'start')

    await expect(controlPomodoro(env.AD_BREAKS, 'resume')).rejects.toMatchObject({ status: 409, code: 'pomodoro-not-paused' })
  })

  it('もう一時停止していれば一時停止できない（409）', async () => {
    const { env } = await setUp()
    await controlPomodoro(env.AD_BREAKS, 'start')
    await controlPomodoro(env.AD_BREAKS, 'pause')

    await expect(controlPomodoro(env.AD_BREAKS, 'pause')).rejects.toMatchObject({ status: 409, code: 'pomodoro-paused' })
  })
})

describe('止める', () => {
  it('タイマーを消してアラームを外し、止めたことを押し出す', async () => {
    const { env, alerts, timers } = await setUp()
    await controlPomodoro(env.AD_BREAKS, 'start')

    expect(await controlPomodoro(env.AD_BREAKS, 'stop')).toEqual({ timer: null })
    expect(await readPomodoroTimer(env.AD_BREAKS)).toEqual({ timer: null })
    expect(timers.alarmOf('pomodoro')).toBeNull()
    expect(alerts.pushedPomodoro.at(-1)).toEqual({ timer: null })
  })

  it('休憩中に止めたら、休憩の前の曲へ戻す', async () => {
    const { env, timers } = await setUp()
    await controlPomodoro(env.AD_BREAKS, 'start')
    await timers.ring('pomodoro')

    await controlPomodoro(env.AD_BREAKS, 'stop')

    expect(await loadBgmPlayback(env.STORE)).toMatchObject({ mediaId: workTrack.mediaId, repeat: false })
  })

  it('始めていなければ止められない（409）', async () => {
    const { env } = await setUp()

    await expect(controlPomodoro(env.AD_BREAKS, 'stop')).rejects.toMatchObject({ status: 409, code: 'pomodoro-stopped' })
  })
})

describe('押し出しの失敗', () => {
  it('合成ページへの押し出しに失敗しても、操作は成り立たせて失敗として記録する（合成ページは開き直しと5分おきの読み直しで追いつく）', async () => {
    const { env } = await setUp()
    env.ALERTS = createFakeAlertChannel({ shouldFail: true }).namespace

    expect((await controlPomodoro(env.AD_BREAKS, 'start')).timer).not.toBeNull()
    expect((await listFailures(env.DB)).map((failure) => failure.code)).toEqual(['pomodoro-push-failed'])
  })
})
