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
  emptyDraft,
  hasAnyAction,
  rowActionLabels,
  rowParamSummary,
  toTriggerInputs,
  withFixedRows,
  describeProblem,
  formatBytes,
  menuGroups,
  menuLabel,
  placeholdersFor,
  rewardOptions,
  supportsShoutout,
  supportsTownTour,
  supportsTwister,
  toDraft,
  toTriggerInput,
  type TriggerDraft,
} from './form'
import { TRIGGER_KINDS, type MediaItem, type StoredTrigger } from './api'

/** トリガー1件分の入力欄の値。テストでは違いのある項目だけを重ねて書く */
const inputs = (overrides: Partial<TriggerDraft> = {}): TriggerDraft => ({
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
  shoutoutEnabled: false,
  townTourEnabled: false,
  twisterEnabled: false,
  ...overrides,
})

/** 保存済みの「アラートを出す」動作 */
const alertAction = (overrides: Record<string, unknown> = {}) => ({
  type: 'alert' as const,
  mediaId: 'sozai-1',
  mediaKind: 'video' as const,
  durationSeconds: 8,
  volume: 0.35,
  message: '乾杯！',
  ...overrides,
})

describe('menuGroups', () => {
  it('メニュー項目を「チャット・イベント・開発・ポモドーロ」の4つに分けて並べる', () => {
    // 広告は配信者から見れば「配信中に起きる出来事」の1つなので、応援と同じ「イベント」にまとめる。
    // GitHub から届く出来事は視聴者の行動ではないので、別の区分「開発」にする。
    // ポモドーロの区切りは配信者が動かすタイマーから起きるので、さらに別の区分にする
    expect(menuGroups.map((group) => group.label)).toEqual(['チャット', 'イベント', '開発', 'ポモドーロ'])
  })

  it('ポモドーロの区分には、作業の開始と休憩の開始を並べる', () => {
    expect(menuGroups[3]?.items.map((item) => item.kind)).toEqual(['pomodoroWorkBegin', 'pomodoroBreakBegin'])
  })

  it('開発の区分には、コミットのpushとPRのマージを並べる', () => {
    expect(menuGroups[2]?.items.map((item) => item.kind)).toEqual(['commitPushed', 'pullRequestMerged'])
  })

  it('すべてのイベント種別がどれかの区分に1回だけ出る（追加し忘れ・重複を防ぐ）', () => {
    const listedKinds = menuGroups.flatMap((group) => group.items.flatMap((item) => item.phases.map((phase) => phase.kind)))

    expect([...listedKinds].sort()).toEqual([...TRIGGER_KINDS].sort())
  })

  it('広告の開始と終了は、1つの項目にまとめて設定する', () => {
    const ad = menuGroups.flatMap((group) => group.items).find((item) => item.label === '広告')

    expect(ad?.phases.map((phase) => phase.kind)).toEqual(['adBreakBegin', 'adBreakEnd'])
    // 効果は開始と終了で別々に持つので、それぞれに見出しを付ける
    expect(ad?.phases.map((phase) => phase.heading)).toEqual(['広告が始まったときの効果', '広告が終わったときの効果'])
  })

  it('広告のほかの項目は、イベント種別を1つだけ持つ', () => {
    const nonAd = menuGroups.flatMap((group) => group.items).filter((item) => item.label !== '広告')

    // 1つしか持たない項目では、効果のまとまりを分けないので見出しを持たない
    expect(nonAd.every((item) => item.phases.length === 1 && item.phases[0]?.heading === null)).toBe(true)
  })

  it('チャットの区分は、挨拶の3項目を細かい順に先頭へ置き、そのあとに「すべての発言」を置く', () => {
    // 挨拶（上の3つ）は当てはまるうち一番上だけが動くので、並び順がそのまま優先順位になる。
    // 「すべての発言」は挨拶と同時に動くので、挨拶のあとに置いて別のものだと分かるようにする
    const chat = menuGroups[0]?.items.map((item) => item.kind)

    expect(chat).toEqual(['newViewer', 'comeback', 'welcome', 'everyMessage', 'keyword', 'fromUser'])
  })

  it('挨拶が排他であることを、区分の説明で知らせる', () => {
    expect(menuGroups[0]?.description).toMatch(/一番上のものだけが動く/)
  })

  it('「別のもの」を指す絞り込みを持つ項目だけ、中に複数の設定を持てる', () => {
    // 久しぶりの人（日数）と広告（自動・手動）は絞り込みが1つで足りるので、複数持てなくする
    // （「どちらでも」の行と「自動だけ」の行が並ぶと、同じ重複の分かりにくさが戻ってしまう）
    const allowsMultiple = menuGroups.flatMap((group) => group.items.filter((item) => item.multiple).map((item) => item.kind))

    expect([...allowsMultiple].sort()).toEqual(['fromUser', 'keyword', 'reward'])
  })

  it('メニュー項目には日本語の名前が付く', () => {
    expect(menuLabel('newViewer')).toBe('初めて来た人の発言')
    expect(menuLabel('adBreakEnd')).toBe('広告が終わった')
  })
})

