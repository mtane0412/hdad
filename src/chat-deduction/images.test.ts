/**
 * チャットで推理の解説に添える画像（images.json。scripts/chat-deduction/build-images.ts の生成物）の読み取りのテスト
 *
 * images.json は問題のIDごとに、記事の代表画像（画面に出す URL・作者・ライセンス）か、出せる画像が無いこと（null）を持つ。
 * 問題を足したのに作り直し忘れた・消した問題が残ったままのときに気づけるよう、問題集との1対1をここで確かめる。
 */
import { describe, expect, it } from 'vitest'
import { readChatDeductionImages } from './images'
import images from './images.json'
import { CHAT_DEDUCTION_PROBLEMS } from './problem-set'
import type { ChatDeductionProblem } from './problems'

const fuji: ChatDeductionProblem = {
  id: 'mount-fuji',
  category: 'place',
  answer: '富士山',
  aliases: ['富士山'],
  facts: ['日本でいちばん高い山。'],
  explanation: '日本でいちばん高い山。',
  wikipedia: '富士山',
}
const himiko: ChatDeductionProblem = { ...fuji, id: 'himiko', category: 'person', answer: '卑弥呼', aliases: ['卑弥呼'], wikipedia: '卑弥呼' }

const fujiImage = { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Mt.Fuji.jpg/1280px-Mt.Fuji.jpg', artist: '山田花子', license: 'CC BY-SA 4.0' }

describe('画像（images.json）', () => {
  it('問題集のすべての問題と1対1で対応して読める（問題を足したら npm run build:chat-deduction-images で作り直す）', () => {
    expect(() => readChatDeductionImages(images, CHAT_DEDUCTION_PROBLEMS)).not.toThrow()
  })
})

describe('readChatDeductionImages', () => {
  it('Wikimedia のサムネイルの置き場（thumb.wikimedia.org）の画像も読む', () => {
    const thumb = { ...fujiImage, url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Mt.Fuji.jpg/1280px-Mt.Fuji.jpg' }

    expect(readChatDeductionImages({ 'mount-fuji': thumb, himiko: null }, [fuji, himiko]).get('mount-fuji')).toEqual(thumb)
  })

  it('問題のIDごとに、画像か画像なし（null）を読む', () => {
    const read = readChatDeductionImages({ 'mount-fuji': fujiImage, himiko: null }, [fuji, himiko])

    expect(read.get('mount-fuji')).toEqual(fujiImage)
    expect(read.get('himiko')).toBeNull()
  })

  it('問題集にある問題の画像が無ければ、作り直しを促すエラーにする', () => {
    expect(() => readChatDeductionImages({ 'mount-fuji': fujiImage }, [fuji, himiko])).toThrowError(/himiko.*作り直/)
  })

  it('問題集に無い問題の画像があれば、エラーにする', () => {
    expect(() => readChatDeductionImages({ 'mount-fuji': fujiImage, himiko: null, 'natsume-soseki': null }, [fuji, himiko])).toThrowError(/natsume-soseki/)
  })

  it('画像の URL が Wikimedia の画像でない・ライセンスが空・作者が文字列でなければ、エラーにする', () => {
    expect(() => readChatDeductionImages({ 'mount-fuji': { ...fujiImage, url: 'https://example.com/fuji.jpg' }, himiko: null }, [fuji, himiko])).toThrowError(/mount-fuji/)
    expect(() => readChatDeductionImages({ 'mount-fuji': { ...fujiImage, url: 'http://upload.wikimedia.org/fuji.jpg' }, himiko: null }, [fuji, himiko])).toThrowError(/mount-fuji/)
    expect(() => readChatDeductionImages({ 'mount-fuji': { ...fujiImage, url: 'https://evil.example/wikimedia.org/fuji.jpg' }, himiko: null }, [fuji, himiko])).toThrowError(/mount-fuji/)
    expect(() => readChatDeductionImages({ 'mount-fuji': { ...fujiImage, license: '' }, himiko: null }, [fuji, himiko])).toThrowError(/mount-fuji/)
    expect(() => readChatDeductionImages({ 'mount-fuji': { ...fujiImage, artist: 1 }, himiko: null }, [fuji, himiko])).toThrowError(/mount-fuji/)
  })

  it('オブジェクトでなければ、エラーにする', () => {
    expect(() => readChatDeductionImages([], [fuji])).toThrowError(/オブジェクト/)
  })
})
