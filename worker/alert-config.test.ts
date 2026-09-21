/**
 * アラートの設定（alert-config.ts）のテスト
 *
 * 管理画面から送られてくる設定を検証して保存用の形にすること、オーバーレイ向けに素材のURLを付けた形へ変換することを確認する。
 * 不正な設定を保存してしまうと配信中にアラートが出なくなるため、保存の前にすべての問題点を挙げて拒否する。
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_CONFIG, loadAlertConfig, parseAlertConfig, saveAlertConfig, toOverlayConfig, type AlertConfig } from './alert-config'
import { createFakeStore } from './fake-store'

const REDEMPTION = 'channel.channel_points_custom_reward_redemption.add'

const 送られてきたトリガー = (overrides: Record<string, unknown> = {}) => ({
  event: REDEMPTION,
  rewardId: '報酬ID-乾杯',
  mediaId: '素材ID-乾杯の動画',
  durationSeconds: 8,
  volume: 0.5,
  message: '{user} さん、乾杯！',
  ...overrides,
})

/** 素材IDから種類を引く関数の代役。知らないIDは null（素材が存在しない） */
const 素材の種類 = (mediaId: string) => (mediaId === '素材ID-乾杯の動画' ? 'video' : null)

describe('parseAlertConfig', () => {
  it('正しい設定は、素材の種類を書き足した保存用の形になる', () => {
    expect(parseAlertConfig({ triggers: [送られてきたトリガー()] }, 素材の種類)).toEqual({
      triggers: [{ ...送られてきたトリガー(), mediaKind: 'video' }],
    })
  })

  it('報酬IDが null のトリガー（すべての報酬が対象）を受け付ける', () => {
    const config = parseAlertConfig({ triggers: [送られてきたトリガー({ rewardId: null })] }, 素材の種類)
    expect(config.triggers[0]?.rewardId).toBeNull()
  })

  it('トリガーが1件もない設定を受け付ける（アラートをすべて止めたいとき）', () => {
    expect(parseAlertConfig({ triggers: [] }, 素材の種類)).toEqual(EMPTY_CONFIG)
  })

  it('問題のある項目は、何件目のどの項目かを示してすべて挙げる', () => {
    const broken = {
      triggers: [
        送られてきたトリガー(),
        送られてきたトリガー({ durationSeconds: 0, volume: 1.5, mediaId: '削除済みの素材ID', message: 123 }),
      ],
    }
    expect(() => parseAlertConfig(broken, 素材の種類)).toThrowError(
      expect.objectContaining({
        problems: [
          'triggers[1].mediaId: 素材「削除済みの素材ID」が存在しません',
          'triggers[1].durationSeconds: 1〜60 の数値で指定してください',
          'triggers[1].volume: 0〜1 の数値で指定してください',
          'triggers[1].message: 200文字以内の文字列で指定してください',
        ],
      }),
    )
  })

  it('対応していないイベントの種類は拒否する', () => {
    expect(() => parseAlertConfig({ triggers: [送られてきたトリガー({ event: 'channel.follow' })] }, 素材の種類)).toThrowError(
      expect.objectContaining({ problems: [expect.stringContaining('triggers[0].event')] }),
    )
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
  const 保存用の設定: AlertConfig = { triggers: [{ ...送られてきたトリガー(), event: REDEMPTION, mediaKind: 'video' }] }

  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveAlertConfig(store, 保存用の設定)
    expect(await loadAlertConfig(store)).toEqual(保存用の設定)
  })

  it('まだ保存していなければ、トリガーなしの設定を返す', async () => {
    expect(await loadAlertConfig(createFakeStore())).toEqual(EMPTY_CONFIG)
  })
})

describe('toOverlayConfig', () => {
  it('素材IDを、オーバーレイ用キー付きの素材のURLに置き換える', () => {
    const config: AlertConfig = { triggers: [{ ...送られてきたトリガー(), event: REDEMPTION, mediaKind: 'video' }] }
    expect(toOverlayConfig(config, 'overlay-key_1')).toEqual({
      triggers: [
        {
          event: REDEMPTION,
          rewardId: '報酬ID-乾杯',
          media: { kind: 'video', url: `/api/media/${encodeURIComponent('素材ID-乾杯の動画')}?key=overlay-key_1` },
          durationSeconds: 8,
          volume: 0.5,
          message: '{user} さん、乾杯！',
        },
      ],
    })
  })
})