describe('toTriggerInput', () => {
  it('チャンネルポイントの交換の入力欄の値を、Workerへ送る形にする（音量は百分率から0〜1へ）', () => {
    const draft = inputs({ durationSeconds: '8', volumePercent: '35', message: '乾杯！' })

    expect(toTriggerInput(draft)).toEqual({
      kind: 'reward',
      rewardId: '報酬ID-乾杯',
      actions: [{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 8, volume: 0.35, message: '乾杯！' }],
    })
  })

  it('報酬を選んでいなければ（空文字）、すべての報酬を対象にする null で送る', () => {
    expect(toTriggerInput(inputs({ rewardId: '' }))).toMatchObject({ kind: 'reward', rewardId: null })
  })

  it('パラメータを持たないメニュー項目は、kind と動作だけを送る（ほかの入力欄の値を引きずらない）', () => {
    const draft = inputs({ kind: 'newViewer', login: 'tanenobu', contains: 'おはよう' })

    expect(toTriggerInput(draft)).toEqual({ kind: 'newViewer', actions: [{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 5, volume: 1, message: '' }] })
  })

  it('久しぶりの人が発言したメニュー項目は、日数を文字列から数にして送る', () => {
    expect(toTriggerInput(inputs({ kind: 'comeback', days: '45' }))).toMatchObject({ kind: 'comeback', days: 45 })
  })

  it('日数が空欄なら、保存せずにエラーにする（0日として送ってしまわないため）', () => {
    expect(() => toTriggerInput(inputs({ kind: 'comeback', days: '' }))).toThrowError(/日数/)
  })

  it('決まった人が発言したメニュー項目は、ユーザー名を送る', () => {
    expect(toTriggerInput(inputs({ kind: 'fromUser', login: 'tanenobu' }))).toMatchObject({ kind: 'fromUser', login: 'tanenobu' })
  })

  it('決まった言葉を含む発言のメニュー項目は、言葉を送る', () => {
    expect(toTriggerInput(inputs({ kind: 'keyword', contains: 'おはよう' }))).toMatchObject({ kind: 'keyword', contains: 'おはよう' })
  })

  it.each([
    ['自動で入った広告', 'true', true],
    ['手動で打った広告', 'false', false],
    ['自動・手動を問わない', '', null],
  ] as const)('広告のメニュー項目は、%s の選択を送る', (_name, input, valueToSend) => {
    expect(toTriggerInput(inputs({ kind: 'adBreakBegin', automatic: input }))).toMatchObject({ kind: 'adBreakBegin', automatic: valueToSend })
  })

  it('チャットに送るを選んでいれば、チャットの動作も送る', () => {
    const draft = inputs({ chatEnabled: true, chatMessage: 'ありがとう' })

    expect(toTriggerInput(draft).actions).toEqual([
      { type: 'alert', mediaId: 'sozai-1', durationSeconds: 5, volume: 1, message: '' },
      { type: 'chat', message: 'ありがとう' },
    ])
  })

  it('アラートを出すを外していれば、チャットの動作だけを送る（素材の入力欄が残っていても引きずらない）', () => {
    const draft = inputs({ alertEnabled: false, chatEnabled: true, chatMessage: 'ありがとう' })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'chat', message: 'ありがとう' }])
  })

  it('どの動作も選んでいなければ、動作なしで送る（Workerが問題点を返す）', () => {
    expect(toTriggerInput(inputs({ alertEnabled: false })).actions).toEqual([])
  })

  it('アナウンスを送るを選んでいれば、文言と色を送る', () => {
    const draft = inputs({ alertEnabled: false, announceEnabled: true, announceMessage: 'レイドありがとう', announceColor: 'purple' })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'announce', message: 'レイドありがとう', color: 'purple' }])
  })

  it('アナウンスを送るを外していれば、入力欄に文言が残っていても送らない', () => {
    const draft = inputs({ announceEnabled: false, announceMessage: '書きかけの文言' })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 5, volume: 1, message: '' }])
  })

  it('シャウトアウトを送るを選んでいれば、項目を持たない動作として送る', () => {
    const draft = inputs({ kind: 'raid', alertEnabled: false, shoutoutEnabled: true })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'shoutout' }])
  })

  it('市町村紹介を流すを選んでいれば、項目を持たない動作として送る', () => {
    const draft = inputs({ kind: 'raid', alertEnabled: false, townTourEnabled: true })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'townTour' }])
  })

  it('ツイスターで対戦するを選んでいれば、項目を持たない動作として送る', () => {
    const draft = inputs({ kind: 'raid', alertEnabled: false, twisterEnabled: true })

    expect(toTriggerInput(draft).actions).toEqual([{ type: 'twister' }])
  })

  it('表示時間が数として読めなければエラーにする（何番目のトリガーかは呼び出し側が添える）', () => {
    expect(() => toTriggerInput(inputs({ durationSeconds: '' }))).toThrowError(/表示時間/)
  })

  it('アラートを出さないトリガーでは、表示時間が空欄でもエラーにしない', () => {
    const draft = inputs({ alertEnabled: false, chatEnabled: true, chatMessage: 'ありがとう', durationSeconds: '' })

    expect(() => toTriggerInput(draft)).not.toThrow()
  })
})

