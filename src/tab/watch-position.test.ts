/**
 * 同時視聴の再生位置（issue #443）のテスト
 *
 * 拡張から合成ページへ送る再生位置の読み取りと、合成ページに出す時刻の計算を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { displayedSeconds, formatWatchTime, parseWatchPosition, type WatchPosition } from './watch-position'

const playing: WatchPosition = {
  positionSeconds: 100,
  playing: true,
  rate: 1,
  title: '湾岸署の映画',
  episode: 'S1 E2 第2話 無愛想な薬師',
  imageUrl: 'https://images-fe.ssl-images-amazon.com/images/S/pv-target-images/作品の画像.jpg',
}

describe('parseWatchPosition', () => {
  it('想定した形を読み取る', () => {
    expect(parseWatchPosition(playing)).toEqual(playing)
  })

  it('その回の情報が無いもの（古い版の拡張）は、入れ直しを案内するエラーにする', () => {
    const old = { positionSeconds: 100, playing: true, rate: 1, title: '湾岸署の映画', imageUrl: null }

    expect(() => parseWatchPosition(old)).toThrow('HDAD-tab の拡張が古いので、/connectors/ からダウンロードして入れ直してください')
  })

  it('題名と画像が分からないときは null のまま持つ', () => {
    expect(parseWatchPosition({ ...playing, title: null, episode: null, imageUrl: null })).toEqual({ ...playing, title: null, episode: null, imageUrl: null })
  })

  it('Amazon の画像の置き場所以外の画像はエラーにする（配信画面に任意の画像を出させない）', () => {
    expect(() => parseWatchPosition({ ...playing, imageUrl: 'https://悪意のあるサイト.example/画像.jpg' })).toThrow('作品の画像の置き場所が想定と違います')
    expect(() => parseWatchPosition({ ...playing, imageUrl: 'http://m.media-amazon.com/images/画像.jpg' })).toThrow('作品の画像の置き場所が想定と違います')
    expect(() => parseWatchPosition({ ...playing, imageUrl: 'https://media-amazon.com.example/画像.jpg' })).toThrow('作品の画像の置き場所が想定と違います')
  })

  it('位置が数でない・負の数ならエラーにする', () => {
    expect(() => parseWatchPosition({ ...playing, positionSeconds: '100' })).toThrow('再生位置の形が想定と違います')
    expect(() => parseWatchPosition({ ...playing, positionSeconds: -1 })).toThrow('再生位置の形が想定と違います')
  })
})

describe('displayedSeconds', () => {
  it('再生中は、受け取ってからの経過時間のぶん進める', () => {
    expect(displayedSeconds(playing, 5000)).toBe(105)
  })

  it('再生速度を掛けて進める', () => {
    expect(displayedSeconds({ ...playing, rate: 2 }, 5000)).toBe(110)
  })

  it('一時停止中は進めない', () => {
    expect(displayedSeconds({ ...playing, playing: false }, 5000)).toBe(100)
  })
})

describe('formatWatchTime', () => {
  it('Prime Video の画面と同じ 時:分:秒 にする', () => {
    expect(formatWatchTime(33.908)).toBe('0:00:34')
    expect(formatWatchTime(7163)).toBe('1:59:23')
  })
})
