/**
 * サービスワーカーから offscreen document への頼みの読み取りのテスト
 *
 * chrome.runtime.sendMessage は拡張の中のすべての画面に届くので、offscreen document あての頼みだけを読み、
 * ほかのあて先のもの（サービスワーカーあての知らせ）は無視できることを確かめる。形の違うものはエラーにする。
 */
import { describe, expect, it } from 'vitest'
import { OFFSCREEN_COMMAND_TARGET, parseOffscreenCommand } from './offscreen-command'

describe('parseOffscreenCommand', () => {
  it('取り込み始める頼みを読む', () => {
    expect(
      parseOffscreenCommand({
        target: OFFSCREEN_COMMAND_TARGET,
        type: 'start',
        streamId: 'ストリームID-1',
        origin: 'https://hdad.example.workers.dev',
        session: '12345.1790000000.署名',
      }),
    ).toEqual({ type: 'start', streamId: 'ストリームID-1', origin: 'https://hdad.example.workers.dev', session: '12345.1790000000.署名' })
  })

  it('止める頼みを読む', () => {
    expect(parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'stop' })).toEqual({ type: 'stop' })
  })

  it('送るのを止める頼みと、送り直す頼みを読む', () => {
    expect(parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'pause' })).toEqual({ type: 'pause' })
    expect(parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'resume' })).toEqual({ type: 'resume' })
  })

  it('映す範囲を変える頼みを読む（範囲を外す null も読む）', () => {
    expect(parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'crop', crop: { x: 0, y: 0, width: 0.5, height: 0.5 } })).toEqual({
      type: 'crop',
      crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
    })
    expect(parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'crop', crop: null })).toEqual({ type: 'crop', crop: null })
  })

  it('タブの外にはみ出す範囲はエラーにする', () => {
    expect(() => parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'crop', crop: { x: 0.8, y: 0, width: 0.5, height: 1 } })).toThrow('映す範囲の形が想定と違います')
  })

  it('ほかのあて先の連絡は無視する（null を返す）', () => {
    expect(parseOffscreenCommand({ target: 'background', type: 'ended' })).toBeNull()
  })

  it('offscreen document あてなのに形が違えばエラーにする', () => {
    expect(() => parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'start', streamId: '', origin: 'https://hdad.example.workers.dev', session: '12345.1790000000.署名' })).toThrow(
      'サービスワーカーからの頼みの形が想定と違います',
    )
    expect(() => parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: 'start', streamId: 'ストリームID-1', origin: 'https://hdad.example.workers.dev' })).toThrow(
      'サービスワーカーからの頼みの形が想定と違います',
    )
    expect(() => parseOffscreenCommand({ target: OFFSCREEN_COMMAND_TARGET, type: '不明' })).toThrow('サービスワーカーからの頼みの形が想定と違います')
  })
})
