/**
 * 注目コメントの設定（focus-config.ts）のテスト
 *
 * 管理画面から送られてきた「いま取り上げている発言1件」を検証して保存する。特に重要なのは次の4点。
 * - 取り上げていない状態（null）を保存できること（配信中に外す操作があるため）
 * - ログイン名を小文字に直して保存すること（モデレーターの操作との照合は大文字小文字を区別しないため）
 * - アイコンのURLは管理画面から受け取らないこと（Worker がTwitchから引いて添える）
 * - 問題点を最初の1件で止めず、すべて集めてから拒否すること（管理画面で一度に直せるようにするため）
 */
import { describe, expect, it } from 'vitest'
import { createFakeStore } from './fake-store'
import { loadFocusTarget, MAX_FOCUS_TEXT_LENGTH, parseFocusPick, saveFocusTarget, type FocusPick, type FocusTarget } from './focus-config'

/** 雑談の題に取り上げる発言1件（管理画面が送る形） */
const chatToFocus: FocusPick = {
  messageId: '9f1a6b4c-0000-4000-8000-000000000001',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
}

/** 保存する形（Worker がアイコンのURLを添えたもの） */
const contentToSave: FocusTarget = {
  ...chatToFocus,
  profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/kowai_hanashi-profile_image-300x300.png',
}

/** 検証で見つかった問題点の一覧を取り出す */
const issues = (input: unknown): readonly string[] => {
  try {
    parseFocusPick(input)
  } catch (error) {
    return (error as { problems: readonly string[] }).problems
  }
  throw new Error('検証が通ってしまいました')
}

describe('parseFocusPick', () => {
  it('取り上げる発言をそのまま検証済みの形にする', () => {
    expect(parseFocusPick({ target: chatToFocus })).toEqual(chatToFocus)
  })

  it('取り上げていない状態（null）を受け付ける', () => {
    expect(parseFocusPick({ target: null })).toBeNull()
  })

  it('ログイン名を小文字に直す（モデレーターの操作との照合は大文字小文字を区別しないため）', () => {
    expect(parseFocusPick({ target: { ...chatToFocus, login: 'Kowai_Hanashi' } })).toEqual(chatToFocus)
  })

  it('アイコンのURLを送られても受け取らない（Twitchから引いたものだけを映すため）', () => {
    expect(parseFocusPick({ target: { ...chatToFocus, profileImageUrl: 'https://evil.example.com/icon.png' } })).toEqual(chatToFocus)
  })

  it('オブジェクトでなければ拒否する', () => {
    expect(issues('怖い話す人')).toEqual([expect.stringContaining('オブジェクト')])
  })

  it('target がオブジェクトでも null でもなければ拒否する', () => {
    expect(issues({ target: 'kowai_hanashi' })).toEqual([expect.stringContaining('target')])
  })

  it('ログイン名として読めないものを拒否する', () => {
    expect(issues({ target: { ...chatToFocus, login: '怖い話す人' } })).toEqual([expect.stringContaining('login')])
  })

  it('項目が欠けていれば、問題点をすべて挙げて拒否する', () => {
    expect(issues({ target: {} })).toEqual([
      expect.stringContaining('messageId'),
      expect.stringContaining('login'),
      expect.stringContaining('displayName'),
      expect.stringContaining('text'),
    ])
  })

  it('本文が上限を超えていれば拒否する（配信画面に収まらない量を映さないため）', () => {
    const longBody = 'あ'.repeat(MAX_FOCUS_TEXT_LENGTH + 1)
    expect(issues({ target: { ...chatToFocus, text: longBody } })).toEqual([expect.stringContaining('text')])
  })

  it('絵文字を含む本文も、見た目の文字数で数える（サロゲートペアを2文字と数えて、上限内の発言を拒まない）', () => {
    // 「🎃」は UTF-16 では2単位ぶんを占めるため、単位で数えると上限を超えたと誤って判定される
    const maxLengthBody = '🎃'.repeat(MAX_FOCUS_TEXT_LENGTH)

    expect(parseFocusPick({ target: { ...chatToFocus, text: maxLengthBody } })).toEqual({
      ...chatToFocus,
      text: maxLengthBody,
    })
  })

  it('絵文字を含む本文でも、見た目の文字数が上限を超えていれば拒否する', () => {
    expect(issues({ target: { ...chatToFocus, text: '🎃'.repeat(MAX_FOCUS_TEXT_LENGTH + 1) } })).toEqual([expect.stringContaining('text')])
  })

  it('本文が空なら拒否する（何も映らないものを取り上げさせない）', () => {
    expect(issues({ target: { ...chatToFocus, text: '' } })).toEqual([expect.stringContaining('text')])
  })
})

describe('saveFocusTarget と loadFocusTarget', () => {
  it('保存した中身をそのまま読み出せる', async () => {
    const store = createFakeStore()
    await saveFocusTarget(store, contentToSave)
    expect(await loadFocusTarget(store)).toEqual(contentToSave)
  })

  it('取り上げていない状態も保存できる（配信中に外す操作があるため）', async () => {
    const store = createFakeStore()
    await saveFocusTarget(store, contentToSave)
    await saveFocusTarget(store, null)
    expect(await loadFocusTarget(store)).toBeNull()
  })

  it('一度も保存していなければ、取り上げていない状態として読む', async () => {
    expect(await loadFocusTarget(createFakeStore())).toBeNull()
  })

  it('人に追従していたころの保存（focus-target）は読まない（追従をやめたので、映せる形で残っていないため）', async () => {
    const store = createFakeStore({ 'focus-target': JSON.stringify({ target: { type: 'viewer', login: 'kowai_hanashi' } }) })
    expect(await loadFocusTarget(store)).toBeNull()
  })
})
