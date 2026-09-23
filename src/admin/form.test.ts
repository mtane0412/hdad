/**
 * 入力欄と保存形式の変換（form.ts）のテスト
 *
 * 入力欄の値はすべて文字列で、音量は 0〜100 の百分率で見せる。
 * Workerへ送る形（音量は 0〜1）との行き来と、条件のリストの足し引き、イベント種別ごとの選択肢・差し込み語、OBS用URL・表示用の文言を確認する。
 */
import { describe, expect, it } from 'vitest'
import {
  addableConditionKinds,
  changeEvent,
  createCondition,
  describeProblem,
  eventOptions,
  formatBytes,
  overlayUrl,
  placeholdersFor,
  rewardOptions,
  toDraft,
  toTriggerInput,
  triggerSummary,
  type TriggerDraft,
} from './form'
import type { Reward, StoredTrigger } from './api'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const FOLLOW = 'channel.follow'
const RAID = 'channel.raid'
const CHAT_MESSAGE = 'channel.chat.message'

/** トリガー1件分の入力欄の値。テストでは違いのある項目だけを重ねて書く */
const 入力欄 = (overrides: Partial<TriggerDraft> = {}): TriggerDraft => ({
  event: REDEMPTION,
  conditions: [],
  alertEnabled: true,
  mediaId: 'sozai-1',
  durationSeconds: '5',
  volumePercent: '100',
  message: '',
  chatEnabled: false,
  chatMessage: '',
  announceEnabled: false,
  announceMessage: '',
  announceColor: 'primary',
  ...overrides,
})

/** 保存済みの「アラートを出す」動作 */
const アラートの動作 = (overrides: Record<string, unknown> = {}) => ({
  type: 'alert' as const,
  mediaId: 'sozai-1',
  mediaKind: 'video' as const,
  durationSeconds: 8,
  volume: 0.35,
  message: '乾杯！',
  ...overrides,
})

describe('overlayUrl', () => {
  it('サイトのオリジンとオーバーレイ用キーから、OBSに貼るURLを組み立てる', () => {
    expect(overlayUrl('https://hdad.example.com', 'overlay-key_0123')).toBe('https://hdad.example.com/alerts/?key=overlay-key_0123')
  })
})

describe('toTriggerInput', () => {
  it('チャンネルポイント交換の入力欄の値を、Workerへ送る形にする（音量は百分率から0〜1へ）', () => {
    const draft = 入力欄({
      conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }],
      durationSeconds: '8',
      volumePercent: '50',
      message: '{user} さん、乾杯！',
    })

    expect(toTriggerInput(draft)).toEqual({
      event: REDEMPTION,
      conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }],
      actions: [{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 8, volume: 0.5, message: '{user} さん、乾杯！' }],
    })
  })

  it('条件を2つ足した入力欄の値は、その並びのまま送る', () => {
    const draft = 入力欄({
      conditions: [
        { kind: 'reward', rewardId: '報酬ID-乾杯' },
        { kind: 'user', login: 'tanenobu' },
      ],
    })

    expect(toTriggerInput(draft).conditions).toEqual([
      { kind: 'reward', rewardId: '報酬ID-乾杯' },
      { kind: 'user', login: 'tanenobu' },
    ])
  })

  it('returningAfter の日数は、文字列の入力欄の値を数にして送る', () => {
    const draft = 入力欄({ event: CHAT_MESSAGE, conditions: [{ kind: 'returningAfter', days: '30' }] })

    expect(toTriggerInput(draft).conditions).toEqual([{ kind: 'returningAfter', days: 30 }])
  })

  it('returningAfter の日数が空欄なら、保存せずにエラーにする（0日として送ってしまわないため）', () => {
    const draft = 入力欄({ event: CHAT_MESSAGE, conditions: [{ kind: 'returningAfter', days: '' }] })

    expect(() => toTriggerInput(draft)).toThrow('日数')
  })

  it('チャットに送るを選んでいれば、チャットの動作も送る', () => {
    const draft = 入力欄({ chatEnabled: true, chatMessage: '{user} さん、乾杯！ありがとうございます' })

    expect(toTriggerInput(draft).actions).toEqual([
      { type: 'alert', mediaId: 'sozai-1', durationSeconds: 5, volume: 1, message: '' },
      { type: 'chat', message: '{user} さん、乾杯！ありがとうございます' },
    ])
  })

  it('アラートを出すを外していれば、チャットの動作だけを送る（素材の入力欄が残っていても引きずらない）', () => {
    const draft = 入力欄({ alertEnabled: false, chatEnabled: true, chatMessage: 'ありがとうございます' })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'chat', message: 'ありがとうございます' }])
  })

  it('どの動作も選んでいなければ、動作なしで送る（Workerが問題点を返す）', () => {
    expect(toTriggerInput(入力欄({ alertEnabled: false })).actions).toEqual([])
  })

  it('アナウンスを送るを選んでいれば、文言と色を送る', () => {
    const draft = 入力欄({ alertEnabled: false, announceEnabled: true, announceMessage: '{user} さんがレイド！', announceColor: 'purple' })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'announce', message: '{user} さんがレイド！', color: 'purple' }])
  })

  it('アナウンスを送るを外していれば、入力欄に文言が残っていても送らない', () => {
    const draft = 入力欄({ announceEnabled: false, announceMessage: '外したアナウンス' })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 5, volume: 1, message: '' }])
  })

  it('条件を足していなければ、条件なし（そのイベントならいつでも）で送る', () => {
    expect(toTriggerInput(入力欄())).toMatchObject({ event: REDEMPTION, conditions: [] })
  })

  it('表示時間が数として読めなければエラーにする（何番目のトリガーかは呼び出し側が添える）', () => {
    expect(() => toTriggerInput(入力欄({ durationSeconds: '' }))).toThrow('表示時間')
  })

  it('アラートを出さないトリガーでは、表示時間が空欄でもエラーにしない', () => {
    const draft = 入力欄({ alertEnabled: false, durationSeconds: '', chatEnabled: true, chatMessage: 'ありがとう' })

    expect(() => toTriggerInput(draft)).not.toThrow()
  })
})

