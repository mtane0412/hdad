/**
 * アラートの設定（alert-config.ts）のテスト
 *
 * 管理画面から送られてくる設定を検証して保存用の形にすること、保存済みの設定を読み出せることを確認する。
 * 不正な設定を保存してしまうと配信中にアラートが出なくなるため、保存の前にすべての問題点を挙げて拒否する。
 * トリガーは「既定メニューの項目（kind とそのパラメータ）」と「動作（アラートを出す・チャットに送る）」からなる。
 * イベント種別と条件はメニュー項目から決まる（worker/trigger-menu.ts）ので、ここでは検証しない。
 * 動作の種類ごとに実行者が違う（アラートはオーバーレイ、チャットはWorker）ことも合わせて確認する。
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_CONFIG,
  aiChatActionOf,
  announceActionOf,
  chatActionOf,
  loadAlertConfig,
  parseAlertConfig,
  resolveTrigger,
  saveAlertConfig,
  type AlertConfig,
  type StoredTrigger,
} from './alert-config'
import { createFakeStore } from './fake-store'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'
const CHAT_MESSAGE = 'channel.chat.message'

/** 送られてくる「アラートを出す」動作（素材の種類は保存時にサーバーが書き足すので送られてこない） */
const アラートの動作 = (overrides: Record<string, unknown> = {}) => ({
  type: 'alert',
  mediaId: '素材ID-乾杯の動画',
  durationSeconds: 8,
  volume: 0.5,
  message: '{user} さん、乾杯！',
  ...overrides,
})

/** 送られてくる「チャットに送る」動作 */
const チャットの動作 = (overrides: Record<string, unknown> = {}) => ({
  type: 'chat',
  message: '{user} さん、乾杯！ありがとうございます',
  ...overrides,
})

/** 送られてくる「アナウンスを送る」動作 */
const アナウンスの動作 = (overrides: Record<string, unknown> = {}) => ({
  type: 'announce',
  message: '{user} さんがレイドしてくれました',
  color: 'purple',
  ...overrides,
})

/** 送られてくる「LLMに文面を作らせてチャットへ送る」動作 */
const AIチャットの動作 = (overrides: Record<string, unknown> = {}) => ({
  type: 'aiChat',
  instruction: '初めて来てくれた人に、配信の内容を一言添えて歓迎してください',
  ...overrides,
})

/** 送られてくるトリガー。既定は「決まった報酬が交換されたらアラートを出す」 */
const 送られてきたトリガー = (overrides: Record<string, unknown> = {}) => ({
  kind: 'reward',
  rewardId: '報酬ID-乾杯',
  actions: [アラートの動作()],
  ...overrides,
})

/** 素材IDから種類を引く関数の代役。知らないIDは null（素材が存在しない） */
const 素材の種類 = (mediaId: string) => (mediaId === '素材ID-乾杯の動画' ? 'video' : null)

/** 保存済みの形の「アラートを出す」動作（素材の種類が書き足されている） */
const 保存済みのアラートの動作 = { ...アラートの動作(), type: 'alert' as const, mediaKind: 'video' as const }

