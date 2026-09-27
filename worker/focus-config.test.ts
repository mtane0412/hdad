/**
 * 注目コメントの設定（focus-config.ts）のテスト
 *
 * 管理画面から送られてきた「いま取り上げているもの」を検証して保存する。特に重要なのは次の4点。
 * - 取り上げ方が2通り（人に追従する・発言1件を取り上げる）あり、どちらも同じ保存先で表せること
 * - 取り上げていない状態（null）を保存できること（配信中に外す操作があるため）
 * - ログイン名を小文字に直して保存すること（IRCで届くログイン名との照合は大文字小文字を区別しないため）
 * - 問題点を最初の1件で止めず、すべて集めてから拒否すること（管理画面で一度に直せるようにするため）
 */
import { describe, expect, it } from 'vitest'
import { createFakeStore } from './fake-store'
import { loadFocusTarget, MAX_FOCUS_TEXT_LENGTH, parseFocusTarget, saveFocusTarget, type FocusTarget } from './focus-config'

/** 怖い話を始めた視聴者に追従する指定 */
const 追従の指定: FocusTarget = { type: 'viewer', login: 'kowai_hanashi' }

/** 雑談の題に取り上げる発言1件の指定 */
const 取り上げの指定: FocusTarget = {
  type: 'message',
  messageId: '9f1a6b4c-0000-4000-8000-000000000001',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
}

/** 検証で見つかった問題点の一覧を取り出す */
const 問題点 = (input: unknown): readonly string[] => {
  try {
    parseFocusTarget(input)
  } catch (error) {
    return (error as { problems: readonly string[] }).problems
  }
  throw new Error('検証が通ってしまいました')
}

describe('parseFocusTarget', () => {
  it('人に追従する指定をそのまま保存用の形にする', () => {
    expect(parseFocusTarget({ target: 追従の指定 })).toEqual(追従の指定)
  })

  it('発言1件を取り上げる指定をそのまま保存用の形にする', () => {
    expect(parseFocusTarget({ target: 取り上げの指定 })).toEqual(取り上げの指定)
  })

  it('取り上げていない状態（null）を受け付ける', () => {
    expect(parseFocusTarget({ target: null })).toBeNull()
  })

  it('ログイン名を小文字に直す（IRCで届くログイン名との照合は大文字小文字を区別しないため）', () => {
    expect(parseFocusTarget({ target: { type: 'viewer', login: 'Kowai_Hanashi' } })).toEqual({
      type: 'viewer',
      login: 'kowai_hanashi',
    })
  })

  it('オブジェクトでなければ拒否する', () => {
    expect(問題点('怖い話す人')).toEqual([expect.stringContaining('オブジェクト')])
  })

  it('target がオブジェクトでも null でもなければ拒否する', () => {
    expect(問題点({ target: 'kowai_hanashi' })).toEqual([expect.stringContaining('target')])
  })

  it('取り上げ方の種類が分からなければ拒否する', () => {
    expect(問題点({ target: { type: 'stalker', login: 'kowai_hanashi' } })).toEqual([expect.stringContaining('type')])
  })

  it('ログイン名として読めないものを拒否する', () => {
    expect(問題点({ target: { type: 'viewer', login: '怖い話す人' } })).toEqual([expect.stringContaining('login')])
    expect(問題点({ target: { type: 'viewer', login: '' } })).toEqual([expect.stringContaining('login')])
  })

  it('取り上げる発言の項目が欠けていれば、問題点をすべて挙げて拒否する', () => {
    expect(問題点({ target: { type: 'message' } })).toEqual([
      expect.stringContaining('messageId'),
      expect.stringContaining('login'),
      expect.stringContaining('displayName'),
      expect.stringContaining('text'),
    ])
  })

  it('取り上げる本文が上限を超えていれば拒否する（配信画面に収まらない量を映さないため）', () => {
    const 長い本文 = 'あ'.repeat(MAX_FOCUS_TEXT_LENGTH + 1)
    expect(問題点({ target: { ...取り上げの指定, text: 長い本文 } })).toEqual([expect.stringContaining('text')])
  })

  it('取り上げる本文が空なら拒否する（何も映らないものを取り上げさせない）', () => {
    expect(問題点({ target: { ...取り上げの指定, text: '' } })).toEqual([expect.stringContaining('text')])
  })
})

describe('saveFocusTarget と loadFocusTarget', () => {
  it('保存した指定をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveFocusTarget(store, 取り上げの指定)
    expect(await loadFocusTarget(store)).toEqual(取り上げの指定)
  })

  it('取り上げていない状態も保存できる（配信中に外す操作があるため）', async () => {
    const store = createFakeStore()
    await saveFocusTarget(store, 追従の指定)
    await saveFocusTarget(store, null)
    expect(await loadFocusTarget(store)).toBeNull()
  })

  it('一度も保存していなければ、取り上げていない状態として読む', async () => {
    expect(await loadFocusTarget(createFakeStore())).toBeNull()
  })
})