describe('toDraft', () => {
  it('条件のない保存済みトリガーを入力欄の値に戻す（音量は百分率）', () => {
    const stored: StoredTrigger = { event: REDEMPTION, conditions: [], actions: [アラートの動作()] }

    expect(toDraft(stored)).toEqual(入力欄({ alertEnabled: true, mediaId: 'sozai-1', durationSeconds: '8', volumePercent: '35', message: '乾杯！' }))
  })

  it('保存済みの条件は、そのまま入力欄の条件のリストに戻す', () => {
    const stored: StoredTrigger = {
      event: REDEMPTION,
      conditions: [
        { kind: 'reward', rewardId: '報酬ID-乾杯' },
        { kind: 'user', login: 'tanenobu' },
      ],
      actions: [アラートの動作()],
    }

    expect(toDraft(stored).conditions).toEqual([
      { kind: 'reward', rewardId: '報酬ID-乾杯' },
      { kind: 'user', login: 'tanenobu' },
    ])
  })

  it('保存済みの returningAfter の日数は、入力欄の値として文字列に戻す', () => {
    const stored: StoredTrigger = { event: CHAT_MESSAGE, conditions: [{ kind: 'returningAfter', days: 30 }], actions: [アラートの動作()] }

    expect(toDraft(stored).conditions).toEqual([{ kind: 'returningAfter', days: '30' }])
  })

  it('チャットに送る動作を持つトリガーは、チャットの入力欄を埋めて戻す', () => {
    const stored: StoredTrigger = { event: RAID, conditions: [], actions: [{ type: 'chat', message: '{user} さん、レイドありがとう！' }] }

    expect(toDraft(stored)).toMatchObject({ alertEnabled: false, chatEnabled: true, chatMessage: '{user} さん、レイドありがとう！' })
  })

  it('アナウンスを送る動作を持つトリガーは、文言と色の入力欄を埋めて戻す', () => {
    const stored: StoredTrigger = { event: RAID, conditions: [], actions: [{ type: 'announce', message: '{user} さんがレイド！', color: 'orange' }] }

    expect(toDraft(stored)).toMatchObject({ announceEnabled: true, announceMessage: '{user} さんがレイド！', announceColor: 'orange' })
  })

  it('アナウンスを送る動作を持たないトリガーは、色を既定（primary）にして戻す', () => {
    const stored: StoredTrigger = { event: RAID, conditions: [], actions: [アラートの動作()] }

    expect(toDraft(stored)).toMatchObject({ announceEnabled: false, announceMessage: '', announceColor: 'primary' })
  })
})