describe('parseAlertConfig', () => {
  it('正しい設定は、アラートの動作に素材の種類を書き足した保存用の形になる', () => {
    expect(parseAlertConfig({ triggers: [送られてきたトリガー()] }, 素材の種類)).toEqual({
      triggers: [{ kind: 'reward', rewardId: '報酬ID-乾杯', actions: [保存済みのアラートの動作] }],
    })
  })

  it('アラートとチャットの両方を持つトリガーを受け付ける', () => {
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ actions: [アラートの動作(), チャットの動作()] })] }, 素材の種類)

    expect(config.triggers[0]?.actions).toEqual([保存済みのアラートの動作, { type: 'chat', message: '{user} さん、乾杯！ありがとうございます' }])
  })

  it('チャットに送るだけのトリガー（素材を使わない）を受け付ける', () => {
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ actions: [チャットの動作()] })] }, 素材の種類)

    expect(config.triggers[0]?.actions).toEqual([{ type: 'chat', message: '{user} さん、乾杯！ありがとうございます' }])
  })

  it('アナウンスを送る動作を受け付ける', () => {
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ actions: [アナウンスの動作()] })] }, 素材の種類)

    expect(config.triggers[0]?.actions).toEqual([{ type: 'announce', message: '{user} さんがレイドしてくれました', color: 'purple' }])
  })

  it('アナウンスの色を省略したら primary（チャンネルの色）にする', () => {
    const 色なし = { triggers: [送られてきたトリガー({ actions: [アナウンスの動作({ color: undefined })] })] }

    expect(parseAlertConfig(色なし, 素材の種類).triggers[0]?.actions[0]).toMatchObject({ type: 'announce', color: 'primary' })
  })

  it('LLMに文面を作らせる動作（aiChat）を受け付ける', () => {
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ actions: [AIチャットの動作()] })] }, 素材の種類)

    expect(config.triggers[0]?.actions).toEqual([{ type: 'aiChat', instruction: '初めて来てくれた人に、配信の内容を一言添えて歓迎してください' }])
  })

  it('aiChat の指示が空文字なら拒否する（作らせる手がかりがないため）', () => {
    const 指示なし = { triggers: [送られてきたトリガー({ actions: [AIチャットの動作({ instruction: '' })] })] }

    expect(() => parseAlertConfig(指示なし, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].actions[0].instruction: 1〜1000文字の文字列で指定してください'] }),
    )
  })

  it('chat と aiChat を同じトリガーに並べたら拒否する（同じ発言に2通返ってしまうため）', () => {
    const 両方 = { triggers: [送られてきたトリガー({ actions: [チャットの動作(), AIチャットの動作()] })] }

    expect(() => parseAlertConfig(両方, 素材の種類)).toThrowError(
      expect.objectContaining({
        problems: ['triggers[0].actions: chat と aiChat は同じトリガーに並べられません（同じ発言に2通返ってしまうため）、どちらか一方にしてください'],
      }),
    )
  })

  it('Twitchが受け付けない色は拒否する', () => {
    const 変な色 = { triggers: [送られてきたトリガー({ actions: [アナウンスの動作({ color: 'きいろ' })] })] }

    expect(() => parseAlertConfig(変な色, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].actions[0].color: blue / green / orange / purple / primary のいずれかを指定してください'] }),
    )
  })

  it('アナウンスの文言が空なら拒否する（送るものがない）', () => {
    const 空の文言 = { triggers: [送られてきたトリガー({ actions: [アナウンスの動作({ message: '' })] })] }

    expect(() => parseAlertConfig(空の文言, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].actions[0].message: 1〜500文字の文字列で指定してください'] }),
    )
  })

  it('チャットとアナウンスは別の種類なので、1つのトリガーに両方を置ける', () => {
    const 両方 = { triggers: [送られてきたトリガー({ actions: [チャットの動作(), アナウンスの動作()] })] }

    expect(parseAlertConfig(両方, 素材の種類).triggers[0]?.actions).toHaveLength(2)
  })

  it.each([['chat'], ['firstChatEver'], ['firstChatOfStream'], ['follow'], ['subscribe'], ['resubscribe'], ['raid']])(
    'パラメータを持たないメニュー項目（%s）を受け付ける',
    (kind) => {
      const config = parseAlertConfig({ triggers: [{ kind, actions: [チャットの動作()] }] }, 素材の種類)

      expect(config.triggers[0]).toEqual({ kind, actions: [{ type: 'chat', message: '{user} さん、乾杯！ありがとうございます' }] })
    },
  )

  it('すべての報酬を対象にするチャンネルポイントの交換（rewardId が null）を受け付ける', () => {
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ rewardId: null })] }, 素材の種類)

    expect(config.triggers[0]).toMatchObject({ kind: 'reward', rewardId: null })
  })

  it('報酬IDが空文字なら拒否する（報酬を選べていない）', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ rewardId: '' })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].rewardId: 報酬IDの文字列か、すべての報酬を対象にする null で指定してください'] }),
    )
  })

  it('決まった人が発言したメニュー項目は、ユーザー名を受け取る', () => {
    const config = parseAlertConfig({ triggers: [{ kind: 'chatFromUser', login: 'tanenobu', actions: [チャットの動作()] }] }, 素材の種類)

    expect(config.triggers[0]).toMatchObject({ kind: 'chatFromUser', login: 'tanenobu' })
  })

  it('ユーザー名が空文字なら拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [{ kind: 'chatFromUser', login: '', actions: [チャットの動作()] }] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].login: 1〜25文字のTwitchのユーザー名で指定してください'] }),
    )
  })

  it('決まった言葉を含む発言のメニュー項目は、言葉を受け取る', () => {
    const config = parseAlertConfig({ triggers: [{ kind: 'chatContains', contains: 'おはよう', actions: [チャットの動作()] }] }, 素材の種類)

    expect(config.triggers[0]).toMatchObject({ kind: 'chatContains', contains: 'おはよう' })
  })

  it('含む言葉が空文字なら拒否する（すべての発言に当てはまってしまう）', () => {
    expect(() => parseAlertConfig({ triggers: [{ kind: 'chatContains', contains: '', actions: [チャットの動作()] }] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].contains: 1〜500文字の文字列で指定してください'] }),
    )
  })

  it('久しぶりの人が発言したメニュー項目は、日数を受け取る', () => {
    const config = parseAlertConfig({ triggers: [{ kind: 'returningAfter', days: 30, actions: [チャットの動作()] }] }, 素材の種類)

    expect(config.triggers[0]).toMatchObject({ kind: 'returningAfter', days: 30 })
  })

  it.each([
    ['0日', 0],
    ['366日', 366],
    ['小数の日数', 1.5],
    ['文字列の日数', '30'],
  ])('久しぶりの人が発言したメニュー項目の日数が %s なら拒否する', (_名前, days) => {
    expect(() => parseAlertConfig({ triggers: [{ kind: 'returningAfter', days, actions: [チャットの動作()] }] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].days: 1〜365の整数（日数）で指定してください'] }),
    )
  })

  it.each([['adBreakBegin'], ['adBreakEnd']])('広告のメニュー項目（%s）は、自動で入った広告かどうかを受け取る', (kind) => {
    const config = parseAlertConfig({ triggers: [{ kind, automatic: true, actions: [チャットの動作()] }] }, 素材の種類)

    expect(config.triggers[0]).toMatchObject({ kind, automatic: true })
  })

  it('自動・手動を問わない広告のメニュー項目（automatic が null）を受け付ける', () => {
    const config = parseAlertConfig({ triggers: [{ kind: 'adBreakEnd', automatic: null, actions: [チャットの動作()] }] }, 素材の種類)

    expect(config.triggers[0]).toMatchObject({ kind: 'adBreakEnd', automatic: null })
  })

  it('広告のメニュー項目に真偽値でも null でもない値を指定したら拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [{ kind: 'adBreakBegin', automatic: 'はい', actions: [チャットの動作()] }] }, 素材の種類)).toThrowError(
      expect.objectContaining({
        problems: ['triggers[0].automatic: true（自動で入った広告）か false（手動で打った広告）、または自動・手動を問わない null で指定してください'],
      }),
    )
  })

  it('対応していないメニュー項目は拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ kind: 'cheer' })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: [expect.stringContaining('triggers[0].kind')] }),
    )
  })

  it('トリガーが1件もない設定を受け付ける（アラートをすべて止めたいとき）', () => {
    expect(parseAlertConfig({ triggers: [] }, 素材の種類)).toEqual(EMPTY_CONFIG)
  })

  it('問題のある項目は、何件目のどの動作のどの項目かを示してすべて挙げる', () => {
    const broken = {
      triggers: [
        送られてきたトリガー(),
        送られてきたトリガー({ actions: [アラートの動作({ durationSeconds: 0, volume: 1.5, mediaId: '削除済みの素材ID', message: 123 })] }),
      ],
    }
    expect(() => parseAlertConfig(broken, 素材の種類)).toThrowError(
      expect.objectContaining({
        problems: [
          'triggers[1].actions[0].mediaId: 素材「削除済みの素材ID」が存在しません',
          'triggers[1].actions[0].durationSeconds: 1〜60 の数値で指定してください',
          'triggers[1].actions[0].volume: 0〜1 の数値で指定してください',
          'triggers[1].actions[0].message: 200文字以内の文字列で指定してください',
        ],
      }),
    )
  })

  it('メニュー項目のパラメータの問題と、動作の問題を同時に挙げる', () => {
    const broken = { triggers: [{ kind: 'returningAfter', days: 0, actions: [] }] }

    expect(() => parseAlertConfig(broken, 素材の種類)).toThrowError(
      expect.objectContaining({
        problems: ['triggers[0].days: 1〜365の整数（日数）で指定してください', 'triggers[0].actions: 1件以上の配列で指定してください'],
      }),
    )
  })

  it('動作が1件もないトリガーは拒否する（何も起きないトリガーを保存させない）', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ actions: [] })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].actions: 1件以上の配列で指定してください'] }),
    )
  })

  it('動作が配列でなければ拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ actions: 'アラート' })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].actions: 1件以上の配列で指定してください'] }),
    )
  })

  it('対応していない動作の種類は拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ actions: [アラートの動作({ type: 'ban' })] })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].actions[0].type: alert / chat / announce / aiChat のいずれかを指定してください'] }),
    )
  })

  it('同じ種類の動作が2件あれば拒否する（アラートは1件だけオーバーレイへ渡すため）', () => {
    const 重複 = { triggers: [送られてきたトリガー({ actions: [アラートの動作(), アラートの動作()] })] }

    expect(() => parseAlertConfig(重複, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].actions: 同じ種類の動作（alert）は1件までにしてください'] }),
    )
  })

  it('チャットに送る文言が空なら拒否する（送るものがない）', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ actions: [チャットの動作({ message: '' })] })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].actions[0].message: 1〜500文字の文字列で指定してください'] }),
    )
  })

  it('チャットに送る文言がTwitchの上限（500文字）を超えたら拒否する', () => {
    const 長すぎる文言 = { triggers: [送られてきたトリガー({ actions: [チャットの動作({ message: 'あ'.repeat(501) })] })] }

    expect(() => parseAlertConfig(長すぎる文言, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].actions[0].message: 1〜500文字の文字列で指定してください'] }),
    )
  })

  it('アラートの文言は空でもよい（素材だけを出したいとき）', () => {
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ actions: [アラートの動作({ message: '' })] })] }, 素材の種類)

    expect(config.triggers[0]?.actions[0]).toMatchObject({ type: 'alert', message: '' })
  })

  it('triggers が配列でなければ拒否する', () => {
    expect(() => parseAlertConfig({ triggers: 'なし' }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers: 配列で指定してください'] }),
    )
    expect(() => parseAlertConfig(null, 素材の種類)).toThrow()
  })

  it('トリガーの件数が上限を超えたら拒否する', () => {
    const triggers = Array.from({ length: 101 }, () => 送られてきたトリガー())
    expect(() => parseAlertConfig({ triggers }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers: 100件以内にしてください'] }),
    )
  })
})

