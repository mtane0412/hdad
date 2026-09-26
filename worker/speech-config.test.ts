/**
 * チャットの読み上げの設定（speech-config.ts）のテスト
 *
 * 管理画面から送られてきた内容を検証して保存する。特に重要なのは次の3点。
 * - 問題点を最初の1件で止めず、すべて集めてから拒否すること（管理画面で一度に直せるようにするため）
 * - ホストをループバック（localhost・127.0.0.1）の2つに限ること（ブラウザが混在コンテンツを許すのはそこだけのため）
 * - 未保存なら既定の設定で動くこと（保存していない配信者の読み上げを止めないため）
 */
import { describe, expect, it } from 'vitest'
import { createFakeStore } from './fake-store'
import { DEFAULT_SPEECH_SETTINGS, loadSpeechSettings, parseSpeechSettings, saveSpeechSettings, type SpeechSettings } from './speech-config'

/** 配信者が画面で組み立てた、既定とは違う設定 */
const 配信者の設定: SpeechSettings = {
  host: '127.0.0.1',
  port: 50022,
  speaker: 8,
  speed: 1.2,
  volume: 0.8,
  maxLength: 80,
  readName: true,
  ignoreLogins: ['hdad_bot', 'nightbot'],
}

/** 既定の設定に、変えたい項目だけを上書きしたものを送る */
const 送る = (上書き: Record<string, unknown> = {}): unknown => ({ ...DEFAULT_SPEECH_SETTINGS, ...上書き })

/** 検証で見つかった問題点の一覧を取り出す */
const 問題点 = (input: unknown): readonly string[] => {
  try {
    parseSpeechSettings(input)
  } catch (error) {
    return (error as { problems: readonly string[] }).problems
  }
  throw new Error('検証が通ってしまいました')
}

describe('parseSpeechSettings', () => {
  it('正しい内容はそのまま保存用の形にする', () => {
    expect(parseSpeechSettings(配信者の設定)).toEqual(配信者の設定)
  })

  it('既定の設定もそのまま通る', () => {
    expect(parseSpeechSettings(送る())).toEqual(DEFAULT_SPEECH_SETTINGS)
  })

  it('オブジェクトでなければ拒否する', () => {
    expect(問題点('読み上げの設定')).toEqual([expect.stringContaining('オブジェクト')])
  })

  it('ホストがループバック以外なら拒否する（ブラウザが混在コンテンツを許すのはループバックだけのため）', () => {
    expect(問題点(送る({ host: 'example.com' }))).toEqual([expect.stringContaining('host')])
  })

  it('ポート番号が範囲の外なら拒否する', () => {
    expect(問題点(送る({ port: 0 }))).toEqual([expect.stringContaining('port')])
    expect(問題点(送る({ port: 65536 }))).toEqual([expect.stringContaining('port')])
  })

  it('話者IDが整数でなければ拒否する', () => {
    expect(問題点(送る({ speaker: 1.5 }))).toEqual([expect.stringContaining('speaker')])
  })

  it('読み上げ速度が範囲の外なら拒否する', () => {
    expect(問題点(送る({ speed: 0.4 }))).toEqual([expect.stringContaining('speed')])
    expect(問題点(送る({ speed: 2.1 }))).toEqual([expect.stringContaining('speed')])
  })

  it('音量が範囲の外なら拒否する', () => {
    expect(問題点(送る({ volume: 1.5 }))).toEqual([expect.stringContaining('volume')])
  })

  it('読み上げる長さが範囲の外なら拒否する', () => {
    expect(問題点(送る({ maxLength: 0 }))).toEqual([expect.stringContaining('maxLength')])
    expect(問題点(送る({ maxLength: 201 }))).toEqual([expect.stringContaining('maxLength')])
  })

  it('名前を読むかが真偽値でなければ拒否する', () => {
    expect(問題点(送る({ readName: 'true' }))).toEqual([expect.stringContaining('readName')])
  })

  it('読み上げない人が配列でなければ拒否する', () => {
    expect(問題点(送る({ ignoreLogins: 'hdad_bot' }))).toEqual([expect.stringContaining('ignoreLogins')])
  })

  it('読み上げない人にTwitchのログイン名でないものがあれば、その位置を示して拒否する', () => {
    expect(問題点(送る({ ignoreLogins: ['hdad_bot', 'ずんだもん'] }))).toEqual([expect.stringContaining('ignoreLogins[1]')])
  })

  it('読み上げない人が重なっていれば拒否する（大文字小文字は区別しない）', () => {
    expect(問題点(送る({ ignoreLogins: ['hdad_bot', 'HDAD_BOT'] }))).toEqual([expect.stringContaining('ignoreLogins[1]')])
  })

  it('問題点は最初の1件で止めず、すべて集めてから拒否する（管理画面で一度に直せるようにするため）', () => {
    expect(問題点(送る({ port: 0, speed: 3, volume: 2 }))).toHaveLength(3)
  })
})

describe('loadSpeechSettings・saveSpeechSettings', () => {
  it('保存した設定をそのまま読み出せる', async () => {
    const store = createFakeStore()

    await saveSpeechSettings(store, 配信者の設定)

    expect(await loadSpeechSettings(store)).toEqual(配信者の設定)
  })

  it('未保存なら既定の設定を返す（保存していない配信者の読み上げを止めない）', async () => {
    expect(await loadSpeechSettings(createFakeStore())).toEqual(DEFAULT_SPEECH_SETTINGS)
  })
})
