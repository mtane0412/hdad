/**
 * 注目コメントで「いま何を映すか」を決める部分（focused.ts）のテスト
 *
 * オーバーレイは2つの入口から状態を受け取る。取り上げている発言1件（Workerから定期的に読む）と、
 * 匿名IRCで届くモデレーターの操作である。通信もDOMも持ち込まない形に切り出してあるので、
 * ここでは組み合わせだけを確かめる。特に重要なのは次の3点。
 * - 取り上げている1件を読んだら、その1件を映すこと
 * - 同じ1件を読み直しても、映しているものを作り直さないこと（10秒ごとに読むため）
 * - モデレーターに消された発言を映し続けないこと（配信画面に残ると取り返しがつかない）
 */
import { describe, expect, it } from 'vitest'
import { NO_FOCUS, withRemoval, withTarget, type FocusTarget } from './focused'

/** 雑談の題に取り上げた発言1件 */
const focusedChat: FocusTarget = {
  messageId: '発言1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
  profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/kowai_hanashi.png',
}

/** 別の人の発言1件 */
const otherChat: FocusTarget = {
  messageId: '発言2',
  login: 'zatsudan_suki',
  displayName: '雑談好き',
  text: 'キーボードは結局どれを買ったんですか？',
  profileImageUrl: 'https://static-cdn.jtvnw.net/jtv_user_pictures/zatsudan_suki.png',
}

describe('withTarget（取り上げているものを読み直した）', () => {
  it('取り上げている1件を読んだら、その1件を映す', () => {
    expect(withTarget(NO_FOCUS, focusedChat)).toEqual({ target: focusedChat, shown: focusedChat })
  })

  it('取り上げているものが外されたら、映すのをやめる', () => {
    expect(withTarget(withTarget(NO_FOCUS, focusedChat), null)).toEqual(NO_FOCUS)
  })

  it('同じ1件を読み直しても、状態をそのまま返す（10秒ごとに読み直すため）', () => {
    const showing = withTarget(NO_FOCUS, focusedChat)

    expect(withTarget(showing, { ...focusedChat })).toBe(showing)
  })

  it('別の1件に選び直されたら、その1件へ差し替える', () => {
    const showing = withTarget(NO_FOCUS, focusedChat)

    expect(withTarget(showing, otherChat).shown).toEqual(otherChat)
  })
})

describe('withRemoval（モデレーターの操作で発言が消えた）', () => {
  it('取り上げている1件が消されたら、映すのをやめる', () => {
    const showing = withTarget(NO_FOCUS, focusedChat)

    expect(withRemoval(showing, { type: 'message', messageId: '発言1' }).shown).toBeNull()
  })

  it('発言した人がBAN・タイムアウトされたら、映すのをやめる（ログイン名の大文字小文字は区別しない）', () => {
    const showing = withTarget(NO_FOCUS, focusedChat)

    expect(withRemoval(showing, { type: 'user', login: 'Kowai_Hanashi' }).shown).toBeNull()
  })

  it('チャットが全部消されたら、映すのをやめる', () => {
    const showing = withTarget(NO_FOCUS, focusedChat)

    expect(withRemoval(showing, { type: 'all' }).shown).toBeNull()
  })

  it('関係のない発言・人が消されても、映しているものはそのまま残す', () => {
    const showing = withTarget(NO_FOCUS, focusedChat)

    expect(withRemoval(showing, { type: 'message', messageId: 'ほかの発言' })).toBe(showing)
    expect(withRemoval(showing, { type: 'user', login: 'zatsudan_suki' })).toBe(showing)
  })

  it('消されたあとに同じ1件を読み直しても、映すのを再開しない（消えた発言を戻さないため）', () => {
    const afterClear = withRemoval(withTarget(NO_FOCUS, focusedChat), { type: 'message', messageId: '発言1' })

    expect(withTarget(afterClear, focusedChat).shown).toBeNull()
  })

  it('消されたあとでも、別の1件に選び直されたら映す', () => {
    const afterClear = withRemoval(withTarget(NO_FOCUS, focusedChat), { type: 'all' })

    expect(withTarget(afterClear, otherChat).shown).toEqual(otherChat)
  })
})
