/**
 * ポモドーロの設定（pomodoro-config.ts）のテスト
 *
 * 配信者が決めるのは「休憩中に流す曲」だけである（作業と休憩の長さは決め切っている）。
 * 曲は BGM の一覧にあるものしか選べないこと、選ばない（null）こともできること、未保存なら切り替えないことを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeStore } from './fake-store'
import { DEFAULT_POMODORO_SETTINGS, loadPomodoroSettings, parsePomodoroSettings, savePomodoroSettings } from './pomodoro-config'

/** BGMの一覧にある曲の素材のID */
const trackMediaIds = ['media-作業用ピアノ', 'media-休憩のカフェ']

describe('parsePomodoroSettings', () => {
  it('BGMの一覧にある曲を、休憩中に流す曲として受け取る', () => {
    expect(parsePomodoroSettings({ breakMediaId: 'media-休憩のカフェ' }, trackMediaIds)).toEqual({ breakMediaId: 'media-休憩のカフェ' })
  })

  it('null なら休憩中も曲を変えない', () => {
    expect(parsePomodoroSettings({ breakMediaId: null }, trackMediaIds)).toEqual({ breakMediaId: null })
  })

  it('BGMの一覧に無い曲は拒む（休憩に入ったときに流せないと分かっている曲を保存させない）', () => {
    expect(() => parsePomodoroSettings({ breakMediaId: 'media-消した曲' }, trackMediaIds)).toThrow(ConfigError)
  })

  it('形が違えば拒む', () => {
    expect(() => parsePomodoroSettings({}, trackMediaIds)).toThrow(ConfigError)
    expect(() => parsePomodoroSettings(null, trackMediaIds)).toThrow(ConfigError)
  })
})

describe('ポモドーロの設定の保存と読み出し', () => {
  it('未保存なら、休憩中も曲を変えない', async () => {
    expect(DEFAULT_POMODORO_SETTINGS).toEqual({ breakMediaId: null })
    expect(await loadPomodoroSettings(createFakeStore())).toEqual({ breakMediaId: null })
  })

  it('保存した設定を読み出せる', async () => {
    const store = createFakeStore()
    await savePomodoroSettings(store, { breakMediaId: 'media-休憩のカフェ' })
    expect(await loadPomodoroSettings(store)).toEqual({ breakMediaId: 'media-休憩のカフェ' })
  })
})