describe('resolveTrigger', () => {
  it('メニュー項目を、照合で使う形（イベント種別と条件）へ展開し、動作はそのまま持つ', () => {
    const trigger: StoredTrigger = { kind: 'returningAfter', days: 30, actions: [保存済みのアラートの動作] }

    expect(resolveTrigger(trigger)).toEqual({
      event: CHAT_MESSAGE,
      conditions: [{ kind: 'returningAfter', days: 30 }],
      actions: [保存済みのアラートの動作],
    })
  })
})

describe('saveAlertConfig / loadAlertConfig', () => {
  const 保存用の設定: AlertConfig = {
    triggers: [{ kind: 'reward', rewardId: '報酬ID-乾杯', actions: [保存済みのアラートの動作] }],
  }

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveAlertConfig(store, 保存用の設定)
    expect(await loadAlertConfig(store)).toEqual(保存用の設定)
  })

  it('まだ保存していなければ、トリガーなしの設定を返す', async () => {
    expect(await loadAlertConfig(createFakeStore())).toEqual(EMPTY_CONFIG)
  })

  it('既定メニューにする前の形（event と conditions を直接持つ）で保存されていたら、黙って読み替えずにエラーにする', async () => {
    const store = createFakeStore()
    const 旧形式 = { triggers: [{ event: REDEMPTION, conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }], actions: [保存済みのアラートの動作] }] }
    await store.put('alert-config', JSON.stringify(旧形式))

    await expect(loadAlertConfig(store)).rejects.toThrow(/古い形/)
  })

  it('保存されているメニュー項目が対応していない名前なら、読み替えずにエラーにする', async () => {
    const store = createFakeStore()
    await store.put('alert-config', JSON.stringify({ triggers: [{ kind: 'cheer', actions: [保存済みのアラートの動作] }] }))

    await expect(loadAlertConfig(store)).rejects.toThrow(/古い形/)
  })

  it('読めない内容のときは、何が保存されているのかを読み取れるよう、見つかった項目の名前を並べる', async () => {
    const store = createFakeStore()
    // 動作（actions）に分ける前の、出し方がトリガーに直接ぶら下がっていた形
    const 旧形式 = {
      triggers: [{ event: REDEMPTION, rewardId: '報酬ID-乾杯', mediaId: '素材ID-乾杯の動画', mediaKind: 'video', durationSeconds: 8, volume: 0.5, message: '乾杯！' }],
    }
    await store.put('alert-config', JSON.stringify(旧形式))

    await expect(loadAlertConfig(store)).rejects.toThrow(/event・rewardId・mediaId・mediaKind・durationSeconds・volume・message/)
  })

  it('読めない内容のときは、復旧の手だて（KVの設定を消す）を示す（管理画面もこの読み出しを通るため、画面から直せない）', async () => {
    const store = createFakeStore()
    await store.put('alert-config', JSON.stringify({ triggers: [{ event: REDEMPTION, rewardId: null }] }))

    await expect(loadAlertConfig(store)).rejects.toThrow(/alert-config/)
  })
})

