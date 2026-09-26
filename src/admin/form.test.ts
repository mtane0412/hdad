/**
 * 入力欄と保存形式の変換（form.ts）のテスト
 *
 * トリガーは既定メニューの項目（kind）と、その項目が要求するパラメータ1つからなる。
 * 入力欄の値はすべて文字列で、音量は 0〜100 の百分率で見せる。
 * Workerへ送る形（音量は 0〜1、日数は数、報酬と広告の「絞り込まない」は null）との行き来と、
 * メニューの並び・差し込み語・OBS用URL・表示用の文言を確認する。
 */
import { describe, expect, it } from 'vitest'
import {
  createDraft,
  describeProblem,
  formatBytes,
  menuGroups,
  menuLabel,
  overlayUrl,
  placeholdersFor,
  rewardOptions,
  toDraft,
  toTriggerInput,
  triggerSummary,
  type TriggerDraft,
} from './form'
import { TRIGGER_KINDS, type MediaItem, type StoredTrigger } from './api'

/** トリガー1件分の入力欄の値。テストでは違いのある項目だけを重ねて書く */
const 入力欄 = (overrides: Partial<TriggerDraft> = {}): TriggerDraft => ({
  kind: 'reward',
  rewardId: '報酬ID-乾杯',
  login: '',
  contains: '',
  days: '30',
  automatic: '',
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
  aiChatEnabled: false,
  aiChatInstruction: '',
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
    expect(overlayUrl('https://hdad.example', 'キー/含む')).toBe('https://hdad.example/alerts/?key=%E3%82%AD%E3%83%BC%2F%E5%90%AB%E3%82%80')
  })
})

describe('menuGroups', () => {
  it('メニュー項目を「視聴者・応援・配信」の3つに分けて並べる', () => {
    expect(menuGroups.map((group) => group.label)).toEqual(['視聴者', '応援', '配信'])
  })

  it('すべてのメニュー項目がどれかの区分に1回だけ出る（足し忘れ・重複を防ぐ）', () => {
    const 並んでいる項目 = menuGroups.flatMap((group) => group.items.map((item) => item.kind))

    expect([...並んでいる項目].sort()).toEqual([...TRIGGER_KINDS].sort())
  })

  it('メニュー項目には日本語の名前が付く', () => {
    expect(menuLabel('firstChatEver')).toBe('このチャンネルで初めての人が発言した')
    expect(menuLabel('adBreakEnd')).toBe('広告が終わった')
  })
})

