/**
 * アラートの配送（Durable Object）のテスト
 *
 * WebSocketの接続そのもの（Upgrade）は Cloudflare のランタイムでしか作れないため、ここでは確かめない。
 * 確かめるのは、押し出されたアラートを開いている接続へ配ること、そして Worker 側から押し出す入口（pushAlert）が
 * 失敗を握りつぶさないことである（配る部分そのものは worker/socket-broadcast.test.ts が確かめる）。
 */
import { describe, expect, it } from 'vitest'
import {
  AlertChannel,
  connectAlertSocket,
  connectBgmDuckSocket,
  connectBgmSocket,
  connectPomodoroSocket,
  connectSpeechMuteSocket,
  connectTownTourSocket,
  connectTwisterSocket,
  connectTextSocket,
  connectTaskDeskSocket,
  connectWorkLogSocket,
  pushAlert,
  pushBgm,
  pushBgmDuck,
  pushPomodoro,
  pushSpeechMute,
  pushTownTour,
  pushTownTourAnswer,
  pushTwister,
  pushTaskDesk,
  pushWorkLogEntry,
  revokeAlertSockets,
  type AlertSocket,
} from './alert-channel'
import type { BgmDuck, BgmNowPlaying } from './bgm-config'
import { createFakeAlertChannel } from './fake-alert-channel'
import { createFakeDurableStorage } from './fake-durable-storage'
import type { OverlayAlert } from './alert-event'
import type { TaskDeskSnapshot } from './task-desk'
import type { PomodoroSnapshot } from './pomodoro-timer'
import type { TownTourCall } from './town-tour-call'
import type { TwisterCall } from './twister-call'
import { DEFAULT_TOWN_TOUR_SOUND, playbackSoundOf } from './town-tour-sound'
import type { WorkLogEntry } from './work-log'

const alert: OverlayAlert = {
  media: { kind: 'image', url: '/api/media/media-1?key=オーバーレイ用キー' },
  durationSeconds: 5,
  volume: 0.5,
  text: 'ありがとう！',
}

/** 雑談のBGMを流しているときに配るもの */
const playingTrack: BgmNowPlaying = {
  track: {
    mediaId: 'media-zatsudan',
    title: 'ひだまりの午後',
    credit: '音楽: 甘茶の音楽工房',
    creditUrl: 'https://amachamusic.chagasi.com/',
    url: '/api/media/media-zatsudan?key=オーバーレイ用キー',
  },
  volume: 0.3,  repeat: false,
  shuffle: false,
}

/** PR をマージしたときに作業ログへ1行増やすもの */
const mergedEntry: WorkLogEntry = { id: 'github:delivery-1', kind: 'merge', at: '2026-10-03T12:10:00.000Z', text: '#213 作業ログを出す' }

/** 視聴者が !task で作業を宣言したあとの作業机 */
const deskWithOneTask: TaskDeskSnapshot = {
  entries: [{ userId: '11111', name: 'たなか', task: '英単語を50個覚える', declaredAt: '2026-10-03T12:10:00.000Z', doneAt: null }],
  workTime: { people: 1, totalMs: 0, working: 1, measuredAt: '2026-10-03T12:10:00.000Z' },
}

/** ポモドーロのタイマーを始めたあとの状態 */
/** レイドで引いた市町村の紹介の呼び出し */
const raidTownTour: TownTourCall = {
  code: '01303',
  prefecture: '北海道',
  county: '石狩郡',
  name: '当別町',
  headline: '山田花子さんのレイドを記念して、本日は北海道石狩郡当別町をご紹介します',
  quizId: 'quiz-tobetsu',
  quizHeadline: '山田花子さんのレイドを記念して、本日は当別町をご紹介します',
  sound: playbackSoundOf(DEFAULT_TOWN_TOUR_SOUND, null),
  population: 14974,
  area: 422.86,
  // 同接20人にレイドの30人が加わった
  audience: { kind: 'raid', count: 50 },
  visited: [],
  visit: { occasion: 'raid', userName: '山田花子' },
  honoraryCitizen: '山田花子',
  raider: { login: 'yamada_hanako', viewers: 30 },
  narration: false,
}