describe('toDraft', () => {
  it('保存済みのトリガーを入力欄の値に戻す（音量は百分率）', () => {
    const trigger: StoredTrigger = { kind: 'reward', rewardId: '報酬ID-乾杯', actions: [alertAction()] }

    expect(toDraft(trigger)).toMatchObject({ kind: 'reward', rewardId: '報酬ID-乾杯', alertEnabled: true, durationSeconds: '8', volumePercent: '35', message: '乾杯！' })
  })

  it('すべての報酬を対象にするトリガー（null）は、空文字の選択に戻す', () => {
    expect(toDraft({ kind: 'reward', rewardId: null, actions: [alertAction()] })).toMatchObject({ rewardId: '' })
  })

  it('保存済みの日数は、入力欄の値として文字列に戻す', () => {
    expect(toDraft({ kind: 'comeback', days: 45, actions: [alertAction()] })).toMatchObject({ kind: 'comeback', days: '45' })
  })

  it.each([
    ['自動で入った広告', true, 'true'],
    ['手動で打った広告', false, 'false'],
    ['自動・手動を問わない', null, ''],
  ] as const)('保存済みの広告の絞り込み（%s）を選択欄の値に戻す', (_name, saved, inputValues) => {
    expect(toDraft({ kind: 'adBreakEnd', automatic: saved, actions: [alertAction()] })).toMatchObject({ automatic: inputValues })
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
    expect(toDraft({ kind: 'follow', actions: [alertAction()] })).toMatchObject({ announceEnabled: false, announceColor: 'primary' })
  })

  it('シャウトアウトを送る動作を持つトリガーは、その印を付けて戻す', () => {
    const trigger: StoredTrigger = { kind: 'raid', actions: [{ type: 'shoutout' }] }

    expect(toDraft(trigger)).toMatchObject({ kind: 'raid', alertEnabled: false, shoutoutEnabled: true })
  })

  it('市町村紹介を流す動作を持つトリガーは、その印を付けて戻す', () => {
    const trigger: StoredTrigger = { kind: 'keyword', contains: '!darts', actions: [{ type: 'townTour' }] }

    expect(toDraft(trigger)).toMatchObject({ kind: 'keyword', alertEnabled: false, townTourEnabled: true })
  })

  it('ツイスターで対戦する動作を持つトリガーは、その印を付けて戻す', () => {
    const trigger: StoredTrigger = { kind: 'raid', actions: [{ type: 'twister' }] }

    expect(toDraft(trigger)).toMatchObject({ kind: 'raid', alertEnabled: false, twisterEnabled: true })
  })

  it('LLMに文面を作らせる動作を持つトリガーは、指示の入力欄を埋めて戻す', () => {
    const trigger: StoredTrigger = { kind: 'newViewer', actions: [{ type: 'aiChat', instruction: '歓迎してください' }] }

    expect(toDraft(trigger)).toMatchObject({ aiChatEnabled: true, aiChatInstruction: '歓迎してください' })
  })

  it('保存と読み出しを往復しても、送る形が変わらない', () => {
    const trigger: StoredTrigger = { kind: 'keyword', contains: 'おはよう', actions: [{ type: 'chat', message: 'おはよう！' }] }

    expect(toTriggerInput(toDraft(trigger))).toEqual(trigger)
  })
})

