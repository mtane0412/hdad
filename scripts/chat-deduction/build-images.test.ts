/**
 * チャットで推理の解説に添える画像の作り直し（build-images.ts）のテスト
 *
 * 問題ごとの Wikipedia の記事名から、記事の代表画像のファイル名を1回の問い合わせでまとめて引く。確かめるのは次の点である。
 * - 頼んだ記事名ごとに、代表画像のファイル名を返すこと（代表画像の無い記事は null）
 * - 表記の揃え（normalized）と転送（redirects）を辿って、頼んだ記事名に結び付けること
 * - 記事が無い・応答に頼んだ記事が見当たらないときは、黙って画像なしにせずエラーにすること
 * - 問題が画像を指名していれば代表画像の代わりにそれを取り、ファイル名の型では外さないこと（出せない画像ならエラー）
 */
import { describe, expect, it } from 'vitest'
import type { ChatDeductionProblem } from '../../src/chat-deduction/problems'
import { fetchProblemImage, pageImageFilesOf } from './build-images'

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

/** 問題の代役（記事名と、指名した画像だけが効く） */
const problemOf = (image?: ChatDeductionProblem['image']): ChatDeductionProblem => ({
  id: 'battle-of-hakusukinoe',
  category: 'event',
  answer: '白村江の戦い',
  aliases: ['白村江の戦い'],
  facts: ['663年の戦い。'],
  explanation: '663年の戦い。',
  wikipedia: '白村江の戦い',
  ...(image === undefined ? {} : { image }),
})

/** Commons の画像の情報を返す通信の代役。問い合わせた画像のファイル名を控える */
const fakeCommons = (extmetadata: Record<string, { value: string }>) => {
  const files: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    files.push(new URL(String(input)).searchParams.get('titles') ?? '')
    const body = { query: { pages: [{ imageinfo: [{ thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.png/1280px-X.png', extmetadata }] }] } }
    return new Response(JSON.stringify(body))
  }
  return { fetchImpl, files }
}

const ccBySa = { License: { value: 'cc-by-sa-3.0' }, LicenseShortName: { value: 'CC BY-SA 3.0' } }

describe('fetchProblemImage', () => {
  it('画像を指名していなければ、記事の代表画像を取る（地図のファイル名は問い合わせずに外す）', async () => {
    const { fetchImpl, files } = fakeCommons({ ...ccBySa, Artist: { value: 'Stillskywkpd' } })

    expect(await fetchProblemImage(fetchImpl, problemOf(), 'Map_of_the_Battle_of_Baekgang.png')).toBeNull()
    expect(files).toEqual([])
  })

  it('記事に代表画像が無く、指名もしていなければ画像なしにする', async () => {
    const { fetchImpl } = fakeCommons(ccBySa)

    expect(await fetchProblemImage(fetchImpl, problemOf(), null)).toBeNull()
  })

  it('画像を指名していれば、代表画像の代わりにそれを取り、地図でも出す', async () => {
    const { fetchImpl, files } = fakeCommons({ ...ccBySa, Artist: { value: 'Stillskywkpd' } })

    expect(await fetchProblemImage(fetchImpl, problemOf({ file: 'Map_of_the_Battle_of_Baekgang.png' }), null)).toEqual({
      url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.png/1280px-X.png',
      artist: 'Stillskywkpd',
      license: 'CC BY-SA 3.0',
    })
    expect(files).toEqual(['File:Map_of_the_Battle_of_Baekgang.png'])
  })

  it('指名した画像の作者の欄が空なら、問題集に書いた作者を使う', async () => {
    const { fetchImpl } = fakeCommons(ccBySa)

    expect(await fetchProblemImage(fetchImpl, problemOf({ file: '藤原広嗣の乱.png', artist: '味っ子' }), null)).toMatchObject({ artist: '味っ子' })
  })

  it('指名した画像が出せない（ライセンスが合わない・作者の表記が要るのに無い）なら、黙って画像なしにせずエラーにする', async () => {
    const { fetchImpl } = fakeCommons(ccBySa)

    await expect(fetchProblemImage(fetchImpl, problemOf({ file: '藤原広嗣の乱.png' }), null)).rejects.toThrow(/藤原広嗣の乱\.png/)
  })
})

