/**
 * アラートの設定（alert-config.ts）のテスト
 *
 * 管理画面から送られてくる設定を検証して保存用の形にすること、オーバーレイ向けに素材のURLを付けた形へ変換することを確認する。
 * 不正な設定を保存してしまうと配信中にアラートが出なくなるため、保存の前にすべての問題点を挙げて拒否する。
 * トリガーは「イベント種別」「条件のリスト（conditions）」「動作（アラートを出す・チャットに送る）」からなり、
 * 条件はすべてを満たしたときだけ当てはまる（and）。動作の種類ごとに実行者が違う（アラートはオーバーレイ、チャットはWorker）ことも合わせて確認する。
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_CONFIG,
  announceActionOf,
  chatActionOf,
  loadAlertConfig,
  parseAlertConfig,
  saveAlertConfig,
  toOverlayConfig,
  type AlertConfig,
  type StoredTrigger,
} from './alert-config'
import { createFakeStore } from './fake-store'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

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

const 送られてきたトリガー = (overrides: Record<string, unknown> = {}) => ({
  event: REDEMPTION,
  conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }],
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
      triggers: [{ event: REDEMPTION, conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }], actions: [保存済みのアラートの動作] }],
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

  it('条件が1件もないトリガー（そのイベントならいつでも当てはまる）を受け付ける', () => {
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ conditions: [] })] }, 素材の種類)
    expect(config.triggers[0]).toMatchObject({ event: REDEMPTION, conditions: [] })
  })

  it('発言者・相手を絞る user の条件を受け付ける', () => {
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ conditions: [{ kind: 'user', login: 'tanenobu' }] })] }, 素材の種類)
    expect(config.triggers[0]?.conditions).toEqual([{ kind: 'user', login: 'tanenobu' }])
  })

  it('チャットの発言の文面を絞る text の条件を受け付ける', () => {
    const チャットのトリガー = { event: 'channel.chat.message', conditions: [{ kind: 'text', contains: 'おはよう' }], actions: [アラートの動作()] }
    const config = parseAlertConfig({ triggers: [チャットのトリガー] }, 素材の種類)

    expect(config.triggers[0]?.conditions).toEqual([{ kind: 'text', contains: 'おはよう' }])
  })

  it('チャットの発言以外のイベントに text の条件を付けたら拒否する', () => {
    const 文面を付けたフォロー = { triggers: [送られてきたトリガー({ event: 'channel.follow', conditions: [{ kind: 'text', contains: 'おはよう' }] })] }

    expect(() => parseAlertConfig(文面を付けたフォロー, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].conditions[0]: text の条件はチャットの発言にしか付けられません'] }),
    )
  })

  it('文面が空文字なら拒否する（すべての発言に当てはまってしまう）', () => {
    const 空の文面 = { triggers: [{ event: 'channel.chat.message', conditions: [{ kind: 'text', contains: '' }], actions: [アラートの動作()] }] }

    expect(() => parseAlertConfig(空の文面, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].conditions[0].contains: 1〜500文字の文字列で指定してください'] }),
    )
  })

  it('reward と user の報酬とユーザーの条件を並べたトリガーを受け付ける（すべてを満たしたときだけ当てはまる）', () => {
    const 報酬とユーザーの条件 = [
      { kind: 'reward', rewardId: '報酬ID-乾杯' },
      { kind: 'user', login: 'tanenobu' },
    ]
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ conditions: 報酬とユーザーの条件 })] }, 素材の種類)

    expect(config.triggers[0]?.conditions).toEqual(報酬とユーザーの条件)
  })

  it('conditions が配列でなければ拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ conditions: '報酬ID-乾杯' })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].conditions: 配列で指定してください'] }),
    )
  })

  it('対応していない条件の種類は拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ conditions: [{ kind: 'bits' }] })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].conditions[0].kind: reward / user / text のいずれかを指定してください'] }),
    )
  })

  it('同じ種類の条件が2件あれば拒否する', () => {
    const 重複 = {
      triggers: [
        送られてきたトリガー({
          conditions: [
            { kind: 'reward', rewardId: '報酬ID-乾杯' },
            { kind: 'reward', rewardId: '報酬ID-水' },
          ],
        }),
      ],
    }

    expect(() => parseAlertConfig(重複, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].conditions: 同じ種類の条件（reward）は1件までにしてください'] }),
    )
  })

  it('報酬IDが空文字なら拒否する（報酬を選んでいない）', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ conditions: [{ kind: 'reward', rewardId: '' }] })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: ['triggers[0].conditions[0].rewardId: 報酬IDの文字列で指定してください'] }),
    )
  })

  it('ユーザー名が空文字なら拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ conditions: [{ kind: 'user', login: '' }] })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: [`triggers[0].conditions[0].login: 1〜25文字のTwitchのユーザー名で指定してください`] }),
    )
  })

  it('チャンネルポイント交換以外のイベントに reward の条件を付けたら拒否する', () => {
    const 報酬を付けたフォロー = { triggers: [送られてきたトリガー({ event: 'channel.follow' })] }

    expect(() => parseAlertConfig(報酬を付けたフォロー, 素材の種類)).toThrowError(
      expect.objectContaining({
        problems: ['triggers[0].conditions[0]: reward の条件はチャンネルポイントの交換にしか付けられません'],
      }),
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

  it.each(['channel.follow', 'channel.subscribe', 'channel.subscription.message', 'channel.raid', 'channel.chat.message'])(
    'チャンネルポイント交換以外のイベント（%s）も、条件なしで受け付ける',
    (event) => {
      expect(parseAlertConfig({ triggers: [{ event, conditions: [], actions: [アラートの動作()] }] }, 素材の種類)).toEqual({
        triggers: [{ event, conditions: [], actions: [保存済みのアラートの動作] }],
      })
    },
  )

  it('対応していないイベントの種類は拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ event: 'channel.cheer' })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: [expect.stringContaining('triggers[0].event')] }),
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
      expect.objectContaining({ problems: ['triggers[0].actions[0].type: alert / chat / announce のいずれかを指定してください'] }),
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

describe('saveAlertConfig / loadAlertConfig', () => {
  const 保存用の設定: AlertConfig = {
    triggers: [{ event: REDEMPTION, conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }], actions: [保存済みのアラートの動作] }],
  }

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveAlertConfig(store, 保存用の設定)
    expect(await loadAlertConfig(store)).toEqual(保存用の設定)
  })

  it('まだ保存していなければ、トリガーなしの設定を返す', async () => {
    expect(await loadAlertConfig(createFakeStore())).toEqual(EMPTY_CONFIG)
  })

  it('条件をリストにする前の形（rewardId が直接ぶら下がる）で保存されていたら、黙って読み替えずにエラーにする', async () => {
    const store = createFakeStore()
    // 条件をリストにする前の保存内容。読み替えずにエラーにする（暗黙の読み替えを増やさない）
    const 旧形式 = { triggers: [{ event: REDEMPTION, rewardId: '報酬ID-乾杯', actions: [保存済みのアラートの動作] }] }
    await store.put('alert-config', JSON.stringify(旧形式))

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

describe('toOverlayConfig', () => {
  it('アラートを出す動作を、オーバーレイ用キー付きの素材のURLを持つ平坦な形に展開する（条件はそのまま渡す）', () => {
    const config: AlertConfig = {
      triggers: [{ event: REDEMPTION, conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }], actions: [保存済みのアラートの動作] }],
    }

    expect(toOverlayConfig(config, 'overlay-key_1')).toEqual({
      triggers: [
        {
          event: REDEMPTION,
          conditions: [{ kind: 'reward', rewardId: '報酬ID-乾杯' }],
          media: { kind: 'video', url: `/api/media/${encodeURIComponent('素材ID-乾杯の動画')}?key=overlay-key_1` },
          durationSeconds: 8,
          volume: 0.5,
          message: '{user} さん、乾杯！',
        },
      ],
    })
  })

  it('条件が1件もないトリガーも、空の条件のまま渡す', () => {
    const config: AlertConfig = {
      triggers: [{ event: 'channel.raid', conditions: [], actions: [{ ...保存済みのアラートの動作, message: '{user} さん、ありがとう！' }] }],
    }
    expect(toOverlayConfig(config, 'overlay-key_1').triggers[0]).toEqual({
      event: 'channel.raid',
      conditions: [],
      media: { kind: 'video', url: `/api/media/${encodeURIComponent('素材ID-乾杯の動画')}?key=overlay-key_1` },
      durationSeconds: 8,
      volume: 0.5,
      message: '{user} さん、ありがとう！',
    })
  })

  it('チャットに送るだけのトリガーはオーバーレイへ渡さない（オーバーレイに送信の役目はない）', () => {
    const config: AlertConfig = {
      triggers: [{ event: 'channel.follow', conditions: [], actions: [{ type: 'chat', message: 'フォローありがとうございます' }] }],
    }

    expect(toOverlayConfig(config, 'overlay-key_1').triggers).toEqual([])
  })
})

describe('announceActionOf', () => {
  it('トリガーからアナウンスを送る動作を取り出す', () => {
    const trigger: StoredTrigger = {
      event: 'channel.raid',
      conditions: [],
      actions: [保存済みのアラートの動作, { type: 'announce', message: '{user} さんがレイドしてくれました', color: 'purple' }],
    }

    expect(announceActionOf(trigger)).toEqual({ type: 'announce', message: '{user} さんがレイドしてくれました', color: 'purple' })
  })

  it('アナウンスを送る動作がなければ null を返す', () => {
    expect(announceActionOf({ event: 'channel.raid', conditions: [], actions: [保存済みのアラートの動作] })).toBeNull()
  })
})

describe('chatActionOf', () => {
  it('トリガーからチャットに送る動作を取り出す', () => {
    const trigger: StoredTrigger = {
      event: 'channel.follow',
      conditions: [],
      actions: [保存済みのアラートの動作, { type: 'chat', message: 'フォローありがとうございます' }],
    }

    expect(chatActionOf(trigger)).toEqual({ type: 'chat', message: 'フォローありがとうございます' })
  })

  it('チャットに送る動作がなければ null を返す', () => {
    expect(chatActionOf({ event: 'channel.follow', conditions: [], actions: [保存済みのアラートの動作] })).toBeNull()
  })
})