describe('supportsShoutout', () => {
  it('レイドの項目だけがシャウトアウトを置ける（ほかのイベントの相手は配信者とは限らないため）', () => {
    expect(supportsShoutout('raid')).toBe(true)
    expect(TRIGGER_KINDS.filter((kind) => kind !== 'raid').filter(supportsShoutout)).toEqual([])
  })
})

describe('supportsTownTour', () => {
  it('レイドとキーワードの項目だけが市町村紹介を置ける（冒頭で名前を出す相手が決まるため）', () => {
    expect(TRIGGER_KINDS.filter(supportsTownTour)).toEqual(['keyword', 'raid'])
  })
})

describe('createDraft', () => {
  const material: MediaItem[] = [{ id: 'sozai-1', name: '乾杯', kind: 'video', contentType: 'video/mp4', size: 100, uploadedAt: '2026-09-26T00:00:00Z' }]

  it('選んだメニュー項目で、アラートを出す動作を選んだ状態のトリガーを作る', () => {
    expect(createDraft('follow', material)).toMatchObject({ kind: 'follow', alertEnabled: true, mediaId: 'sozai-1' })
  })

  it('素材が1つもなければ、チャットに送る動作を選んだ状態で作る（アラートは出せないため）', () => {
    expect(createDraft('follow', [])).toMatchObject({ alertEnabled: false, chatEnabled: true })
  })

  it('報酬のメニュー項目は、すべての報酬を対象にした状態で作る（絞り込みを選ぶのは配信者に任せる）', () => {
    expect(createDraft('reward', material)).toMatchObject({ kind: 'reward', rewardId: '' })
  })

  it('久しぶりの人が発言したメニュー項目は、日数の既定値（30日）を入れて作る', () => {
    expect(createDraft('comeback', material)).toMatchObject({ days: '30' })
  })

  it('広告のメニュー項目は、自動で入った広告に絞った状態で作る（手動の広告は配信者が自分で告知できるため）', () => {
    expect(createDraft('adBreakBegin', material)).toMatchObject({ automatic: 'true' })
  })
})