const runningPomodoro: PomodoroSnapshot = {
  timer: { startedAt: Date.parse('2026-10-03T12:00:00Z'), anchorAt: Date.parse('2026-10-03T12:00:00Z'), pausedAt: null },
}

/** 市町村紹介のBGMが鳴るあいだ、配信のBGMを42秒下げておく知らせ */
/** レイドで押し出すツイスターの呼び出し */
const raidTwister: TwisterCall = {
  id: 'ツイスターの呼び出しID',
  seed: 20261006,
  players: [
    { name: '山田花子', iconUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/yamada.png' },
    { name: 'たねのぶ', iconUrl: null },
  ],
  sound: { bgm: null, bgmVolume: 0.3 },
}

const duringTownTour: BgmDuck = { holdMs: 42_000 }

/** 下部バーで読み上げをミュートした知らせ */
const speechMuted = { muted: true }

/** 送られた文字列を覚えておく、テスト用の接続 */
const createConnection = (): AlertSocket & { sentMessages: string[] } => {
  const sentMessages: string[] = []
  return { sentMessages, send: (message) => sentMessages.push(message), close: () => undefined }
}

describe('AlertChannel', () => {
  /**
   * 開いている接続を差し替えられる、テスト用の Durable Object を作る。
   *
   * 接続は目印（アラート用か BGM 用か）ごとに渡す。目印を指定して引いたときは、その目印の接続だけを返す
   * （Cloudflare の getWebSockets(tag) と同じ振る舞い）。
   */
  const createDestination = (
    sockets: AlertSocket[],
    bgmSockets: AlertSocket[] = [],
    workLogSockets: AlertSocket[] = [],
    taskDeskSockets: AlertSocket[] = [],
    pomodoroSockets: AlertSocket[] = [],
    townTourSockets: AlertSocket[] = [],
    bgmDuckSockets: AlertSocket[] = [],
    speechMuteSockets: AlertSocket[] = [],
    twisterSockets: AlertSocket[] = [],
    textSockets: AlertSocket[] = [],
  ): AlertChannel =>
    new AlertChannel({
      acceptWebSocket: () => undefined,
      getWebSockets: (tag) => {
        if (tag === 'bgm') return bgmSockets
        if (tag === 'alerts') return sockets
        if (tag === 'workLog') return workLogSockets
        if (tag === 'taskDesk') return taskDeskSockets
        if (tag === 'pomodoro') return pomodoroSockets
        if (tag === 'townTour') return townTourSockets
        if (tag === 'bgmDuck') return bgmDuckSockets
        if (tag === 'speechMute') return speechMuteSockets
        if (tag === 'twister') return twisterSockets
        if (tag === 'text') return textSockets
        return [
          ...sockets,
          ...bgmSockets,
          ...workLogSockets,
          ...taskDeskSockets,
          ...pomodoroSockets,
          ...townTourSockets,
          ...bgmDuckSockets,
          ...speechMuteSockets,
          ...twisterSockets,
          ...textSockets,
        ]
      },
      setWebSocketAutoResponse: () => undefined,
      storage: createFakeDurableStorage(),
    })

  it('押し出されたアラートを、開いている接続すべてへJSONで送る', async () => {
    const connection = createConnection()
    const destination = createDestination([connection])

    const response = await destination.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(alert) }))

    expect(response.status).toBe(204)
    expect(connection.sentMessages).toEqual([JSON.stringify(alert)])
  })

  it('アラートは、BGMを受け取る接続（裏方のページ）へは送らない', async () => {
    const stagePage = createConnection()
    const backstagePage = createConnection()
    const destination = createDestination([stagePage], [backstagePage])

    await destination.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(alert) }))

    expect(stagePage.sentMessages).toEqual([JSON.stringify(alert)])
    expect(backstagePage.sentMessages).toEqual([])
  })

  it('BGMの切り替えは、BGMを受け取る接続だけへ送る（合成ページはアラートとして読めないため）', async () => {
    const stagePage = createConnection()
    const backstagePage = createConnection()
    const destination = createDestination([stagePage], [backstagePage])

    const response = await destination.fetch(new Request('https://alert-channel/push/bgm', { method: 'POST', body: JSON.stringify(playingTrack) }))

    expect(response.status).toBe(204)
    expect(backstagePage.sentMessages).toEqual([JSON.stringify(playingTrack)])
    expect(stagePage.sentMessages).toEqual([])
  })

  it('作業ログの1行は、作業ログを受け取る接続だけへ送る（アラートとしては読めないため）', async () => {
    const alertsItem = createConnection()
    const workLogItem = createConnection()
    const destination = createDestination([alertsItem], [], [workLogItem])

    const response = await destination.fetch(new Request('https://alert-channel/push/work-log', { method: 'POST', body: JSON.stringify(mergedEntry) }))

    expect(response.status).toBe(204)
    expect(workLogItem.sentMessages).toEqual([JSON.stringify(mergedEntry)])
    expect(alertsItem.sentMessages).toEqual([])
  })

  it('作業机は、作業机を受け取る接続だけへ送る（作業ログやアラートとしては読めないため）', async () => {
    const workLogItem = createConnection()
    const taskDeskItem = createConnection()
    const destination = createDestination([], [], [workLogItem], [taskDeskItem])

    const response = await destination.fetch(new Request('https://alert-channel/push/task-desk', { method: 'POST', body: JSON.stringify(deskWithOneTask) }))

    expect(response.status).toBe(204)
    expect(taskDeskItem.sentMessages).toEqual([JSON.stringify(deskWithOneTask)])
    expect(workLogItem.sentMessages).toEqual([])
  })

  it('ポモドーロのタイマーは、タイマーを受け取る接続だけへ送る（作業机やアラートとしては読めないため）', async () => {
    const taskDeskItem = createConnection()
    const pomodoroItem = createConnection()
    const destination = createDestination([], [], [], [taskDeskItem], [pomodoroItem])

    const response = await destination.fetch(new Request('https://alert-channel/push/pomodoro', { method: 'POST', body: JSON.stringify(runningPomodoro) }))

    expect(response.status).toBe(204)
    expect(pomodoroItem.sentMessages).toEqual([JSON.stringify(runningPomodoro)])
    expect(taskDeskItem.sentMessages).toEqual([])
  })

  it('市町村紹介の呼び出しは、市町村紹介を受け取る接続だけへ送る（アラートとしては読めないため）', async () => {
    const alertItem = createConnection()
    const townTourItem = createConnection()
    const destination = createDestination([alertItem], [], [], [], [], [townTourItem])

    const response = await destination.fetch(new Request('https://alert-channel/push/town-tour', { method: 'POST', body: JSON.stringify(raidTownTour) }))

    expect(response.status).toBe(204)
    expect(townTourItem.sentMessages).toEqual([JSON.stringify(raidTownTour)])
    expect(alertItem.sentMessages).toEqual([])
  })

  it('ツイスターの呼び出しは、ツイスターを受け取る接続だけへ送る（アラートとしても市町村紹介としても読めないため）', async () => {
    const alertItem = createConnection()
    const townTourItem = createConnection()
    const twisterItem = createConnection()
    const destination = createDestination([alertItem], [], [], [], [], [townTourItem], [], [], [twisterItem])

    const response = await destination.fetch(new Request('https://alert-channel/push/twister', { method: 'POST', body: JSON.stringify(raidTwister) }))

    expect(response.status).toBe(204)
    expect(twisterItem.sentMessages).toEqual([JSON.stringify(raidTwister)])
    expect(alertItem.sentMessages).toEqual([])
    expect(townTourItem.sentMessages).toEqual([])
  })

  it('テキストの一覧は、テキストを受け取る接続だけへ送る（アラートとしては読めないため）', async () => {
    const alertItem = createConnection()
    const textItem = createConnection()
    const destination = createDestination([alertItem], [], [], [], [], [], [], [], [], [textItem])
    const snapshot = { texts: [{ id: 1, name: '目標', body: 'ログイン画面を作り終える', updatedAt: '2026-10-08T12:00:00.000Z' }] }

    const response = await destination.fetch(new Request('https://alert-channel/push/text', { method: 'POST', body: JSON.stringify(snapshot) }))

    expect(response.status).toBe(204)
    expect(textItem.sentMessages).toEqual([JSON.stringify(snapshot)])
    expect(alertItem.sentMessages).toEqual([])
  })

  it('配信のBGMを下げる知らせは、下げる知らせを受け取る接続（裏方のページ）だけへ送る（曲の切り替えとしては読めないため）', async () => {
    const bgmItem = createConnection()
    const backstageDuck = createConnection()
    const destination = createDestination([], [bgmItem], [], [], [], [], [backstageDuck])

    const response = await destination.fetch(new Request('https://alert-channel/push/bgm-duck', { method: 'POST', body: JSON.stringify(duringTownTour) }))

    expect(response.status).toBe(204)
    expect(backstageDuck.sentMessages).toEqual([JSON.stringify(duringTownTour)])
    expect(bgmItem.sentMessages).toEqual([])
  })

  it('読み上げのミュートの知らせは、ミュートを受け取る接続（読み上げのページ）だけへ送る', async () => {
    const alertItem = createConnection()
    const reader = createConnection()
    const destination = createDestination([alertItem], [], [], [], [], [], [], [reader])

    const response = await destination.fetch(new Request('https://alert-channel/push/speech-mute', { method: 'POST', body: JSON.stringify(speechMuted) }))

    expect(response.status).toBe(204)
    expect(reader.sentMessages).toEqual([JSON.stringify(speechMuted)])
    expect(alertItem.sentMessages).toEqual([])
  })

  it('接続が1本もなければ、送らずに終わる（オーバーレイを開いていない間のアラートは落とす）', async () => {
    const destination = createDestination([])

    const response = await destination.fetch(new Request('https://alert-channel/push', { method: 'POST', body: JSON.stringify(alert) }))

    expect(response.status).toBe(204)
  })

  it('知らない経路は404で返す', async () => {
    const destination = createDestination([])

    const response = await destination.fetch(new Request('https://alert-channel/知らない経路', { method: 'POST' }))

    expect(response.status).toBe(404)
  })
})