describe('eventOptions', () => {
  it('6種類のイベントを、日本語のラベル付きで選べるようにする', () => {
    expect(eventOptions).toEqual([
      { value: REDEMPTION, label: 'チャンネルポイントの交換' },
      { value: FOLLOW, label: 'フォロー' },
      { value: 'channel.subscribe', label: 'サブスク（新規）' },
      { value: 'channel.subscription.message', label: 'サブスク（継続メッセージ）' },
      { value: RAID, label: 'レイド' },
      { value: CHAT_MESSAGE, label: 'チャットの発言' },
    ])
  })
})

describe('placeholdersFor', () => {
  it.each([
    [REDEMPTION, ['{user}', '{reward}']],
    [FOLLOW, ['{user}']],
    ['channel.subscribe', ['{user}', '{tier}']],
    ['channel.subscription.message', ['{user}', '{tier}', '{months}']],
    [RAID, ['{user}', '{viewers}']],
    [CHAT_MESSAGE, ['{user}', '{message}']],
  ] as const)('%s で使える差し込み語を返す', (event, expected) => {
    expect(placeholdersFor(event)).toEqual(expected)
  })
})

describe('rewardOptions', () => {
  const rewards = [
    { id: '報酬ID-乾杯', title: '乾杯する', cost: 500 },
    { id: '報酬ID-おみくじ', title: 'おみくじを引く', cost: 100 },
  ]

  it('報酬を名前と必要ポイントで見せる', () => {
    expect(rewardOptions(rewards, '報酬ID-乾杯')).toEqual([
      { value: '報酬ID-乾杯', label: '乾杯する（500pt）' },
      { value: '報酬ID-おみくじ', label: 'おみくじを引く（100pt）' },
    ])
  })

  it('報酬を選べていない（空文字）ときは、選ぶよう促す選択肢を先頭に置く', () => {
    expect(rewardOptions(rewards, '')[0]).toEqual({ value: '', label: '報酬を選んでください' })
  })

  it('保存済みの報酬がTwitchの一覧にない（削除された）場合も、選択肢として残して分かるようにする', () => {
    expect(rewardOptions(rewards, '報酬ID-消した報酬')[0]).toEqual({ value: '報酬ID-消した報酬', label: 'Twitchの一覧にない報酬（報酬ID-消した報酬）' })
  })
})

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [1536, '1.5 KB'],
    [1_234_567, '1.2 MB'],
  ])('%d バイトを %s と表示する', (size, expected) => {
    expect(formatBytes(size)).toBe(expected)
  })
})

describe('describeProblem', () => {
  it('Workerの問題点の位置（0始まりの triggers[0]）を、画面の番号（1番目のトリガー）に読み替える', () => {
    expect(describeProblem('triggers[0].durationSeconds: 1〜60 の数値で指定してください')).toBe('1番目のトリガーの durationSeconds: 1〜60 の数値で指定してください')
    expect(describeProblem('triggers[11].mediaId: 素材「sozai-9」が存在しません')).toBe('12番目のトリガーの mediaId: 素材「sozai-9」が存在しません')
  })

  it('動作の位置（actions[1]）も、画面の番号（2つ目の動作）に読み替える', () => {
    expect(describeProblem('triggers[0].actions[1].message: 1〜500文字の文字列で指定してください')).toBe(
      '1番目のトリガーの 2つ目の動作の message: 1〜500文字の文字列で指定してください',
    )
  })

  it('条件の位置（conditions[1]）も、画面の番号（2つ目の条件）に読み替える', () => {
    expect(describeProblem('triggers[0].conditions[1].login: 1〜25文字のTwitchのユーザー名で指定してください')).toBe(
      '1番目のトリガーの 2つ目の条件の login: 1〜25文字のTwitchのユーザー名で指定してください',
    )
  })

  it('条件そのものへの問題点（項目名が続かない形）も読み替える', () => {
    expect(describeProblem('triggers[0].conditions[0]: reward の条件はチャンネルポイントの交換にしか付けられません')).toBe(
      '1番目のトリガーの 1つ目の条件: reward の条件はチャンネルポイントの交換にしか付けられません',
    )
  })

  it('トリガーの位置を含まない問題点は、そのまま返す', () => {
    expect(describeProblem('triggers: 100件以内にしてください')).toBe('triggers: 100件以内にしてください')
  })
})