describe('withFixedRows', () => {
  it('パラメータを持たない項目は、効果がなくても1行ずつ並ぶ（一覧が固定されている）', () => {
    const rows = withFixedRows([])

    expect(rows.map((row) => row.kind)).toEqual([
      'newViewer',
      'comeback',
      'welcome',
      'everyMessage',
      'follow',
      'subscribe',
      'resubscribe',
      'raid',
      'adBreakBegin',
      'adBreakEnd',
      'commitPushed',
      'pullRequestMerged',
      'pomodoroWorkBegin',
      'pomodoroBreakBegin',
    ])
    expect(rows.every((row) => !hasAnyAction(row))).toBe(true)
  })

  it('広告の片方だけが保存されていたら、もう片方の行にも同じ絞り込みを入れる（1つの枠で共通に見せるため）', () => {
    // 広告の開始と終了は1つの枠にまとまり、絞り込み（自動・手動）の入力欄も1つしかない。
    // 埋める側を既定値のままにすると、保存済みの値と食い違ったまま画面に出てしまう
    const savedEndOnly: TriggerDraft = { ...emptyDraft('adBreakEnd'), automatic: 'true', chatEnabled: true, chatMessage: 'おかえりなさい' }

    const adRow = withFixedRows([savedEndOnly]).filter((row) => row.kind === 'adBreakBegin' || row.kind === 'adBreakEnd')

    expect(adRow.map((row) => row.automatic)).toEqual(['true', 'true'])
  })

  it('保存済みの行はそのまま残し、足りない項目だけを効果なしの行で埋める', () => {
    const saved = toDraft({ kind: 'follow', actions: [{ type: 'chat', message: 'ありがとう' }] })

    const rows = withFixedRows([saved])

    expect(rows.filter((row) => row.kind === 'follow')).toEqual([saved])
  })

  it('パラメータを持つ項目は、保存済みの行がなければ並べない（配信者が追加したときだけ増える）', () => {
    expect(withFixedRows([]).some((row) => row.kind === 'reward')).toBe(false)
  })

  it('行はメニューの並び順にそろえる（保存したときに画面の並びと同じ順になる）', () => {
    const reward = toDraft({ kind: 'reward', rewardId: null, actions: [{ type: 'chat', message: 'ありがとう' }] })
    const words = toDraft({ kind: 'keyword', contains: 'おはよう', actions: [{ type: 'chat', message: 'おはよう' }] })

    const rows = withFixedRows([reward, words])

    expect(rows.findIndex((row) => row.kind === 'keyword')).toBeLessThan(rows.findIndex((row) => row.kind === 'reward'))
  })

  it('同じ項目の中の並びは変えない（配信者が追加した順に出す）', () => {
    const toast = toDraft({ kind: 'reward', rewardId: '報酬ID-乾杯', actions: [{ type: 'chat', message: '乾杯' }] })
    const omikuji = toDraft({ kind: 'reward', rewardId: '報酬ID-おみくじ', actions: [{ type: 'chat', message: 'おみくじ' }] })

    expect(withFixedRows([toast, omikuji]).filter((row) => row.kind === 'reward')).toEqual([toast, omikuji])
  })
})

describe('emptyDraft', () => {
  it('効果をひとつも持たない行を作る（一覧に並べるだけの行）', () => {
    const draft = emptyDraft('follow')

    expect(hasAnyAction(draft)).toBe(false)
    expect(draft).toMatchObject({
      kind: 'follow',
      alertEnabled: false,
      chatEnabled: false,
      announceEnabled: false,
      aiChatEnabled: false,
      shoutoutEnabled: false,
      townTourEnabled: false,
      twisterEnabled: false,
    })
  })
})