describe('pushAlert', () => {
  it('Durable Object へアラートを送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushAlert(delivery.namespace, alert)

    expect(delivery.pushedAlerts).toEqual([alert])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushAlert(delivery.namespace, alert)).rejects.toThrow('アラート')
  })
})

describe('接続の引き渡し', () => {
  it('アラート・BGM・作業ログ・作業机・ポモドーロ・市町村紹介・BGMを下げる知らせ・読み上げのミュート・ツイスターの接続を、目印を付けて Durable Object へ引き渡す', async () => {
    const delivery = createFakeAlertChannel()
    const connectionRequest = (): Request => new Request('https://hdad.example.com/api/overlay/socket?key=k', { headers: { Upgrade: 'websocket' } })

    await connectAlertSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectBgmSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectWorkLogSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectTaskDeskSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectPomodoroSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectTownTourSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectBgmDuckSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectSpeechMuteSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectTwisterSocket(delivery.namespace, connectionRequest(), 'tag-of-key')
    await connectTextSocket(delivery.namespace, connectionRequest(), 'tag-of-key')

    expect(delivery.forwardedConnections.map((request) => new URL(request.url).searchParams.get('topic'))).toEqual([
      'alerts',
      'bgm',
      'workLog',
      'taskDesk',
      'pomodoro',
      'townTour',
      'bgmDuck',
      'speechMute',
      'twister',
      'text',
    ])
  })
})