describe('toTriggerInput', () => {
  it('チャンネルポイントの交換の入力欄の値を、Workerへ送る形にする（音量は百分率から0〜1へ）', () => {
    const draft = 入力欄({ durationSeconds: '8', volumePercent: '35', message: '乾杯！' })

    expect(toTriggerInput(draft)).toEqual({
      kind: 'reward',
      rewardId: '報酬ID-乾杯',
      actions: [{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 8, volume: 0.35, message: '乾杯！' }],
    })
  })

  it('報酬を選んでいなければ（空文字）、すべての報酬を対象にする null で送る', () => {
    expect(toTriggerInput(入力欄({ rewardId: '' }))).toMatchObject({ kind: 'reward', rewardId: null })
  })

  it('パラメータを持たないメニュー項目は、kind と動作だけを送る（ほかの入力欄の値を引きずらない）', () => {
    const draft = 入力欄({ kind: 'firstChatEver', login: 'tanenobu', contains: 'おはよう' })

    expect(toTriggerInput(draft)).toEqual({ kind: 'firstChatEver', actions: [{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 5, volume: 1, message: '' }] })
  })

  it('久しぶりの人が発言したメニュー項目は、日数を文字列から数にして送る', () => {
    expect(toTriggerInput(入力欄({ kind: 'returningAfter', days: '45' }))).toMatchObject({ kind: 'returningAfter', days: 45 })
  })

  it('日数が空欄なら、保存せずにエラーにする（0日として送ってしまわないため）', () => {
    expect(() => toTriggerInput(入力欄({ kind: 'returningAfter', days: '' }))).toThrowError(/日数/)
  })

  it('決まった人が発言したメニュー項目は、ユーザー名を送る', () => {
    expect(toTriggerInput(入力欄({ kind: 'chatFromUser', login: 'tanenobu' }))).toMatchObject({ kind: 'chatFromUser', login: 'tanenobu' })
  })

  it('決まった言葉を含む発言のメニュー項目は、言葉を送る', () => {
    expect(toTriggerInput(入力欄({ kind: 'chatContains', contains: 'おはよう' }))).toMatchObject({ kind: 'chatContains', contains: 'おはよう' })
  })

  it.each([
    ['自動で入った広告', 'true', true],
    ['手動で打った広告', 'false', false],
    ['自動・手動を問わない', '', null],
  ] as const)('広告のメニュー項目は、%s の選択を送る', (_名前, 入力, 送る値) => {
    expect(toTriggerInput(入力欄({ kind: 'adBreakBegin', automatic: 入力 }))).toMatchObject({ kind: 'adBreakBegin', automatic: 送る値 })
  })

  it('チャットに送るを選んでいれば、チャットの動作も送る', () => {
    const draft = 入力欄({ chatEnabled: true, chatMessage: 'ありがとう' })

    expect(toTriggerInput(draft).actions).toEqual([
      { type: 'alert', mediaId: 'sozai-1', durationSeconds: 5, volume: 1, message: '' },
      { type: 'chat', message: 'ありがとう' },
    ])
  })

  it('アラートを出すを外していれば、チャットの動作だけを送る（素材の入力欄が残っていても引きずらない）', () => {
    const draft = 入力欄({ alertEnabled: false, chatEnabled: true, chatMessage: 'ありがとう' })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'chat', message: 'ありがとう' }])
  })

  it('どの動作も選んでいなければ、動作なしで送る（Workerが問題点を返す）', () => {
    expect(toTriggerInput(入力欄({ alertEnabled: false })).actions).toEqual([])
  })

  it('アナウンスを送るを選んでいれば、文言と色を送る', () => {
    const draft = 入力欄({ alertEnabled: false, announceEnabled: true, announceMessage: 'レイドありがとう', announceColor: 'purple' })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'announce', message: 'レイドありがとう', color: 'purple' }])
  })

  it('アナウンスを送るを外していれば、入力欄に文言が残っていても送らない', () => {
    const draft = 入力欄({ announceEnabled: false, announceMessage: '書きかけの文言' })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 5, volume: 1, message: '' }])
  })

  it('表示時間が数として読めなければエラーにする（何番目のトリガーかは呼び出し側が添える）', () => {
    expect(() => toTriggerInput(入力欄({ durationSeconds: '' }))).toThrowError(/表示時間/)
  })

  it('アラートを出さないトリガーでは、表示時間が空欄でもエラーにしない', () => {
    const draft = 入力欄({ alertEnabled: false, chatEnabled: true, chatMessage: 'ありがとう', durationSeconds: '' })

    expect(() => toTriggerInput(draft)).not.toThrow()
  })
})

describe('toDraft', () => {
  it('保存済みのトリガーを入力欄の値に戻す（音量は百分率）', () => {
    const trigger: StoredTrigger = { kind: 'reward', rewardId: '報酬ID-乾杯', actions: [アラートの動作()] }

    expect(toDraft(trigger)).toMatchObject({ kind: 'reward', rewardId: '報酬ID-乾杯', alertEnabled: true, durationSeconds: '8', volumePercent: '35', message: '乾杯！' })
  })

  it('すべての報酬を対象にするトリガー（null）は、空文字の選択に戻す', () => {
    expect(toDraft({ kind: 'reward', rewardId: null, actions: [アラートの動作()] })).toMatchObject({ rewardId: '' })
  })

  it('保存済みの日数は、入力欄の値として文字列に戻す', () => {
    expect(toDraft({ kind: 'returningAfter', days: 45, actions: [アラートの動作()] })).toMatchObject({ kind: 'returningAfter', days: '45' })
  })

  it.each([
    ['自動で入った広告', true, 'true'],
    ['手動で打った広告', false, 'false'],
    ['自動・手動を問わない', null, ''],
  ] as const)('保存済みの広告の絞り込み（%s）を選択欄の値に戻す', (_名前, 保存済み, 入力欄の値) => {
    expect(toDraft({ kind: 'adBreakEnd', automatic: 保存済み, actions: [アラートの動作()] })).toMatchObject({ automatic: 入力欄の値 })
  })

  it('チャットに送る動作を持つトリガーは、チャットの入力欄を埋めて戻す', () => {
    const trigger: StoredTrigger = { kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] }

    expect(toDraft(trigger)).toMatchObject({ kind: 'follow', alertEnabled: false, chatEnabled: true, chatMessage: 'ありがとう' })
  })

  it('アナウンスを送る動作を持つトリガーは、文言と色の入力欄を埋めて戻す', () => {
    const trigger: StoredTrigger = { kind: 'raid', actions: [{ type: 'announce', message: 'レイドありがとう', color: 'purple' }] }

    expect(toDraft(trigger)).toMatchObject({ announceEnabled: true, announceMessage: 'レイドありがとう', announceColor: 'purple' })
  })

  it('アナウンスを送る動作を持たないトリガーは、色を既定（primary）にして戻す', () => {
    expect(toDraft({ kind: 'follow', actions: [アラートの動作()] })).toMatchObject({ announceEnabled: false, announceColor: 'primary' })
  })

  it('LLMに文面を作らせる動作を持つトリガーは、指示の入力欄を埋めて戻す', () => {
    const trigger: StoredTrigger = { kind: 'firstChatEver', actions: [{ type: 'aiChat', instruction: '歓迎してください' }] }

    expect(toDraft(trigger)).toMatchObject({ aiChatEnabled: true, aiChatInstruction: '歓迎してください' })
  })

  it('保存と読み出しを往復しても、送る形が変わらない', () => {
    const trigger: StoredTrigger = { kind: 'chatContains', contains: 'おはよう', actions: [{ type: 'chat', message: 'おはよう！' }] }

    expect(toTriggerInput(toDraft(trigger))).toEqual(trigger)
  })
})

