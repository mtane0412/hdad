/**
 * 市町村の記事の代表画像の取得と選別（town-image.ts）のテスト
 *
 * 次の点を確かめる。
 * - 代表画像のファイル名から、Wikimedia Commons の作者とライセンスと、画面に出す大きさの画像の URL を取る
 * - 地図・位置図・町章（SVG やファイル名の型に当たるもの）は、問い合わせずに外す
 * - ライセンスがクリエイティブ・コモンズでもパブリック・ドメインでもない・取れない画像は外す
 * - 作者の表記が要るのに作者が無い・画面に収まらないほど長い画像は外す
 * - 作者の HTML はタグを外し、文字参照を戻して文にする
 * - 画像の説明（日本語を優先）を、紹介を作る LLM の材料として取る
 * - Wikipedia が失敗を返した・画像の情報が無いときはエラーにする（外したのではないので黙って捨てない）
 */
import { describe, expect, it } from 'vitest'
import { MAX_ARTIST_LENGTH, TOWN_IMAGE_WIDTH, fetchTownImage, isShowableImageFile } from './town-image'
import { TownArticleError } from './town-wikipedia'

/** Commons の画像の情報（imageinfo）を返す Wikipedia の応答 */
const imageInfoOf = (fileName: string, extmetadata: Record<string, { value: string }>) => ({
  query: {
    pages: [
      {
        title: `ファイル:${fileName}`,
        imagerepository: 'shared',
        imageinfo: [
          {
            thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${fileName}/1280px-${fileName}`,
            url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${fileName}`,
            extmetadata,
          },
        ],
      },
    ],
  },
})

/** Wikipedia の API の応答を返す通信の代役。渡された URL を控える */
const fakeWikipedia = (body: unknown, status = 200) => {
  const urls: URL[] = []
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(new URL(String(input)))
    return new Response(JSON.stringify(body), { status })
  }
  return { fetchImpl, urls }
}

describe('isShowableImageFile', () => {
  it('写真のファイル名は出せる', () => {
    expect(isShowableImageFile('Tone_Diversion_Weir_right_view.jpg')).toBe(true)
    // 「Symbol」は町章ではなく塔の名前なので、型に入れていない
    expect(isShowableImageFile('Symbol_Tower_MiRAi_1.jpg')).toBe(true)
    expect(isShowableImageFile('Niigata_Montage3.png')).toBe(true)
  })

  it('SVG は地図・町章・写真の無い記事の代わりの絵なので出さない', () => {
    expect(isShowableImageFile('Gthumb.svg')).toBe(false)
    expect(isShowableImageFile('府中市章.SVG')).toBe(false)
  })

  it('位置図・地図・市町村章・旗のファイル名は出さない', () => {
    expect(isShowableImageFile('府中市位置図.png')).toBe(false)
    expect(isShowableImageFile('Location_of_Fuchu_Hiroshima_Japan.png')).toBe(false)
    expect(isShowableImageFile('Fuchu_map.png')).toBe(false)
    expect(isShowableImageFile('府中市章.png')).toBe(false)
    expect(isShowableImageFile('Emblem_of_Fuchu,_Hiroshima.png')).toBe(false)
    expect(isShowableImageFile('Flag_of_Fuchu,_Hiroshima.png')).toBe(false)
  })
})