describe('pushBgm', () => {
  it('Durable Object へ、いま流している曲を送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushBgm(delivery.namespace, playingTrack)

    expect(delivery.pushedBgm).toEqual([playingTrack])
    expect(delivery.pushedAlerts).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushBgm(delivery.namespace, playingTrack)).rejects.toThrow('BGM')
  })
})

describe('pushWorkLogEntry', () => {
  it('Durable Object へ、作業ログの1行を送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushWorkLogEntry(delivery.namespace, mergedEntry)

    expect(delivery.pushedWorkLog).toEqual([mergedEntry])
    expect(delivery.pushedAlerts).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushWorkLogEntry(delivery.namespace, mergedEntry)).rejects.toThrow('作業ログ')
  })
})

describe('pushTaskDesk', () => {
  it('Durable Object へ、いまの作業机を送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushTaskDesk(delivery.namespace, deskWithOneTask)

    expect(delivery.pushedTaskDesk).toEqual([deskWithOneTask])
    expect(delivery.pushedAlerts).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushTaskDesk(delivery.namespace, deskWithOneTask)).rejects.toThrow('作業机')
  })
})

describe('pushPomodoro', () => {
  it('Durable Object へ、いまのタイマーを送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushPomodoro(delivery.namespace, runningPomodoro)

    expect(delivery.pushedPomodoro).toEqual([runningPomodoro])
    expect(delivery.pushedAlerts).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushPomodoro(delivery.namespace, runningPomodoro)).rejects.toThrow('ポモドーロ')
  })
})

