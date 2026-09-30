/**
 * 画面取り込みの設定（worker/screen-config.ts）のテスト
 *
 * 確かめるのは次の4点である。
 * - 未保存のときに既定の設定が返ること（配信者が何も入力しなくても裏方が動き出せること）
 * - 問題点を最初の1件で止めず、すべて集めてから拒むこと（管理画面で一度に直せるようにするため）
 * - ホストをループバックの2つに限ること（ブラウザが ws:// への通信を許すのがそこだけであるため）
 * - パスワードが空であることを許すこと（obs-websocket の認証を切った運用を拒まないため）
 * - コレクションIDが空であることを許し、形が違うものは拒むこと（Gyazo が受け取れないIDを保存しないため）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import { DEFAULT_SCREEN_SETTINGS, loadScreenSettings, parseScreenSettings, saveScreenSettings, type ScreenSettings } from './screen-config'

const validConfig: ScreenSettings = {
  host: 'localhost',
  port: 4455,
  password: 'obsのパスワード',
  intervalSeconds: 60,
  collectionId: 'f19e74cebe47c9cadad31b6790098eac',
}

describe('parseScreenSettings', () => {
  it('正しい設定をそのまま受け取る', () => {
    expect(parseScreenSettings(validConfig)).toEqual(validConfig)
  })

  it('パスワードが空でも受け取る（obs-websocket の認証を切った運用を拒まない）', () => {
    expect(parseScreenSettings({ ...validConfig, password: '' }).password).toBe('')
  })

  it('コレクションIDが空でも受け取る（コレクションに入れない運用を拒まない）', () => {
    expect(parseScreenSettings({ ...validConfig, collectionId: '' }).collectionId).toBe('')
  })

  it('コレクションIDの形が違えば拒む（Gyazo が受け取れないIDを保存しない）', () => {
    expect(() => parseScreenSettings({ ...validConfig, collectionId: 'https://gyazo.com/collections/f19e74cebe47c9cadad31b6790098eac' })).toThrow(
      /collectionId:/,
    )
    expect(() => parseScreenSettings({ ...validConfig, collectionId: 'みじかすぎるID' })).toThrow(/collectionId:/)
  })

  it('オブジェクトでなければ拒む', () => {
    expect(() => parseScreenSettings('設定ではない文字列')).toThrow(ConfigError)
  })

  it('ループバック以外のホストを拒む', () => {
    expect(() => parseScreenSettings({ ...validConfig, host: 'obs.example.com' })).toThrow(/host:/)
  })

  it('問題点をすべて集めてから拒む', () => {
    let caughtError: ConfigError | null = null
    try {
      parseScreenSettings({ host: 'obs.example.com', port: 0, password: 42, intervalSeconds: 1, collectionId: 42 })
    } catch (error) {
      caughtError = error as ConfigError
    }
    expect(caughtError).toBeInstanceOf(ConfigError)
    expect(caughtError?.problems).toHaveLength(5)
  })

  it('撮影間隔が短すぎるものを拒む（OBSの負荷を上げすぎないため）', () => {
    expect(() => parseScreenSettings({ ...validConfig, intervalSeconds: 1 })).toThrow(/intervalSeconds:/)
  })
})

describe('loadScreenSettings', () => {
  it('未保存なら既定の設定を返す', async () => {
    expect(await loadScreenSettings(createFakeStore())).toEqual(DEFAULT_SCREEN_SETTINGS)
  })

  it('保存した設定を読み出す', async () => {
    const store = createFakeStore()
    await saveScreenSettings(store, validConfig)
    expect(await loadScreenSettings(store)).toEqual(validConfig)
  })

  it('コレクションの項目を足す前に保存した設定も読める（足りない項目は既定で埋める）', async () => {
    const previouslySaved = { host: 'localhost', port: 4455, password: 'obsのパスワード', intervalSeconds: 60 }
    const store = createFakeStore({ 'screen-settings': JSON.stringify(previouslySaved) })

    expect(await loadScreenSettings(store)).toEqual({ ...previouslySaved, collectionId: '' })
  })
})
