/**
 * タブの映像をつなぐための連絡（シグナリング）の読み取りのテスト
 *
 * 送り手（/tab/）と合成ページのあいだを流れるのは、この形の文字列だけである。
 * 届いた文字列を読み取れること、想定した形でなければ黙って捨てずにエラーにすることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { buildStreamHash, parseFromSender, parseFromViewer, readStreamHash } from './signal'

describe('parseFromViewer（送り手が合成ページから受け取る連絡）', () => {
  it('名乗り（hello）を読み取る', () => {
    expect(parseFromViewer('{"type":"hello","viewerId":"OBSの受け手"}')).toEqual({ type: 'hello', viewerId: 'OBSの受け手' })
  })

  it('answer を読み取る', () => {
    expect(parseFromViewer('{"type":"answer","viewerId":"OBSの受け手","sdp":"v=0 回答"}')).toEqual({
      type: 'answer',
      viewerId: 'OBSの受け手',
      sdp: 'v=0 回答',
    })
  })

  it('名乗りの無い answer はエラーにする', () => {
    expect(() => parseFromViewer('{"type":"answer","sdp":"v=0 回答"}')).toThrow('合成ページからの連絡の形が想定と違います')
  })

  it('送り手が送る種類（offer）が届いたらエラーにする', () => {
    expect(() => parseFromViewer('{"type":"offer","viewerId":"OBSの受け手","sdp":"v=0"}')).toThrow('合成ページからの連絡の種類が想定と違います')
  })

  it('JSONとして読めなければエラーにする', () => {
    expect(() => parseFromViewer('こんにちは')).toThrow('合成ページからの連絡を読み取れませんでした')
  })
})

describe('parseFromSender（合成ページが送り手から受け取る連絡）', () => {
  it('名乗り直しの頼み（who）を読み取る', () => {
    expect(parseFromSender('{"type":"who"}')).toEqual({ type: 'who' })
  })

  it('offer を読み取る', () => {
    expect(parseFromSender('{"type":"offer","viewerId":"OBSの受け手","sdp":"v=0 申し込み"}')).toEqual({
      type: 'offer',
      viewerId: 'OBSの受け手',
      sdp: 'v=0 申し込み',
    })
  })

  it('映すのをやめた知らせ（stop）を読み取る', () => {
    expect(parseFromSender('{"type":"stop"}')).toEqual({ type: 'stop' })
  })

  it('中身が空の offer はエラーにする', () => {
    expect(() => parseFromSender('{"type":"offer","viewerId":"OBSの受け手","sdp":""}')).toThrow('送り手からの連絡の形が想定と違います')
  })

  it('合成ページが送る種類（hello）が届いたらエラーにする', () => {
    expect(() => parseFromSender('{"type":"hello","viewerId":"OBSの受け手"}')).toThrow('送り手からの連絡の種類が想定と違います')
  })
})

describe('URLの#でストリームIDを受け渡す書式', () => {
  it('拡張が作った#を、送り手ページが読み戻せる', () => {
    const hash = buildStreamHash({ streamId: 'ストリームID=1&2', title: '資料のタブ #1' })

    expect(readStreamHash(hash)).toEqual({ streamId: 'ストリームID=1&2', title: '資料のタブ #1' })
  })

  it('#が無ければ、届いていないとして null を返す', () => {
    expect(readStreamHash('')).toBeNull()
  })

  it('ストリームIDの無い#はエラーにする', () => {
    expect(() => readStreamHash('#title=資料のタブ')).toThrow('拡張から届いた内容を読み取れませんでした')
  })
})