describe('aiChatActionOf', () => {
  it('トリガーからLLMに文面を作らせる動作を取り出す', () => {
    const trigger: StoredTrigger = {
      kind: 'firstChatEver',
      actions: [保存済みのアラートの動作, { type: 'aiChat', instruction: '初めての人を歓迎してください' }],
    }

    expect(aiChatActionOf(trigger)).toEqual({ type: 'aiChat', instruction: '初めての人を歓迎してください' })
  })

  it('LLMに文面を作らせる動作がなければ null を返す', () => {
    expect(aiChatActionOf({ kind: 'chat', actions: [保存済みのアラートの動作] })).toBeNull()
  })
})

describe('announceActionOf', () => {
  it('トリガーからアナウンスを送る動作を取り出す', () => {
    const trigger: StoredTrigger = {
      kind: 'raid',
      actions: [保存済みのアラートの動作, { type: 'announce', message: '{user} さんがレイドしてくれました', color: 'purple' }],
    }

    expect(announceActionOf(trigger)).toEqual({ type: 'announce', message: '{user} さんがレイドしてくれました', color: 'purple' })
  })

  it('アナウンスを送る動作がなければ null を返す', () => {
    expect(announceActionOf({ kind: 'raid', actions: [保存済みのアラートの動作] })).toBeNull()
  })
})

describe('chatActionOf', () => {
  it('トリガーからチャットに送る動作を取り出す', () => {
    const trigger: StoredTrigger = {
      kind: 'follow',
      actions: [保存済みのアラートの動作, { type: 'chat', message: 'フォローありがとうございます' }],
    }

    expect(chatActionOf(trigger)).toEqual({ type: 'chat', message: 'フォローありがとうございます' })
  })

  it('チャットに送る動作がなければ null を返す', () => {
    expect(chatActionOf({ kind: 'follow', actions: [保存済みのアラートの動作] })).toBeNull()
  })
})