describe('createDraft', () => {
  const 素材: MediaItem[] = [{ id: 'sozai-1', name: '乾杯', kind: 'video', contentType: 'video/mp4', size: 100, uploadedAt: '2026-09-26T00:00:00Z' }]

  it('選んだメニュー項目で、アラートを出す動作を選んだ状態のトリガーを作る', () => {
    expect(createDraft('follow', 素材)).toMatchObject({ kind: 'follow', alertEnabled: true, mediaId: 'sozai-1' })
  })

  it('素材が1つもなければ、チャットに送る動作を選んだ状態で作る（アラートは出せないため）', () => {
    expect(createDraft('follow', [])).toMatchObject({ alertEnabled: false, chatEnabled: true })
  })

  it('報酬のメニュー項目は、すべての報酬を対象にした状態で作る（絞り込みを選ぶのは配信者に任せる）', () => {
    expect(createDraft('reward', 素材)).toMatchObject({ kind: 'reward', rewardId: '' })
  })

  it('久しぶりの人が発言したメニュー項目は、日数の既定値（30日）を入れて作る', () => {
    expect(createDraft('returningAfter', 素材)).toMatchObject({ days: '30' })
  })

  it('広告のメニュー項目は、自動で入った広告に絞った状態で作る（手動の広告は配信者が自分で告知できるため）', () => {
    expect(createDraft('adBreakBegin', 素材)).toMatchObject({ automatic: 'true' })
  })
})

describe('placeholdersFor', () => {
  it.each([
    ['reward', ['{user}', '{reward}', '{summary}']],
    ['follow', ['{user}', '{summary}']],
    ['subscribe', ['{user}', '{tier}', '{summary}']],
    ['resubscribe', ['{user}', '{tier}', '{months}', '{summary}']],
    ['raid', ['{user}', '{viewers}', '{summary}']],
    ['chat', ['{user}', '{message}', '{summary}']],
    ['firstChatEver', ['{user}', '{message}', '{summary}']],
    ['adBreakBegin', ['{user}', '{duration}', '{summary}']],
    ['adBreakEnd', ['{user}', '{duration}', '{summary}']],
  ] as const)('%s で使える差し込み語を返す', (kind, expected) => {
    expect(placeholdersFor(kind)).toEqual(expected)
  })

  it('配信のあらすじ（{summary}）は、どのメニュー項目でも使える（通知の中身ではなく配信の状態から決まるため）', () => {
    expect(TRIGGER_KINDS.every((kind) => placeholdersFor(kind).includes('{summary}'))).toBe(true)
  })
})

describe('rewardOptions', () => {
  const rewards = [
    { id: '報酬ID-乾杯', title: '乾杯する', cost: 500 },
    { id: '報酬ID-おみくじ', title: 'おみくじを引く', cost: 100 },
  ]

  it('報酬を名前と必要ポイントで見せ、先頭に「すべての報酬」を置く', () => {
    expect(rewardOptions(rewards, '報酬ID-乾杯')).toEqual([
      { value: '', label: 'すべての報酬' },
      { value: '報酬ID-乾杯', label: '乾杯する（500pt）' },
      { value: '報酬ID-おみくじ', label: 'おみくじを引く（100pt）' },
    ])
  })

  it('保存済みの報酬がTwitchの一覧にない（削除された）場合も、選択肢として残して分かるようにする', () => {
    expect(rewardOptions(rewards, '報酬ID-消した報酬')[0]).toEqual({ value: '報酬ID-消した報酬', label: 'Twitchの一覧にない報酬（報酬ID-消した報酬）' })
  })
})

