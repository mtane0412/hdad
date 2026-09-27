/**
 * 注目コメントで「いま何を映すか」を決める部分（focused.ts）のテスト
 *
 * オーバーレイは2つの入口から状態を受け取る。取り上げているもの（Workerから定期的に読む）と、
 * 匿名IRCで届く発言・モデレーターの操作である。通信もDOMも持ち込まない形に切り出してあるので、
 * ここでは組み合わせだけを確かめる。特に重要なのは次の4点。
 * - 人に追従する指定では、その人の発言が届くたびに映すものが最新の1件へ差し替わること
 * - 発言1件を取り上げる指定では、ほかの人の発言でも本人の次の発言でも差し替わらないこと
 * - 同じ指定を読み直しても、映しているものが消えたり作り直されたりしないこと（30秒ごとに読むため）
 * - モデレーターに消された発言を映し続けないこと（配信画面に残ると取り返しがつかない）
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../chat/message'
import { NO_FOCUS, withMessage, withRemoval, withTarget, type FocusTarget } from './focused'

/** 怖い話を始めた視聴者に追従する指定 */
const 追従の指定: FocusTarget = { type: 'viewer', login: 'kowai_hanashi' }

/** 雑談の題に取り上げる発言1件の指定 */
const 取り上げの指定: FocusTarget = {
  type: 'message',
  messageId: '発言1',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  text: '今から怖い話をするね',
}

/** IRCで届いた発言。表示に関わらない項目は既定のままにする */
const 発言 = (上書き: Partial<ChatMessage> = {}): ChatMessage => ({
  id: '発言2',
  login: 'kowai_hanashi',
  displayName: '怖い話す人',
  color: '#ff0080',
  badges: [],
  fragments: [{ type: 'text', text: 'それは去年の夏のことでした' }],
  action: false,
  sentAt: undefined,
  firstMessage: false,
  returningChatter: false,
  subscriberMonths: 0,
  bits: 0,
  reply: undefined,
  ...上書き,
})

describe('withTarget（取り上げているものを読み直した）', () => {
  it('人に追従する指定に切り替えた直後は、まだ何も映さない（古い発言を掘り返さないため）', () => {
    expect(withTarget(NO_FOCUS, 追従の指定)).toEqual({ target: 追従の指定, shown: null })
  })

  it('発言1件を取り上げる指定では、読んだ時点でその発言を映す', () => {
    expect(withTarget(NO_FOCUS, 取り上げの指定)).toEqual({
      target: 取り上げの指定,
      shown: {
        messageId: '発言1',
        login: 'kowai_hanashi',
        displayName: '怖い話す人',
        fragments: [{ type: 'text', text: '今から怖い話をするね' }],
      },
    })
  })

  it('取り上げているものが外されたら、映すのをやめる', () => {
    const 映している = withMessage(withTarget(NO_FOCUS, 追従の指定), 発言())

    expect(withTarget(映している, null)).toEqual(NO_FOCUS)
  })

  it('同じ指定を読み直しても、映しているものはそのまま残す（30秒ごとに読み直すため）', () => {
    const 映している = withMessage(withTarget(NO_FOCUS, 追従の指定), 発言())

    expect(withTarget(映している, { type: 'viewer', login: 'kowai_hanashi' })).toEqual(映している)
  })

  it('別の人に切り替えたら、前の人の発言を映すのをやめる', () => {
    const 映している = withMessage(withTarget(NO_FOCUS, 追従の指定), 発言())

    const 切り替えた = withTarget(映している, { type: 'viewer', login: 'zatsudan_suki' })

    expect(切り替えた.shown).toBeNull()
  })
})

describe('withMessage（IRCで発言が届いた）', () => {
  it('追従している人の発言が届いたら、映すものを最新の1件へ差し替える', () => {
    const 状態 = withMessage(withTarget(NO_FOCUS, 追従の指定), 発言())

    expect(状態.shown).toEqual({
      messageId: '発言2',
      login: 'kowai_hanashi',
      displayName: '怖い話す人',
      fragments: [{ type: 'text', text: 'それは去年の夏のことでした' }],
    })
  })

  it('大文字小文字が違うログイン名でも、同じ人として扱う（Twitchの照合と合わせる）', () => {
    const 状態 = withMessage(withTarget(NO_FOCUS, 追従の指定), 発言({ login: 'Kowai_Hanashi' }))

    expect(状態.shown).not.toBeNull()
  })

  it('追従していない人の発言では差し替えない', () => {
    const 状態 = withTarget(NO_FOCUS, 追従の指定)

    expect(withMessage(状態, 発言({ login: 'zatsudan_suki', displayName: '雑談好き' }))).toEqual(状態)
  })

  it('発言1件を取り上げているあいだは、本人の次の発言でも差し替えない（題として固定するため）', () => {
    const 状態 = withTarget(NO_FOCUS, 取り上げの指定)

    expect(withMessage(状態, 発言())).toEqual(状態)
  })

  it('何も取り上げていなければ、誰の発言でも映さない', () => {
    expect(withMessage(NO_FOCUS, 発言())).toEqual(NO_FOCUS)
  })
})

describe('withRemoval（モデレーターの操作で発言が消えた）', () => {
  it('映している発言が消されたら、映すのをやめる', () => {
    const 映している = withMessage(withTarget(NO_FOCUS, 追従の指定), 発言())

    expect(withRemoval(映している, { type: 'message', messageId: '発言2' }).shown).toBeNull()
  })

  it('取り上げている1件が消されたときも、映すのをやめる', () => {
    const 映している = withTarget(NO_FOCUS, 取り上げの指定)

    expect(withRemoval(映している, { type: 'message', messageId: '発言1' }).shown).toBeNull()
  })

  it('映している人がBAN・タイムアウトされたら、映すのをやめる', () => {
    const 映している = withMessage(withTarget(NO_FOCUS, 追従の指定), 発言())

    expect(withRemoval(映している, { type: 'user', login: 'kowai_hanashi' }).shown).toBeNull()
  })

  it('チャットが全部消されたら、映すのをやめる', () => {
    const 映している = withMessage(withTarget(NO_FOCUS, 追従の指定), 発言())

    expect(withRemoval(映している, { type: 'all' }).shown).toBeNull()
  })

  it('関係のない発言・人が消されても、映しているものはそのまま残す', () => {
    const 映している = withMessage(withTarget(NO_FOCUS, 追従の指定), 発言())

    expect(withRemoval(映している, { type: 'message', messageId: 'ほかの発言' })).toEqual(映している)
    expect(withRemoval(映している, { type: 'user', login: 'zatsudan_suki' })).toEqual(映している)
  })

  it('消されたあとに同じ指定を読み直しても、映すのを再開しない（消えた発言を戻さないため）', () => {
    const 消したあと = withRemoval(withTarget(NO_FOCUS, 取り上げの指定), { type: 'message', messageId: '発言1' })

    expect(withTarget(消したあと, 取り上げの指定).shown).toBeNull()
  })
})
