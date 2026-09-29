/**
 * 手書きの線のやりとりの読み取りのテスト
 *
 * 描く画面と合成ページのあいだを流れるのは、この形の文字列だけである。届いた文字列を読み取れること、
 * そして想定した形でなければ黙って捨てずにエラーにすることを確かめる。
 */
import { describe, expect, it } from 'vitest'
import { parseDrawMessage } from './stroke'

describe('parseDrawMessage', () => {
  it('線の描き始めを、色と太さごと読み取る', () => {
    const 届いた文字列 = '{"type":"start","id":"線1","point":{"x":0.25,"y":0.5},"color":"red","width":"bold"}'

    expect(parseDrawMessage(届いた文字列)).toEqual({ type: 'start', id: '線1', point: { x: 0.25, y: 0.5 }, color: 'red', width: 'bold' })
  })

  it('全消しを読み取る', () => {
    expect(parseDrawMessage('{"type":"clear"}')).toEqual({ type: 'clear' })
  })

  it('選べない色はエラーにする', () => {
    expect(() => parseDrawMessage('{"type":"start","id":"線1","point":{"x":0.1,"y":0.1},"color":"虹色","width":"bold"}')).toThrow(
      '手書きの線の形が想定と違います',
    )
  })

  it('選べない太さはエラーにする', () => {
    expect(() => parseDrawMessage('{"type":"start","id":"線1","point":{"x":0.1,"y":0.1},"color":"red","width":"極太"}')).toThrow(
      '手書きの線の形が想定と違います',
    )
  })

  it('色と太さのない描き始めはエラーにする', () => {
    // 送り手が古いままだと起こる。黙って既定の色で描くと、配信画面に意図しない色の線が出る
    expect(() => parseDrawMessage('{"type":"start","id":"線1","point":{"x":0.1,"y":0.1}}')).toThrow('手書きの線の形が想定と違います')
  })

  it('線の続きを読み取る', () => {
    const 届いた文字列 = '{"type":"extend","id":"線1","points":[{"x":0.3,"y":0.5},{"x":0.35,"y":0.55}]}'

    expect(parseDrawMessage(届いた文字列)).toEqual({
      type: 'extend',
      id: '線1',
      points: [
        { x: 0.3, y: 0.5 },
        { x: 0.35, y: 0.55 },
      ],
    })
  })

  it('箱の外へはみ出した座標も、そのまま読み取る', () => {
    // ポインタを箱の外まで動かすことは普通に起こる。はみ出しは異常ではないので拒まない
    const 届いた文字列 = '{"type":"extend","id":"線1","points":[{"x":-0.1,"y":1.4}]}'

    expect(parseDrawMessage(届いた文字列)).toEqual({ type: 'extend', id: '線1', points: [{ x: -0.1, y: 1.4 }] })
  })

  it('JSONとして読めない文字列はエラーにする', () => {
    expect(() => parseDrawMessage('線です')).toThrow('手書きの線を読み取れませんでした')
  })

  it('線を消したことを読み取る', () => {
    expect(parseDrawMessage('{"type":"erase","id":"線1"}')).toEqual({ type: 'erase', id: '線1' })
  })

  it('消す線の名前がなければエラーにする', () => {
    expect(() => parseDrawMessage('{"type":"erase"}')).toThrow('手書きの線の形が想定と違います')
  })

  it('知らない種類はエラーにする', () => {
    expect(() => parseDrawMessage('{"type":"undo","id":"線1"}')).toThrow('手書きの線の種類が想定と違います')
  })

  it('線の名前がなければエラーにする', () => {
    expect(() => parseDrawMessage('{"type":"start","point":{"x":0.1,"y":0.1},"color":"white","width":"medium"}')).toThrow('手書きの線の形が想定と違います')
  })

  it('線の名前が長すぎればエラーにする', () => {
    // 名前は描く画面が付ける短い識別子なので、長いものが来たら送り手の作りを疑う
    const 長い名前 = 'あ'.repeat(65)

    expect(() => parseDrawMessage(`{"type":"start","id":"${長い名前}","point":{"x":0.1,"y":0.1},"color":"white","width":"medium"}`)).toThrow(
      '手書きの線の形が想定と違います',
    )
  })

  it('座標が数でなければエラーにする', () => {
    expect(() => parseDrawMessage('{"type":"start","id":"線1","point":{"x":"左","y":0.1},"color":"white","width":"medium"}')).toThrow(
      '手書きの線の形が想定と違います',
    )
  })

  it('座標が有限の数でなければエラーにする', () => {
    // JSONに Infinity は書けないが、0で割った結果が文字列化されて届く筋道はありうる
    expect(() => parseDrawMessage('{"type":"start","id":"線1","point":{"x":null,"y":0.1},"color":"white","width":"medium"}')).toThrow(
      '手書きの線の形が想定と違います',
    )
  })

  it('続きの点が空ならエラーにする', () => {
    // 点のない続きを送る理由がないので、送り手の作りの誤りとして扱う
    expect(() => parseDrawMessage('{"type":"extend","id":"線1","points":[]}')).toThrow('手書きの線の形が想定と違います')
  })

  it('一度に送れる点の数を超えればエラーにする', () => {
    const 多すぎる点 = Array.from({ length: 257 }, () => '{"x":0.1,"y":0.1}').join(',')

    expect(() => parseDrawMessage(`{"type":"extend","id":"線1","points":[${多すぎる点}]}`)).toThrow('手書きの線の形が想定と違います')
  })
})