describe('triggerSummary', () => {
  const 報酬 = [{ id: '報酬ID-乾杯', title: '乾杯する', cost: 500 }]

  it('パラメータを持たないメニュー項目は、その名前だけを出す', () => {
    expect(triggerSummary(入力欄({ kind: 'follow' }), [])).toBe('フォローされた → アラート')
  })

  it('報酬を選んでいれば、その名前を添える', () => {
    expect(triggerSummary(入力欄({ kind: 'reward', rewardId: '報酬ID-乾杯' }), 報酬)).toBe('チャンネルポイントが交換された（乾杯する）→ アラート')
  })

  it('報酬を選んでいなければ、すべての報酬が対象だと分かるように出す', () => {
    expect(triggerSummary(入力欄({ kind: 'reward', rewardId: '' }), 報酬)).toBe('チャンネルポイントが交換された（すべての報酬）→ アラート')
  })

  it('Twitchの一覧にない報酬でも、報酬IDを出して黙って省略しない', () => {
    expect(triggerSummary(入力欄({ kind: 'reward', rewardId: '報酬ID-消した報酬' }), 報酬)).toBe('チャンネルポイントが交換された（報酬ID-消した報酬）→ アラート')
  })

  it('決まった人が発言したメニュー項目は、ユーザー名を添える', () => {
    expect(triggerSummary(入力欄({ kind: 'chatFromUser', login: 'tanenobu' }), [])).toBe('決まった人が発言した（tanenobu）→ アラート')
  })

  it('決まった言葉を含む発言のメニュー項目は、その言葉を添える', () => {
    expect(triggerSummary(入力欄({ kind: 'chatContains', contains: 'おはよう' }), [])).toBe('決まった言葉を含む発言があった（おはよう）→ アラート')
  })

  it('久しぶりの人が発言したメニュー項目は、日数を添える', () => {
    expect(triggerSummary(入力欄({ kind: 'returningAfter', days: '45' }), [])).toBe('久しぶりの人が発言した（45日以上）→ アラート')
  })

  it('広告のメニュー項目は、自動で入った広告か手動で打った広告かを言葉で添える', () => {
    expect(triggerSummary(入力欄({ kind: 'adBreakBegin', automatic: 'true' }), [])).toBe('広告が始まった（自動で入った広告）→ アラート')
    expect(triggerSummary(入力欄({ kind: 'adBreakEnd', automatic: 'false' }), [])).toBe('広告が終わった（配信者が手動で打った広告）→ アラート')
  })

  it('自動・手動を問わない広告は、絞り込みを添えない', () => {
    expect(triggerSummary(入力欄({ kind: 'adBreakEnd', automatic: '' }), [])).toBe('広告が終わった → アラート')
  })

  it('行う動作をすべて並べる', () => {
    const draft = 入力欄({ kind: 'follow', chatEnabled: true, announceEnabled: true, aiChatEnabled: false })

    expect(triggerSummary(draft, [])).toBe('フォローされた → アラート・チャット・アナウンス')
  })

  it('AIに文面を作らせる動作は「AIチャット」として出す', () => {
    expect(triggerSummary(入力欄({ kind: 'follow', alertEnabled: false, aiChatEnabled: true }), [])).toBe('フォローされた → AIチャット')
  })

  it('動作を1つも選んでいなければ、何もしないことが分かるようにする', () => {
    expect(triggerSummary(入力欄({ kind: 'follow', alertEnabled: false }), [])).toBe('フォローされた → 動作なし')
  })
})

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [3 * 1024 * 1024, '3.0 MB'],
  ])('%s バイトを読みやすい単位にする', (size, expected) => {
    expect(formatBytes(size)).toBe(expected)
  })
})

describe('describeProblem', () => {
  it('Workerの問題点の位置（0始まりの triggers[0]）を、画面の番号（1番目のトリガー）に読み替える', () => {
    expect(describeProblem('triggers[0].days: 1〜365の整数（日数）で指定してください')).toBe('1番目のトリガーの days: 1〜365の整数（日数）で指定してください')
  })

  it('動作の位置（actions[1]）も、画面の番号（2つ目の動作）に読み替える', () => {
    expect(describeProblem('triggers[2].actions[1].message: 1〜500文字の文字列で指定してください')).toBe(
      '3番目のトリガーの 2つ目の動作の message: 1〜500文字の文字列で指定してください',
    )
  })

  it('動作そのものへの問題点（項目名が続かない形）も読み替える', () => {
    expect(describeProblem('triggers[0].actions: 1件以上の配列で指定してください')).toBe('1番目のトリガーの actions: 1件以上の配列で指定してください')
  })

  it('トリガーの位置を含まない問題点は、そのまま返す', () => {
    expect(describeProblem('triggers: 100件以内にしてください')).toBe('triggers: 100件以内にしてください')
  })
})