describe('toTriggerInputs', () => {
  it('効果を持つ行だけをWorkerへ送る（効果なしの行は保存しない）', () => {
    const noEffect = emptyDraft('follow')
    const withEffect = inputs({ kind: 'raid' })

    expect(toTriggerInputs([noEffect, withEffect])).toEqual([{ kind: 'raid', actions: [{ type: 'alert', mediaId: 'sozai-1', durationSeconds: 5, volume: 1, message: '' }] }])
  })

  it('効果を持つ行が1つもなければ、空の一覧を送る（トリガーをすべて止めたいとき）', () => {
    expect(toTriggerInputs([emptyDraft('follow'), emptyDraft('raid')])).toEqual([])
  })

  it('数として読めない値があれば、どの項目の設定かを添えてエラーにする', () => {
    expect(() => toTriggerInputs([emptyDraft('follow'), inputs({ kind: 'comeback', days: '' })])).toThrowError(
      '「久しぶりの人の発言」の設定: 日数を数で入力してください',
    )
  })
})

describe('rowActionLabels', () => {
  it('付けた効果を決まった順で並べる（画面ではバッジとして1つずつ出す）', () => {
    const input = inputs({ kind: 'follow', chatEnabled: true, announceEnabled: true })

    expect(rowActionLabels(input)).toEqual(['アラート', 'チャット', 'アナウンス'])
  })

  it('シャウトアウトの効果は「シャウトアウト」として出す', () => {
    expect(rowActionLabels(inputs({ kind: 'raid', alertEnabled: false, shoutoutEnabled: true }))).toEqual(['シャウトアウト'])
  })

  it('市町村紹介の効果は「市町村紹介」として出す', () => {
    expect(rowActionLabels(inputs({ kind: 'raid', alertEnabled: false, townTourEnabled: true }))).toEqual(['市町村紹介'])
  })

  it('ツイスターの効果は「ツイスター」として出す', () => {
    expect(rowActionLabels(inputs({ kind: 'raid', alertEnabled: false, twisterEnabled: true }))).toEqual(['ツイスター'])
  })

  it('ツイスターだけを選んだ行も、効果を持つ行として保存する', () => {
    expect(toTriggerInputs([inputs({ kind: 'raid', alertEnabled: false, twisterEnabled: true })])).toEqual([{ kind: 'raid', actions: [{ type: 'twister' }] }])
  })

  it('ツイスターはレイドの項目にだけ置ける', () => {
    expect(supportsTwister('raid')).toBe(true)
    expect(supportsTwister('keyword')).toBe(false)
    expect(supportsTwister('follow')).toBe(false)
  })

  it('AIに文面を作らせる効果は「AIチャット」として出す', () => {
    expect(rowActionLabels(inputs({ kind: 'follow', alertEnabled: false, aiChatEnabled: true }))).toEqual(['AIチャット'])
  })

  it('効果がひとつもなければ空にする（画面では「効果なし」と出す）', () => {
    expect(rowActionLabels(emptyDraft('follow'))).toEqual([])
  })
})

describe('placeholdersFor', () => {
  it.each([
    ['reward', ['{user}', '{reward}', '{summary}']],
    ['follow', ['{user}', '{summary}']],
    ['subscribe', ['{user}', '{tier}', '{summary}']],
    ['resubscribe', ['{user}', '{tier}', '{months}', '{summary}']],
    ['raid', ['{user}', '{viewers}', '{summary}']],
    ['everyMessage', ['{user}', '{message}', '{summary}']],
    ['newViewer', ['{user}', '{message}', '{summary}']],
    // {user} は GitHub のユーザー名、{message} は最後のコミットのメッセージの1行目
    ['commitPushed', ['{user}', '{repo}', '{branch}', '{message}', '{summary}']],
    // {user} はマージした人の GitHub のユーザー名
    ['pullRequestMerged', ['{user}', '{repo}', '{title}', '{number}', '{summary}']],
    ['adBreakBegin', ['{user}', '{duration}', '{summary}']],
    ['adBreakEnd', ['{user}', '{duration}', '{summary}']],
    // ポモドーロの区切りには相手がいないので {user} を持たない
    ['pomodoroWorkBegin', ['{round}', '{minutes}', '{summary}']],
    ['pomodoroBreakBegin', ['{round}', '{minutes}', '{summary}']],
  ] as const)('%s で使える差し込み語を返す', (kind, expected) => {
    expect(placeholdersFor(kind)).toEqual(expected)
  })

  it('配信のあらすじ（{summary}）は、どのメニュー項目でも使える（通知の中身ではなく配信の状態から決まるため）', () => {
    expect(TRIGGER_KINDS.every((kind) => placeholdersFor(kind).includes('{summary}'))).toBe(true)
  })
})

