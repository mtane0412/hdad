/**
 * チャットで推理の解説に添える画像の作り直し（build-images.ts）のテスト
 *
 * 問題ごとの Wikipedia の記事名から、記事の代表画像のファイル名を1回の問い合わせでまとめて引く。確かめるのは次の点である。
 * - 頼んだ記事名ごとに、代表画像のファイル名を返すこと（代表画像の無い記事は null）
 * - 表記の揃え（normalized）と転送（redirects）を辿って、頼んだ記事名に結び付けること
 * - 記事が無い・応答に頼んだ記事が見当たらないときは、黙って画像なしにせずエラーにすること
 */
import { describe, expect, it } from 'vitest'
import { pageImageFilesOf } from './build-images'

describe('pageImageFilesOf', () => {
  it('頼んだ記事名ごとに代表画像のファイル名を返し、代表画像の無い記事は null にする', () => {
    const body = { query: { pages: [{ title: '富士山', pageimage: 'Mt.Fuji.jpg' }, { title: '卑弥呼' }] } }

    expect(pageImageFilesOf(body, ['富士山', '卑弥呼'])).toEqual(
      new Map([
        ['富士山', 'Mt.Fuji.jpg'],
        ['卑弥呼', null],
      ]),
    )
  })

  it('表記の揃えと転送を辿って、頼んだ記事名に結び付ける', () => {
    // 前提: 「承平・天慶の乱」は「承平天慶の乱」へ転送される
    const body = {
      query: {
        normalized: [{ from: '空海_', to: '空海' }],
        redirects: [{ from: '承平・天慶の乱', to: '承平天慶の乱' }],
        pages: [
          { title: '承平天慶の乱', pageimage: 'Takedono.jpg' },
          { title: '空海', pageimage: 'Kobo_Daishi.jpg' },
        ],
      },
    }

    expect(pageImageFilesOf(body, ['承平・天慶の乱', '空海_'])).toEqual(
      new Map([
        ['承平・天慶の乱', 'Takedono.jpg'],
        ['空海_', 'Kobo_Daishi.jpg'],
      ]),
    )
  })

  it('記事が無ければ、記事名を添えてエラーにする', () => {
    const body = { query: { pages: [{ title: '存在しない記事', missing: true }] } }

    expect(() => pageImageFilesOf(body, ['存在しない記事'])).toThrowError(/存在しない記事/)
  })

  it('応答に頼んだ記事が見当たらなければ、エラーにする', () => {
    const body = { query: { pages: [{ title: '富士山', pageimage: 'Mt.Fuji.jpg' }] } }

    expect(() => pageImageFilesOf(body, ['富士山', '夏目漱石'])).toThrowError(/夏目漱石/)
  })

  it('応答の形が違えば、エラーにする', () => {
    expect(() => pageImageFilesOf({}, ['富士山'])).toThrowError(/形/)
  })
})
