/**
 * 画面取り込みの設定（worker/screen-config.ts）のテスト
 *
 * 確かめるのは次の4点である。
 * - 未保存のときに既定の設定が返ること（配信者が何も入力しなくても裏方が動き出せること）
 * - 問題点を最初の1件で止めず、すべて集めてから拒むこと（管理画面で一度に直せるようにするため）
 * - ホストをループバックの2つに限ること（ブラウザが ws:// への通信を許すのがそこだけであるため）
 * - パスワードが空であることを許すこと（obs-websocket の認証を切った運用を拒まないため）
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
}

describe('parseScreenSettings', () => {
  it('正しい設定をそのまま受け取る', () => {
    expect(parseScreenSettings(正しい設定)).toEqual(正しい設定)
  })

  it('パスワードが空でも受け取る（obs-websocket の認証を切った運用を拒まない）', () => {
    expect(parseScreenSettings({ ...正しい設定, password: '' }).password).toBe('')
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
      parseScreenSettings({ host: 'obs.example.com', port: 0, password: 42, intervalSeconds: 1 })
    } catch (error) {
      捕まえたエラー = error as ConfigError
    }
    expect(捕まえたエラー).toBeInstanceOf(ConfigError)
    expect(捕まえたエラー?.problems).toHaveLength(4)
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
})