describe('triggerSummary', () => {
  const 拍手の報酬: Reward = { id: 'reward-hakushu', title: '拍手を送る', cost: 100 }

  it('条件がなければ、イベントの名前だけを出す（そのイベントならいつでも当てはまる）', () => {
    expect(triggerSummary(入力欄(), [拍手の報酬])).toBe('チャンネルポイントの交換 → アラート')
  })

  it('reward の条件では、選んだ報酬の名前を添える', () => {
    const draft = 入力欄({ conditions: [{ kind: 'reward', rewardId: 'reward-hakushu' }] })

    expect(triggerSummary(draft, [拍手の報酬])).toBe('チャンネルポイントの交換（報酬「拍手を送る」）→ アラート')
  })

  it('Twitchの一覧にない報酬でも、報酬IDを出して黙って省略しない', () => {
    const draft = 入力欄({ conditions: [{ kind: 'reward', rewardId: 'reward-kieta' }] })

    expect(triggerSummary(draft, [拍手の報酬])).toBe('チャンネルポイントの交換（報酬「reward-kieta」）→ アラート')
  })

  it('user の条件では、ユーザー名を添える', () => {
    const draft = 入力欄({ event: RAID, conditions: [{ kind: 'user', login: 'tanenobu' }] })

    expect(triggerSummary(draft, [])).toBe('レイド（ユーザー「tanenobu」）→ アラート')
  })

  it('text の条件では、その言葉を含む発言が対象だと分かるように添える', () => {
    const draft = 入力欄({ event: CHAT_MESSAGE, conditions: [{ kind: 'text', contains: 'おはよう' }] })

    expect(triggerSummary(draft, [])).toBe('チャットの発言（文面に「おはよう」を含む）→ アラート')
  })

  it('firstChatEver の条件は、要約に「このチャンネルで初めての発言」と出す', () => {
    const draft = 入力欄({ event: CHAT_MESSAGE, conditions: [{ kind: 'firstChatEver' }] })

    expect(triggerSummary(draft, [])).toBe('チャットの発言（このチャンネルで初めての発言）→ アラート')
  })

  it('returningAfter の条件は、要約に日数を添えて出す', () => {
    const draft = 入力欄({ event: CHAT_MESSAGE, conditions: [{ kind: 'returningAfter', days: '30' }] })

    expect(triggerSummary(draft, [])).toBe('チャットの発言（前の発言から30日以上空いている）→ アラート')
  })

  it('firstChatOfStream の条件は、要約に「その配信で初めての発言」と出す', () => {
    const draft = 入力欄({ event: CHAT_MESSAGE, conditions: [{ kind: 'firstChatOfStream' }] })

    expect(triggerSummary(draft, [])).toBe('チャットの発言（その配信で初めての発言）→ アラート')
  })

  it('条件が2つあれば、すべてを満たす必要があることが分かるように並べる', () => {
    const draft = 入力欄({
      conditions: [
        { kind: 'reward', rewardId: 'reward-hakushu' },
        { kind: 'user', login: 'tanenobu' },
      ],
    })

    expect(triggerSummary(draft, [拍手の報酬])).toBe('チャンネルポイントの交換（報酬「拍手を送る」かつユーザー「tanenobu」）→ アラート')
  })

  it('行う動作をすべて並べる', () => {
    expect(triggerSummary(入力欄({ event: RAID, chatEnabled: true, announceEnabled: true }), [])).toBe('レイド → アラート・チャット・アナウンス')
  })

  it('動作を1つも選んでいなければ、何もしないことが分かるようにする', () => {
    expect(triggerSummary(入力欄({ event: FOLLOW, alertEnabled: false }), [])).toBe('フォロー → 動作なし')
  })
})