describe('pushTwister', () => {
  it('Durable Object へ、ツイスターの呼び出しを送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushTwister(delivery.namespace, raidTwister)

    expect(delivery.pushedTwisters).toEqual([raidTwister])
    expect(delivery.pushedAlerts).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushTwister(delivery.namespace, raidTwister)).rejects.toThrow('ツイスター')
  })
})

describe('pushTownTour', () => {
  it('Durable Object へ、市町村紹介の呼び出しを送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushTownTour(delivery.namespace, raidTownTour)

    expect(delivery.pushedTownTours).toEqual([raidTownTour])
    expect(delivery.pushedAlerts).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushTownTour(delivery.namespace, raidTownTour)).rejects.toThrow('市町村紹介')
  })
})

describe('pushTownTourAnswer', () => {
  it('Durable Object へ、クイズの最初の正解者を、呼び出しと見分けられる形（type: answer）で送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushTownTourAnswer(delivery.namespace, { quizId: 'quiz-tobetsu', userName: '山田花子' })

    expect(delivery.pushedTownTourAnswers).toEqual([{ type: 'answer', quizId: 'quiz-tobetsu', userName: '山田花子' }])
    expect(delivery.pushedTownTours).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushTownTourAnswer(delivery.namespace, { quizId: 'quiz-tobetsu', userName: '山田花子' })).rejects.toThrow('正解者')
  })
})

describe('pushBgmDuck', () => {
  it('Durable Object へ、配信のBGMを下げる知らせを送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushBgmDuck(delivery.namespace, duringTownTour)

    expect(delivery.pushedBgmDucks).toEqual([duringTownTour])
    expect(delivery.pushedBgm).toEqual([])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushBgmDuck(delivery.namespace, duringTownTour)).rejects.toThrow('BGM')
  })
})

describe('pushSpeechMute', () => {
  it('Durable Object へ、読み上げのミュートの知らせを送る', async () => {
    const delivery = createFakeAlertChannel()

    await pushSpeechMute(delivery.namespace, speechMuted)

    expect(delivery.pushedSpeechMutes).toEqual([speechMuted])
  })

  it('Durable Object が失敗を返したら、黙って成功にせず投げる', async () => {
    const delivery = createFakeAlertChannel({ shouldFail: true })

    await expect(pushSpeechMute(delivery.namespace, speechMuted)).rejects.toThrow('読み上げ')
  })
})

