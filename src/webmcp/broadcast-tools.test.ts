/**
 * WebMCP の配信に出る操作のツール（broadcast-tools.ts）のテスト
 *
 * Worker の Api の代役を渡してツールを作り、execute を直接呼ぶ。チャットへの送信・注目コメントの取り上げをやめる・
 * 市町村紹介とツイスターの試し再生が、画面のボタンと同じ Api を通って実行されることと、
 * 受け付けない入力をエラーにすることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import type { FocusPick } from '@/focus/api'
import type { FocusTarget } from '@/focus/focused'
import { buildBroadcastTools, type BroadcastApis } from './broadcast-tools'

/** いま注目コメントで取り上げている発言（試験用） */
const focusedTarget: FocusTarget = {
  messageId: 'message-1',
  login: 'yoru_no_neko',
  displayName: '夜の猫',
  text: 'こんばんは、作業がんばってください',
  profileImageUrl: 'https://example.com/neko.png',
}

/** 試験用の Api。呼ばれ方を記録する */
const createApis = (focused: FocusTarget | null = focusedTarget) => {
  const calls = {
    streamerMessages: [] as string[],
    botMessages: [] as string[],
    focusSaved: [] as (FocusPick | null)[],
    townTourDemos: [] as { userName: string; viewers: number | null }[],
    twisterDemos: 0,
  }
  const apis: BroadcastApis = {
    commentApi: {
      send: async (message) => {
        calls.streamerMessages.push(message)
      },
    },
    botApi: {
      sendMessage: async (message) => {
        calls.botMessages.push(message)
      },
    },
    focusApi: {
      load: async () => focused,
      save: async (pick) => {
        calls.focusSaved.push(pick)
        return null
      },
    },
    api: {
      playTownTourDemo: async (userName, viewers) => {
        calls.townTourDemos.push({ userName, viewers })
        return '北海道の真ん中、富良野市へようこそ'
      },
      playTwisterDemo: async () => {
        calls.twisterDemos += 1
        return 'raider_sample vs 配信者'
      },
    },
  }
  return { apis, calls }
}

const signal = new AbortController().signal

/** 名前でツールを取り出して実行する */
const run = async (apis: BroadcastApis, name: string, input: Record<string, unknown> = {}): Promise<unknown> => {
  const tool = buildBroadcastTools(apis).find((candidate) => candidate.name === name)
  if (tool === undefined) throw new Error(`${name} というツールがありません`)
  return tool.execute(input, { signal })
}

describe('ツールの一覧', () => {
  it('どれも配信に直接出る操作なので consequentialHint が付いている', () => {
    const tools = buildBroadcastTools(createApis().apis)
    expect(tools.map((tool) => tool.name)).toEqual(['send_chat_message', 'clear_focus', 'play_town_tour_demo', 'play_twister_demo'])
    for (const tool of tools) expect(tool.annotations?.consequentialHint).toBe(true)
  })
})

describe('チャットへの送信', () => {
  it('配信者として送る', async () => {
    const { apis, calls } = createApis()
    expect(await run(apis, 'send_chat_message', { sender: 'streamer', message: 'このあと休憩します' })).toBe('配信者としてチャットへ送りました')
    expect(calls.streamerMessages).toEqual(['このあと休憩します'])
    expect(calls.botMessages).toEqual([])
  })

  it('ボットとして送る', async () => {
    const { apis, calls } = createApis()
    expect(await run(apis, 'send_chat_message', { sender: 'bot', message: '5分後に再開します' })).toBe('ボットとしてチャットへ送りました')
    expect(calls.botMessages).toEqual(['5分後に再開します'])
    expect(calls.streamerMessages).toEqual([])
  })

  it('送り手が streamer・bot 以外ならエラーにする', async () => {
    const { apis, calls } = createApis()
    await expect(run(apis, 'send_chat_message', { sender: 'moderator', message: 'こんにちは' })).rejects.toThrow('sender は streamer・bot のどれかにしてください')
    expect(calls.streamerMessages).toEqual([])
  })

  it('文言が文字列でなければエラーにする', async () => {
    const { apis, calls } = createApis()
    await expect(run(apis, 'send_chat_message', { sender: 'bot', message: 42 })).rejects.toThrow('message は文字列にしてください')
    expect(calls.botMessages).toEqual([])
  })

  it('Worker が断ったら、その理由をそのまま投げる', async () => {
    const { apis } = createApis()
    apis.commentApi = {
      send: async () => {
        throw new Error('配信者がチャットへ送る許可を取り直してください')
      },
    }
    await expect(run(apis, 'send_chat_message', { sender: 'streamer', message: 'こんにちは' })).rejects.toThrow('配信者がチャットへ送る許可を取り直してください')
  })
})

describe('注目コメントの取り上げをやめる', () => {
  it('取り上げている発言があれば外す', async () => {
    const { apis, calls } = createApis()
    expect(await run(apis, 'clear_focus')).toBe('注目コメントの取り上げをやめました')
    expect(calls.focusSaved).toEqual([null])
  })

  it('何も取り上げていなければ、保存せずにそう伝える', async () => {
    const { apis, calls } = createApis(null)
    expect(await run(apis, 'clear_focus')).toBe('注目コメントで取り上げている発言はありません')
    expect(calls.focusSaved).toEqual([])
  })
})

describe('市町村紹介の試し再生', () => {
  it('入力を省くと、見本の名前で人数なしに流す', async () => {
    const { apis, calls } = createApis()
    expect(await run(apis, 'play_town_tour_demo')).toBe('「北海道の真ん中、富良野市へようこそ」を送りました。オーバーレイに「市町村紹介」の素材を置いていれば流れます')
    expect(calls.townTourDemos).toEqual([{ userName: '', viewers: null }])
  })

  it('レイド元のログイン名と人数を渡す', async () => {
    const { apis, calls } = createApis()
    await run(apis, 'play_town_tour_demo', { userName: 'raider_sample', viewers: 12 })
    expect(calls.townTourDemos).toEqual([{ userName: 'raider_sample', viewers: 12 }])
  })

  it('ログイン名が文字列でない・人数が数でなければエラーにする', async () => {
    const { apis, calls } = createApis()
    await expect(run(apis, 'play_town_tour_demo', { userName: 123 })).rejects.toThrow('userName は文字列にしてください')
    await expect(run(apis, 'play_town_tour_demo', { viewers: '12' })).rejects.toThrow('viewers は数にしてください')
    expect(calls.townTourDemos).toEqual([])
  })
})

describe('ツイスターの試し再生', () => {
  it('試しの対戦を流し、対戦する2人を伝える', async () => {
    const { apis, calls } = createApis()
    expect(await run(apis, 'play_twister_demo')).toBe('「raider_sample vs 配信者」の対戦を送りました。オーバーレイに「ツイスター」の素材を置いていれば流れます')
    expect(calls.twisterDemos).toBe(1)
  })
})
