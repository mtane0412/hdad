/**
 * 自動モデレーションの設定（moderation-config.ts）のテスト
 *
 * 管理画面から送られてきた値を検証し、保存できる形にするところまでを確かめる。
 * 特に重要なのは次の2点。
 * - 未保存のときの既定が「無効・除外はすべて有効」であること（誤って視聴者を処分しないため）
 * - 問題点を最初の1件で止めず、すべて集めて返すこと（管理画面で一度に直せるようにするため）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import { DEFAULT_MODERATION_CONFIG, loadModerationConfig, parseModerationConfig, saveModerationConfig } from './moderation-config'

/** 検証を通る、いちばん簡単な設定 */
const 正しい設定 = {
  enabled: true,
  exemptBroadcaster: true,
  exemptVip: true,
  exemptSubscriber: false,
  rules: [{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }],
}

/** 検証で集まった問題点。ConfigError でなければテストを失敗させる */
const 問題点 = (input: unknown): readonly string[] => {
  try {
    parseModerationConfig(input)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  throw new Error('検証を通ってしまいました（問題点が集まるはずです）')
}

describe('parseModerationConfig', () => {
  it('正しい設定はそのまま保存の形になる', () => {
    expect(parseModerationConfig(正しい設定)).toEqual(正しい設定)
  })

  it('タイムアウト・BAN・URL・連投のルールも受け付ける', () => {
    const input = {
      ...正しい設定,
      rules: [
        { kind: 'url', punishment: { type: 'timeout', durationSeconds: 600 } },
        { kind: 'repeat', count: 5, windowSeconds: 30, punishment: { type: 'ban' } },
      ],
    }

    expect(parseModerationConfig(input).rules).toEqual(input.rules)
  })

  it('rules が配列でなければ拒否する', () => {
    expect(問題点({ ...正しい設定, rules: 'なし' })).toEqual(['rules: 配列で指定してください'])
  })

  it('有効・除外の指定が真偽値でなければ、すべての問題点を集めて拒否する', () => {
    const problems = 問題点({ ...正しい設定, enabled: 'はい', exemptVip: 1 })

    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('enabled')
    expect(problems[1]).toContain('exemptVip')
  })

  it('禁止語が空文字なら拒否する（すべての発言に当たってしまうため）', () => {
    const problems = 問題点({ ...正しい設定, rules: [{ kind: 'word', word: '', punishment: { type: 'delete' } }] })

    expect(problems).toEqual([expect.stringContaining('rules[0].word')])
  })

  it('知らない種類のルールは拒否する', () => {
    const problems = 問題点({ ...正しい設定, rules: [{ kind: 'regexp', pattern: '.*', punishment: { type: 'ban' } }] })

    expect(problems).toEqual([expect.stringContaining('rules[0].kind')])
  })

  it('知らない種類の処分は拒否する', () => {
    const problems = 問題点({ ...正しい設定, rules: [{ kind: 'url', punishment: { type: 'warn' } }] })

    expect(problems).toEqual([expect.stringContaining('rules[0].punishment')])
  })

  it('タイムアウトの秒数が範囲の外なら拒否する（Twitchが受け付けるのは1〜604800秒）', () => {
    const problems = 問題点({ ...正しい設定, rules: [{ kind: 'url', punishment: { type: 'timeout', durationSeconds: 604801 } }] })

    expect(problems).toEqual([expect.stringContaining('rules[0].punishment.durationSeconds')])
  })

  it('連投の回数と秒数が範囲の外なら、どちらも問題点として集める', () => {
    const problems = 問題点({ ...正しい設定, rules: [{ kind: 'repeat', count: 1, windowSeconds: 900, punishment: { type: 'delete' } }] })

    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('rules[0].count')
    expect(problems[1]).toContain('rules[0].windowSeconds')
  })

  it('連投のルールを2件以上は登録できない（数える窓が1つに定まらなくなるため）', () => {
    const problems = 問題点({
      ...正しい設定,
      rules: [
        { kind: 'repeat', count: 3, windowSeconds: 30, punishment: { type: 'delete' } },
        { kind: 'repeat', count: 5, windowSeconds: 60, punishment: { type: 'ban' } },
      ],
    })

    expect(problems).toEqual([expect.stringContaining('rules[1]')])
  })
})

describe('saveModerationConfig・loadModerationConfig', () => {
  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    const config = parseModerationConfig(正しい設定)

    await saveModerationConfig(store, config)

    expect(await loadModerationConfig(store)).toEqual(config)
  })

  it('未保存なら、無効で除外がすべて有効な既定の設定を返す', async () => {
    const store = createFakeStore()

    expect(await loadModerationConfig(store)).toEqual(DEFAULT_MODERATION_CONFIG)
  })

  it('既定の設定は無効で、除外はすべて有効', () => {
    expect(DEFAULT_MODERATION_CONFIG).toEqual({
      enabled: false,
      exemptBroadcaster: true,
      exemptVip: true,
      exemptSubscriber: true,
      rules: [],
    })
  })
})