describe('オーバーレイ用キーの再発行に伴う切断', () => {
  /** 閉じられたかどうかを覚えておく、テスト用の接続 */
  const createClosableConnection = (): AlertSocket & { closedWith: number[] } => {
    const closedWith: number[] = []
    return { closedWith, send: () => undefined, close: (code) => closedWith.push(code ?? 0) }
  }

  it('POST /revoke を受けたら、新しいキーの目印を覚え、アラートの接続も BGM の接続もすべて閉じる', async () => {
    const stagePage = createClosableConnection()
    const backstagePage = createClosableConnection()
    const storage = createFakeDurableStorage()
    const destination = new AlertChannel({
      acceptWebSocket: () => undefined,
      getWebSockets: (tag) => (tag === 'bgm' ? [backstagePage] : tag === 'alerts' ? [stagePage] : [stagePage, backstagePage]),
      setWebSocketAutoResponse: () => undefined,
      storage,
    })

    const response = await destination.fetch(new Request('https://alert-channel/revoke', { method: 'POST', body: JSON.stringify({ keyTag: 'tag-new' }) }))

    expect(response.status).toBe(204)
    expect(stagePage.closedWith).toEqual([4001])
    expect(backstagePage.closedWith).toEqual([4001])
    expect([...storage.values.values()]).toEqual(['tag-new'])
  })

  it('POST /revoke に新しいキーの目印がなければ400を返し、何も閉じない', async () => {
    const stagePage = createClosableConnection()
    const destination = new AlertChannel({
      acceptWebSocket: () => undefined,
      getWebSockets: () => [stagePage],
      setWebSocketAutoResponse: () => undefined,
      storage: createFakeDurableStorage(),
    })

    const response = await destination.fetch(new Request('https://alert-channel/revoke', { method: 'POST', body: '{}' }))

    expect(response.status).toBe(400)
    expect(stagePage.closedWith).toEqual([])
  })

  it('覚えている目印と違うキーで開こうとした接続は、受け入れずに401を返す（KVの反映待ちで古いキーが通ってしまっても弾く）', async () => {
    const accepted: string[][] = []
    const storage = createFakeDurableStorage()
    const destination = new AlertChannel({
      acceptWebSocket: (_socket, tags) => accepted.push(tags ?? []),
      getWebSockets: () => [],
      setWebSocketAutoResponse: () => undefined,
      storage,
    })
    await destination.fetch(new Request('https://alert-channel/revoke', { method: 'POST', body: JSON.stringify({ keyTag: 'tag-new' }) }))

    const response = await destination.fetch(new Request('https://alert-channel/api/overlay/socket?topic=alerts&keyTag=tag-old', { headers: { Upgrade: 'websocket' } }))

    expect(response.status).toBe(401)
    expect(accepted).toEqual([])
  })

  it('接続の引き渡しでは、利用者が送ってきた目印を Worker の確かめた目印で上書きする', async () => {
    const delivery = createFakeAlertChannel()
    const forged = new Request('https://hdad.example.com/api/overlay/socket?key=k&keyTag=forged', { headers: { Upgrade: 'websocket' } })

    await connectAlertSocket(delivery.namespace, forged, 'tag-of-key')

    expect(delivery.forwardedConnections.map((request) => new URL(request.url).searchParams.getAll('keyTag'))).toEqual([['tag-of-key']])
  })

  it('revokeAlertSockets は新しいキーの目印を付けて切断を頼み、失敗を返されたら投げる', async () => {
    const delivery = createFakeAlertChannel()
    await revokeAlertSockets(delivery.namespace, 'tag-new')
    expect(delivery.revokedKeyTags).toEqual(['tag-new'])
    expect(delivery.pushedAlerts).toEqual([])

    await expect(revokeAlertSockets(createFakeAlertChannel({ shouldFail: true }).namespace, 'tag-new')).rejects.toThrow('切断')
  })
})