describe('addableConditionKinds', () => {
  it('チャンネルポイントの交換では、reward と user を足せる', () => {
    expect(addableConditionKinds(入力欄())).toEqual([
      { value: 'reward', label: '報酬' },
      { value: 'user', label: 'ユーザー' },
    ])
  })

  it('チャンネルポイントの交換以外では、reward を足せない（Workerが保存を拒否するため）', () => {
    expect(addableConditionKinds(入力欄({ event: FOLLOW }))).toEqual([{ value: 'user', label: 'ユーザー' }])
  })

  it('チャットの発言では、発言にしか付けられない種類も足せる（reward は付けられない）', () => {
    expect(addableConditionKinds(入力欄({ event: CHAT_MESSAGE }))).toEqual([
      { value: 'user', label: 'ユーザー' },
      { value: 'text', label: '文面に含む言葉' },
      { value: 'firstChatOfStream', label: 'その配信で初めての発言' },
      { value: 'firstChatEver', label: 'このチャンネルで初めての発言' },
      { value: 'returningAfter', label: '前の発言から空いた日数' },
    ])
  })

  it.each(['firstChatEver', 'returningAfter'])('チャットの発言以外では、%s を足せない（Workerが保存を拒否するため）', (kind) => {
    expect(addableConditionKinds(入力欄({ event: FOLLOW })).some((option) => option.value === kind)).toBe(false)
  })

  it('チャットの発言以外では、firstChatOfStream を足せない（Workerが保存を拒否するため）', () => {
    expect(addableConditionKinds(入力欄({ event: FOLLOW })).some((option) => option.value === 'firstChatOfStream')).toBe(false)
  })

  it('チャットの発言以外では、text を足せない（Workerが保存を拒否するため）', () => {
    expect(addableConditionKinds(入力欄({ event: FOLLOW })).some((option) => option.value === 'text')).toBe(false)
  })

  it('すでに足してある種類は選べない（同じ種類は1件まで）', () => {
    const draft = 入力欄({ conditions: [{ kind: 'reward', rewardId: 'reward-hakushu' }] })

    expect(addableConditionKinds(draft)).toEqual([{ value: 'user', label: 'ユーザー' }])
  })
})

describe('createCondition', () => {
  const rewards: Reward[] = [{ id: '報酬ID-乾杯', title: '乾杯する', cost: 500 }]

  it('reward の条件は、置いてある報酬の先頭を選んだ状態で足す（選択欄が見せているとおりの値にする）', () => {
    expect(createCondition('reward', rewards)).toEqual({ kind: 'reward', rewardId: '報酬ID-乾杯' })
  })

  it('報酬の一覧が空なら、報酬を選んでいない状態で足す（保存時にWorkerが問題点を返す）', () => {
    expect(createCondition('reward', [])).toEqual({ kind: 'reward', rewardId: '' })
  })

  it('user の条件は、ユーザー名が空の状態で足す', () => {
    expect(createCondition('user', rewards)).toEqual({ kind: 'user', login: '' })
  })

  it('text の条件は、文面が空の状態で足す', () => {
    expect(createCondition('text', rewards)).toEqual({ kind: 'text', contains: '' })
  })

  it('firstChatOfStream の条件は、入れる値がないのでそのまま足す', () => {
    expect(createCondition('firstChatOfStream', rewards)).toEqual({ kind: 'firstChatOfStream' })
  })

  it('firstChatEver の条件は、入れる値がないのでそのまま足す', () => {
    expect(createCondition('firstChatEver', rewards)).toEqual({ kind: 'firstChatEver' })
  })

  it('returningAfter の条件は、日数の既定値（30日）を入れて足す', () => {
    expect(createCondition('returningAfter', rewards)).toEqual({ kind: 'returningAfter', days: '30' })
  })
})

describe('changeEvent', () => {
  it('チャンネルポイントの交換から別のイベントに変えたら、reward の条件を外す（そのままでは保存できないため）', () => {
    const draft = 入力欄({
      conditions: [
        { kind: 'reward', rewardId: '報酬ID-乾杯' },
        { kind: 'user', login: 'tanenobu' },
      ],
    })

    expect(changeEvent(draft, FOLLOW)).toMatchObject({ event: FOLLOW, conditions: [{ kind: 'user', login: 'tanenobu' }] })
  })

  it('チャットの発言から別のイベントに変えたら、text の条件を外す（そのままでは保存できないため）', () => {
    const draft = 入力欄({
      event: CHAT_MESSAGE,
      conditions: [
        { kind: 'text', contains: 'おはよう' },
        { kind: 'user', login: 'tanenobu' },
      ],
    })

    expect(changeEvent(draft, FOLLOW)).toMatchObject({ event: FOLLOW, conditions: [{ kind: 'user', login: 'tanenobu' }] })
  })

  it('チャットの発言のままなら、text の条件はそのまま残す', () => {
    const draft = 入力欄({ event: CHAT_MESSAGE, conditions: [{ kind: 'text', contains: 'おはよう' }] })

    expect(changeEvent(draft, CHAT_MESSAGE).conditions).toEqual([{ kind: 'text', contains: 'おはよう' }])
  })

  it('チャンネルポイントの交換のままなら、条件はそのまま残す', () => {
    const draft = 入力欄({ conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }] })

    expect(changeEvent(draft, REDEMPTION).conditions).toEqual([{ kind: 'reward', rewardId: '報酬ID-乾杯' }])
  })
})
