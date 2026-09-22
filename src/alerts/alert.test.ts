/**
 * 届いたアラートの読み取り（alert.ts）のテスト
 *
 * Workerから押し出されてくる1件分のアラートを、想定した形かどうか確かめたうえで受け取れること、
 * 形が違えば黙って捨てずにエラーにすることを確認する。
 */
import { describe, expect, it } from 'vitest'
import { parseAlert } from './alert'

const アラート = {
  media: { kind: 'image', url: '/api/media/media-1?key=overlay-key' },
  durationSeconds: 5,
  volume: 0.8,
  text: '田中太郎 さん、ありがとう！',
}

describe('parseAlert', () => {
  it('素材・表示時間・音量・文言を受け取る', () => {
    expect(parseAlert(JSON.stringify(アラート))).toEqual(アラート)
  })

  it('JSONとして読めなければエラーにする', () => {
    expect(() => parseAlert('JSONではない')).toThrow('アラート')
  })

  it('素材の種類が画像・動画・音声のどれでもなければエラーにする', () => {
    expect(() => parseAlert(JSON.stringify({ ...アラート, media: { kind: 'テキスト', url: '/api/media/media-1' } }))).toThrow('アラート')
  })

  it('表示時間や音量が欠けていればエラーにする（黙って既定値で再生しない）', () => {
    expect(() => parseAlert(JSON.stringify({ media: アラート.media, text: '' }))).toThrow('アラート')
  })
})