describe('rewardOptions', () => {
  /** 選択欄に並べるのに要らない項目は、どの報酬でも同じ値にしておく */
  const rewardDetails = { prompt: '', isEnabled: true, isUserInputRequired: false, imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', manageable: true }
  const rewards = [
    { id: '報酬ID-乾杯', title: '乾杯する', cost: 500, ...rewardDetails },
    { id: '報酬ID-おみくじ', title: 'おみくじを引く', cost: 100, ...rewardDetails },
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

describe('rowParamSummary', () => {
  const reward = [{ id: '報酬ID-乾杯', title: '乾杯する', cost: 500, prompt: '', isEnabled: true, isUserInputRequired: false, imageUrl: 'https://static-cdn.jtvnw.net/custom-reward-images/default-2.png', manageable: true }]

  it('選んでいる報酬の名前を出す', () => {
    expect(rowParamSummary(inputs({ kind: 'reward', rewardId: '報酬ID-乾杯' }), reward)).toBe('乾杯する')
  })

  it('報酬を選んでいなければ、すべての報酬が対象だと分かるように出す', () => {
    expect(rowParamSummary(inputs({ kind: 'reward', rewardId: '' }), reward)).toBe('すべての報酬')
  })

  it('Twitchの一覧にない報酬でも、報酬IDを出して黙って省略しない', () => {
    expect(rowParamSummary(inputs({ kind: 'reward', rewardId: '報酬ID-消した報酬' }), reward)).toBe('報酬ID-消した報酬')
  })

  it('決まった人が発言した行は、ユーザー名を出す', () => {
    expect(rowParamSummary(inputs({ kind: 'fromUser', login: 'tanenobu' }), [])).toBe('tanenobu')
  })

  it('決まった言葉を含む発言の行は、その言葉を出す', () => {
    expect(rowParamSummary(inputs({ kind: 'keyword', contains: 'おはよう' }), [])).toBe('おはよう')
  })

  it('久しぶりの人が発言した行は、日数を出す', () => {
    expect(rowParamSummary(inputs({ kind: 'comeback', days: '45' }), [])).toBe('45日以上')
  })

  it('広告の行は、自動で入った広告か手動で打った広告かを言葉で出す', () => {
    expect(rowParamSummary(inputs({ kind: 'adBreakBegin', automatic: 'true' }), [])).toBe('自動で入った広告')
    expect(rowParamSummary(inputs({ kind: 'adBreakEnd', automatic: 'false' }), [])).toBe('配信者が手動で打った広告')
  })

  it('絞り込みを持たない行では null を返す', () => {
    expect(rowParamSummary(inputs({ kind: 'follow' }), [])).toBeNull()
    expect(rowParamSummary(inputs({ kind: 'adBreakEnd', automatic: '' }), [])).toBeNull()
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
  it('Workerの問題点の位置（0始まりの triggers[0]）を、送った項目の名前に読み替える', () => {
    expect(describeProblem('triggers[0].days: 1〜365の整数（日数）で指定してください', ['久しぶりの人の発言'])).toBe(
      '「久しぶりの人の発言」の設定の days: 1〜365の整数（日数）で指定してください',
    )
  })

  it('項目の名前が渡されなければ、番号のままにする', () => {
    expect(describeProblem('triggers[0].days: だめです')).toBe('1番目のトリガーの days: だめです')
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
