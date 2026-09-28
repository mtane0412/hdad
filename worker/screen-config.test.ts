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

const 正しい設定: ScreenSettings = {
  host: 'localhost',
  port: 4455,
  password: 'obsのパスワード',
  intervalSeconds: 60,
  collectionId: 'f19e74cebe47c9cadad31b6790098eac',
}

describe('parseScreenSettings', () => {
  it('正しい設定をそのまま受け取る', () => {
    expect(parseScreenSettings(正しい設定)).toEqual(正しい設定)
  })

  it('パスワードが空でも受け取る（obs-websocket の認証を切った運用を拒まない）', () => {
    expect(parseScreenSettings({ ...正しい設定, password: '' }).password).toBe('')
  })

  it('コレクションIDが空でも受け取る（コレクションに入れない運用を拒まない）', () => {
    expect(parseScreenSettings({ ...正しい設定, collectionId: '' }).collectionId).toBe('')
  })

  it('コレクションIDの形が違えば拒む（Gyazo が受け取れないIDを保存しない）', () => {
    expect(() => parseScreenSettings({ ...正しい設定, collectionId: 'https://gyazo.com/collections/f19e74cebe47c9cadad31b6790098eac' })).toThrow(
      /collectionId:/,
    )
    expect(() => parseScreenSettings({ ...正しい設定, collectionId: 'みじかすぎるID' })).toThrow(/collectionId:/)
  })

  it('オブジェクトでなければ拒む', () => {
    expect(() => parseScreenSettings('設定ではない文字列')).toThrow(ConfigError)
  })

  it('ループバック以外のホストを拒む', () => {
    expect(() => parseScreenSettings({ ...正しい設定, host: 'obs.example.com' })).toThrow(/host:/)
  })

  it('問題点をすべて集めてから拒む', () => {
    let 捕まえたエラー: ConfigError | null = null
    try {
      parseScreenSettings({ host: 'obs.example.com', port: 0, password: 42, intervalSeconds: 1, collectionId: 42 })
    } catch (error) {
      捕まえたエラー = error as ConfigError
    }
    expect(捕まえたエラー).toBeInstanceOf(ConfigError)
    expect(捕まえたエラー?.problems).toHaveLength(5)
  })

  it('撮影間隔が短すぎるものを拒む（OBSの負荷を上げすぎないため）', () => {
    expect(() => parseScreenSettings({ ...正しい設定, intervalSeconds: 1 })).toThrow(/intervalSeconds:/)
  })
})

describe('loadScreenSettings', () => {
  it('未保存なら既定の設定を返す', async () => {
    expect(await loadScreenSettings(createFakeStore())).toEqual(DEFAULT_SCREEN_SETTINGS)
  })

  it('保存した設定を読み出す', async () => {
    const store = createFakeStore()
    await saveScreenSettings(store, 正しい設定)
    expect(await loadScreenSettings(store)).toEqual(正しい設定)
  })

  it('コレクションの項目を足す前に保存した設定も読める（足りない項目は既定で埋める）', async () => {
    const 前に保存したもの = { host: 'localhost', port: 4455, password: 'obsのパスワード', intervalSeconds: 60 }
    const store = createFakeStore({ 'screen-settings': JSON.stringify(前に保存したもの) })

    expect(await loadScreenSettings(store)).toEqual({ ...前に保存したもの, collectionId: '' })
  })
})