describe('fetchTownImage', () => {
  it('作者とライセンスと、画面に出す大きさの画像の URL を取る', async () => {
    const { fetchImpl, urls } = fakeWikipedia(
      imageInfoOf('Fuchu_Hiroshima_view.jpg', {
        License: { value: 'cc-by-sa-4.0' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Example">府中の写真家</a>' },
      }),
    )

    const image = await fetchTownImage(fetchImpl, 'Fuchu_Hiroshima_view.jpg')

    expect(image).toEqual({
      url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Fuchu_Hiroshima_view.jpg/1280px-Fuchu_Hiroshima_view.jpg',
      artist: '府中の写真家',
      license: 'CC BY-SA 4.0',
      description: '',
    })
    const params = urls[0]?.searchParams
    expect(params?.get('titles')).toBe('File:Fuchu_Hiroshima_view.jpg')
    expect(params?.get('iiurlwidth')).toBe(String(TOWN_IMAGE_WIDTH))
  })

  it('画像の説明を日本語で頼み、HTML を外して取る（紹介を作る LLM が写真の説明を書く材料）', async () => {
    const { fetchImpl, urls } = fakeWikipedia(
      imageInfoOf('安楽寺_Anraku-ji_Temple.jpg', {
        License: { value: 'cc-by-sa-4.0' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        Artist: { value: '府中の写真家' },
        ImageDescription: { value: '<span lang="ja">広島県府中市の<b>安楽寺</b></span>' },
      }),
    )

    const image = await fetchTownImage(fetchImpl, '安楽寺_Anraku-ji_Temple.jpg')

    expect(image?.description).toBe('広島県府中市の安楽寺')
    expect(urls[0]?.searchParams.get('iiextmetadatalanguage')).toBe('ja')
    expect(urls[0]?.searchParams.get('iiextmetadatafilter')).toContain('ImageDescription')
  })

  it('作者の HTML の文字参照を戻し、空白をまとめる', async () => {
    const { fetchImpl } = fakeWikipedia(
      imageInfoOf('Town.jpg', {
        License: { value: 'cc-by-3.0' },
        LicenseShortName: { value: 'CC BY 3.0' },
        Artist: { value: 'photo: 撮影者 &amp; 友人\n<span>(&#12488;&#12540;&#12463;)</span>' },
      }),
    )

    const image = await fetchTownImage(fetchImpl, 'Town.jpg')

    expect(image?.artist).toBe('photo: 撮影者 & 友人 (トーク)')
  })

  it('Unicode の範囲外の文字参照は、投げずにそのまま残す', async () => {
    const { fetchImpl } = fakeWikipedia(
      imageInfoOf('Town.jpg', { License: { value: 'cc-by-3.0' }, LicenseShortName: { value: 'CC BY 3.0' }, Artist: { value: '撮影者&#99999999;&#x110000;' } }),
    )

    expect((await fetchTownImage(fetchImpl, 'Town.jpg'))?.artist).toBe('撮影者&#99999999;&#x110000;')
  })

  it('パブリック・ドメインなら作者が無くても出す', async () => {
    const { fetchImpl } = fakeWikipedia(imageInfoOf('Lake.jpg', { License: { value: 'pd' }, LicenseShortName: { value: 'Public domain' } }))

    const image = await fetchTownImage(fetchImpl, 'Lake.jpg')

    expect(image).toMatchObject({ artist: '', license: 'Public domain' })
  })

  it('CC0 なら作者が無くても出す', async () => {
    const { fetchImpl } = fakeWikipedia(imageInfoOf('Park.jpg', { License: { value: 'cc0' }, LicenseShortName: { value: 'CC0' } }))

    expect(await fetchTownImage(fetchImpl, 'Park.jpg')).toMatchObject({ artist: '', license: 'CC0' })
  })

  it('表示の要るライセンスで作者が無ければ出さない', async () => {
    const { fetchImpl } = fakeWikipedia(imageInfoOf('Coast.jpg', { License: { value: 'cc-by-sa-3.0' }, LicenseShortName: { value: 'CC BY-SA 3.0' } }))

    expect(await fetchTownImage(fetchImpl, 'Coast.jpg')).toBeNull()
  })

  it('クリエイティブ・コモンズでもパブリック・ドメインでもないライセンス（GFDL）なら出さない', async () => {
    const { fetchImpl } = fakeWikipedia(
      imageInfoOf('Shrine.jpg', { License: { value: 'gfdl' }, LicenseShortName: { value: 'GFDL' }, Artist: { value: '撮影者' } }),
    )

    expect(await fetchTownImage(fetchImpl, 'Shrine.jpg')).toBeNull()
  })

  it('ライセンスが取れなければ出さない', async () => {
    const { fetchImpl } = fakeWikipedia(imageInfoOf('Aquarium.jpg', { LicenseShortName: { value: 'Copyrighted free use' }, Artist: { value: '撮影者' } }))

    expect(await fetchTownImage(fetchImpl, 'Aquarium.jpg')).toBeNull()
  })

  it('作者の表記が画面に収まらないほど長ければ出さない', async () => {
    const { fetchImpl } = fakeWikipedia(
      imageInfoOf('Montage.jpg', {
        License: { value: 'cc-by-sa-4.0' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        Artist: { value: 'あ'.repeat(MAX_ARTIST_LENGTH + 1) },
      }),
    )

    expect(await fetchTownImage(fetchImpl, 'Montage.jpg')).toBeNull()
  })

  it('地図・町章のファイル名なら、問い合わせずに出さない', async () => {
    const { fetchImpl, urls } = fakeWikipedia({})

    expect(await fetchTownImage(fetchImpl, 'Gthumb.svg')).toBeNull()
    expect(urls).toEqual([])
  })

  it('Wikipedia が失敗を返したらエラーにする', async () => {
    const { fetchImpl } = fakeWikipedia({ error: '混み合っています' }, 503)

    await expect(fetchTownImage(fetchImpl, 'Town.jpg')).rejects.toThrow(TownArticleError)
  })

  it('画像の情報が無ければ（ファイルが消えていれば）エラーにする', async () => {
    const { fetchImpl } = fakeWikipedia({ query: { pages: [{ title: 'ファイル:Gone.jpg', missing: true }] } })

    await expect(fetchTownImage(fetchImpl, 'Gone.jpg')).rejects.toThrow(TownArticleError)
  })
})
