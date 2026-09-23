import { describe, expect, it } from 'vitest'
import { EMPTY_TRANSCRIPT_STATE, TranscriptMessageError, forgetTranscript, nextTranscriptState, readTranscriptMessage } from './message'

/** ゆかコネNEO が送ってくる1件を組み立てる（省略した項目は既定の形にする） */
const 受信データ = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    Text1: 'こんばんは、配信を始めます',
    Text2: '',
    Text3: '',
    Text4: '',
    Text5: '',
    Text6: '',
    TextFixed: true,
    MsgID: 'f4ad2560-11c0-494f-be04-5734bec5ea41',
    isDeleted: false,
    KeepTime: 3.426,
    ...overrides,
  })

describe('readTranscriptMessage', () => {
  it('確定した発話を、メッセージIDと母国語の本文にして返す', () => {
    expect(readTranscriptMessage(受信データ())).toEqual({
      kind: 'spoken',
      messageId: 'f4ad2560-11c0-494f-be04-5734bec5ea41',
      text: 'こんばんは、配信を始めます',
    })
  })

  it('暫定の認識（TextFixed が偽）は送る対象にしない', () => {
    expect(readTranscriptMessage(受信データ({ TextFixed: false }))).toEqual({ kind: 'ignored' })
  })

  it('取り消された発話は取り消しとして返す', () => {
    expect(readTranscriptMessage(受信データ({ isDeleted: true }))).toEqual({
      kind: 'deleted',
      messageId: 'f4ad2560-11c0-494f-be04-5734bec5ea41',
    })
  })

  it('取り消しは、確定していない発話についても取り消しとして返す', () => {
    expect(readTranscriptMessage(受信データ({ TextFixed: false, isDeleted: true }))).toEqual({
      kind: 'deleted',
      messageId: 'f4ad2560-11c0-494f-be04-5734bec5ea41',
    })
  })

  it('翻訳（Text2〜Text6）は読み取らない', () => {
    expect(readTranscriptMessage(受信データ({ Text2: 'Good evening', Text3: '晚上好' }))).toEqual({
      kind: 'spoken',
      messageId: 'f4ad2560-11c0-494f-be04-5734bec5ea41',
      text: 'こんばんは、配信を始めます',
    })
  })

  it('本文の前後の空白を落とす', () => {
    expect(readTranscriptMessage(受信データ({ Text1: '  えーと、今日は  ' }))).toEqual({
      kind: 'spoken',
      messageId: 'f4ad2560-11c0-494f-be04-5734bec5ea41',
      text: 'えーと、今日は',
    })
  })

  it('本文が空白だけの発話は送る対象にしない', () => {
    expect(readTranscriptMessage(受信データ({ Text1: '   ' }))).toEqual({ kind: 'ignored' })
  })

  it('JSONとして読めないデータはエラーにする', () => {
    expect(() => readTranscriptMessage('こんばんは')).toThrow(TranscriptMessageError)
  })

  it('オブジェクトでないデータはエラーにする', () => {
    expect(() => readTranscriptMessage('"こんばんは"')).toThrow(TranscriptMessageError)
  })

  it('メッセージIDが無いデータはエラーにする', () => {
    expect(() => readTranscriptMessage(受信データ({ MsgID: undefined }))).toThrow(TranscriptMessageError)
  })

  it('メッセージIDが空のデータはエラーにする', () => {
    expect(() => readTranscriptMessage(受信データ({ MsgID: '' }))).toThrow(TranscriptMessageError)
  })

  it('本文が文字列でないデータはエラーにする', () => {
    expect(() => readTranscriptMessage(受信データ({ Text1: 123 }))).toThrow(TranscriptMessageError)
  })

  it('確定フラグが真偽値でないデータはエラーにする', () => {
    expect(() => readTranscriptMessage(受信データ({ TextFixed: 'true' }))).toThrow(TranscriptMessageError)
  })
})

describe('nextTranscriptState', () => {
  it('初めて届いた確定の発話は送る', () => {
    const { state, action } = nextTranscriptState(EMPTY_TRANSCRIPT_STATE, {
      kind: 'spoken',
      messageId: 'あいさつ',
      text: 'こんばんは',
    })
    expect(action).toEqual({ kind: 'send', messageId: 'あいさつ', text: 'こんばんは' })
    expect(state).not.toBe(EMPTY_TRANSCRIPT_STATE)
  })

  it('同じメッセージIDが二度届いても二度目は送らない', () => {
    const 一度目 = nextTranscriptState(EMPTY_TRANSCRIPT_STATE, { kind: 'spoken', messageId: 'あいさつ', text: 'こんばんは' })
    const 二度目 = nextTranscriptState(一度目.state, { kind: 'spoken', messageId: 'あいさつ', text: 'こんばんは' })
    expect(二度目.action).toBeNull()
  })

  it('送ったあとの取り消しは取り消しとして返す', () => {
    const 送信後 = nextTranscriptState(EMPTY_TRANSCRIPT_STATE, { kind: 'spoken', messageId: 'あいさつ', text: 'こんばんは' })
    const { action } = nextTranscriptState(送信後.state, { kind: 'deleted', messageId: 'あいさつ' })
    expect(action).toEqual({ kind: 'remove', messageId: 'あいさつ' })
  })

  it('送っていない発話の取り消しは何もしない', () => {
    const { action } = nextTranscriptState(EMPTY_TRANSCRIPT_STATE, { kind: 'deleted', messageId: '暫定のまま消えた発話' })
    expect(action).toBeNull()
  })

  it('取り消したメッセージIDが同じ本文で届き直しても送らない', () => {
    const 送信後 = nextTranscriptState(EMPTY_TRANSCRIPT_STATE, { kind: 'spoken', messageId: 'あいさつ', text: 'こんばんは' })
    const 取り消し後 = nextTranscriptState(送信後.state, { kind: 'deleted', messageId: 'あいさつ' })
    const { action } = nextTranscriptState(取り消し後.state, { kind: 'spoken', messageId: 'あいさつ', text: 'こんばんは' })
    expect(action).toBeNull()
  })

  it('読み取る対象でない1件（暫定の認識）では何もしない', () => {
    const { state, action } = nextTranscriptState(EMPTY_TRANSCRIPT_STATE, { kind: 'ignored' })
    expect(action).toBeNull()
    expect(state).toBe(EMPTY_TRANSCRIPT_STATE)
  })
})

describe('forgetTranscript', () => {
  it('忘れた発話は、同じ1件がまた届いたときにもう一度送る', () => {
    const 送信後 = nextTranscriptState(EMPTY_TRANSCRIPT_STATE, { kind: 'spoken', messageId: 'あいさつ', text: 'こんばんは' })
    const 忘れたあと = forgetTranscript(送信後.state, 'あいさつ')

    const { action } = nextTranscriptState(忘れたあと, { kind: 'spoken', messageId: 'あいさつ', text: 'こんばんは' })

    expect(action).toEqual({ kind: 'send', messageId: 'あいさつ', text: 'こんばんは' })
  })

  it('覚えていない発話を忘れても、状態は変わらない', () => {
    expect(forgetTranscript(EMPTY_TRANSCRIPT_STATE, '知らない発話')).toBe(EMPTY_TRANSCRIPT_STATE)
  })
})
