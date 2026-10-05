/**
 * 市町村の Wikipedia の記事の取得と、紹介の材料の拾い出し（town-wikipedia.ts）のテスト
 *
 * 確かめるのは次の点である。
 * - pickTownMaterial: 記事の本文（見出し付きのプレーンテキスト）から、冒頭と、見出しの名前で振り分けた節を拾うこと
 *   - 見出しの名前が記事ごとに違っても（「名物」「名品」「特産品」）同じ系統に入ること
 *   - 子の見出し（=== ===）の中身も親の節と一緒に拾うこと
 *   - 当てはまる節が無い系統は空文字のままにすること
 *   - 系統ごとの長さの上限で切ること
 * - fetchTownArticle: 記事名から本文を取り、転送先の記事名で出典の URL を作ること。記事が無い・通信が失敗したらエラーにすること
 */
import { describe, expect, it } from 'vitest'
import { MAX_SECTION_LENGTH, TownArticleError, fetchTownArticle, pickTownMaterial } from './town-wikipedia'

/** 上勝町の記事を縮めた本文（見出しの書き方は Wikipedia の API が返す形と同じ） */
const KAMIKATSU = [
  '上勝町（かみかつちょう）は、徳島県中部の勝浦川沿いに位置する町。勝浦郡に属する。',
  '',
  '',
  '== 概要 ==',
  'ゴミを45種類に分別するゼロ・ウェイスト宣言で知られる。',
  '',
  '',
  '== 地理 ==',
  '山：旭ヶ丸、雲早山',
  '',
  '',
  '=== 隣接自治体 ===',
  '名西郡神山町',
  '',
  '',
  '== 歴史 ==',
  '1955年（昭和30年）7月20日 - 高鉾村・福原村が合併して発足。',
  '',
  '',
  '== 行政・議会 ==',
  '町長は〇〇。',
  '',
  '',
  '== 特産品 ==',
  '料理に添える葉っぱ（つまもの）を売る「葉っぱビジネス」。',
  '',
  '',
  '== 観光 ==',
  '',
  '',
  '=== 名所 ===',
  '樫原の棚田',
].join('\n')

describe('pickTownMaterial', () => {
  it('冒頭と概要を lead に、見出しで振り分けた節をそれぞれの系統に拾う', () => {
    const material = pickTownMaterial(KAMIKATSU)

    expect(material.lead).toContain('徳島県中部の勝浦川沿い')
    expect(material.lead).toContain('ゼロ・ウェイスト宣言')
    // 子の見出し（隣接自治体）の中身も地理に入る
    expect(material.geography).toContain('雲早山')
    expect(material.geography).toContain('名西郡神山町')
    expect(material.history).toContain('高鉾村・福原村が合併')
    // 「特産品」という見出しでも名物の系統に入る
    expect(material.specialty).toContain('葉っぱビジネス')
    // 親の「観光」の下にある「名所」も話題に入る
    expect(material.topics).toContain('樫原の棚田')
  })

  it('紹介に使わない節（行政など）は拾わない', () => {
    const material = pickTownMaterial(KAMIKATSU)

    expect(Object.values(material).join('\n')).not.toContain('町長は〇〇')
  })

  it('当てはまる節が無い系統は空文字にする', () => {
    expect(pickTownMaterial(KAMIKATSU).origin).toBe('')
  })

  it('名前の由来は「市名」「語源」「名称」などの見出しから拾う', () => {
    const extract = ['府中市は、広島県の南東部に位置する市。', '', '== 市名 ==', '', '=== 語源 ===', '備後国の国府が置かれたことに由来する。'].join('\n')

    expect(pickTownMaterial(extract).origin).toContain('国府が置かれたことに由来')
  })

  it('親の見出しと別の系統に当てはまる子の見出しは、子の系統に入れる', () => {
    // 府中市 (広島県) では「名物」が「名所・旧跡・観光スポット」の下にある
    const extract = [
      '府中市は、広島県の南東部に位置する市。',
      '== 名所・旧跡・観光スポット ==',
      '=== 名所 ===',
      '安楽寺 - 別名「さつき寺」',
      '=== 名物 ===',
      '府中味噌',
    ].join('\n')

    const material = pickTownMaterial(extract)

    expect(material.specialty).toContain('府中味噌')
    expect(material.topics).toContain('さつき寺')
    expect(material.topics).not.toContain('府中味噌')
  })

  it('町名や大字の一覧の節は拾わない', () => {
    const extract = ['府中市は、広島県の南東部に位置する市。', '== 地理 ==', '芦田川が貫流する。', '=== 町名一覧 ===', '阿字町（あじちょう）'].join('\n')

    const material = pickTownMaterial(extract)

    expect(material.geography).toContain('芦田川')
    expect(material.geography).not.toContain('阿字町')
  })

  it('「葬祭場」や「文化施設」の見出しを話題として拾わない', () => {
    const extract = ['上勝町は、徳島県の町。', '== 葬祭場 ==', '小松島市葬斎場', '== 文化施設 ==', '府中市文化センター'].join('\n')

    expect(pickTownMaterial(extract).topics).toBe('')
  })

  it('系統ごとに長さの上限で切る', () => {
    const extract = ['とある村。', '', '== 歴史 ==', 'あ'.repeat(MAX_SECTION_LENGTH * 2)].join('\n')

    expect([...pickTownMaterial(extract).history].length).toBeLessThanOrEqual(MAX_SECTION_LENGTH)
  })
})

/** Wikipedia の API の応答を返す通信の代役。渡された URL を控える */
const fakeWikipedia = (body: unknown, status = 200) => {
  const urls: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input))
    return new Response(JSON.stringify(body), { status })
  }
  return { fetchImpl, urls }
}

describe('fetchTownArticle', () => {
  it('記事名から本文を取り、出典の URL を添える', async () => {
    const { fetchImpl, urls } = fakeWikipedia({ query: { pages: [{ pageid: 1, title: '府中市 (広島県)', extract: '府中市は、広島県の南東部に位置する市。' }] } })

    const article = await fetchTownArticle(fetchImpl, '府中市 (広島県)')

    expect(article).toEqual({
      title: '府中市 (広島県)',
      url: 'https://ja.wikipedia.org/wiki/%E5%BA%9C%E4%B8%AD%E5%B8%82_(%E5%BA%83%E5%B3%B6%E7%9C%8C)',
      extract: '府中市は、広島県の南東部に位置する市。',
      image: null,
    })
    expect(new URL(String(urls[0])).searchParams.get('titles')).toBe('府中市 (広島県)')
  })

  it('記事に代表画像があれば、本文と同じ問い合わせでファイル名も受け取る', async () => {
    const { fetchImpl, urls } = fakeWikipedia({
      query: { pages: [{ pageid: 1, title: '府中市 (広島県)', extract: '府中市は、広島県の南東部に位置する市。', pageimage: 'Fuchu_Hiroshima_view.jpg' }] },
    })

    const article = await fetchTownArticle(fetchImpl, '府中市 (広島県)')

    expect(article.image).toBe('Fuchu_Hiroshima_view.jpg')
    // 自由なライセンスの画像だけを代表画像として受け取る
    const params = new URL(String(urls[0])).searchParams
    expect(params.get('prop')).toBe('extracts|pageimages')
    expect(params.get('pilicense')).toBe('free')
  })

  it('記事が転送されていたら、転送先の記事名で出典の URL を作る', async () => {
    const { fetchImpl } = fakeWikipedia({ query: { pages: [{ pageid: 2, title: '泊村 (北海道根室振興局)', extract: '泊村は、北海道の国後島にある村。' }] } })

    const article = await fetchTownArticle(fetchImpl, '泊村 (国後郡)')

    expect(article.title).toBe('泊村 (北海道根室振興局)')
    expect(article.url).toBe(`https://ja.wikipedia.org/wiki/${encodeURIComponent('泊村_(北海道根室振興局)')}`)
  })

  it('記事が無ければエラーにする', async () => {
    const { fetchImpl } = fakeWikipedia({ query: { pages: [{ title: '存在しない村', missing: true }] } })

    await expect(fetchTownArticle(fetchImpl, '存在しない村')).rejects.toThrow(TownArticleError)
  })

  it('本文が空ならエラーにする', async () => {
    const { fetchImpl } = fakeWikipedia({ query: { pages: [{ pageid: 3, title: '空の村', extract: '' }] } })

    await expect(fetchTownArticle(fetchImpl, '空の村')).rejects.toThrow(TownArticleError)
  })

  it('Wikipedia が失敗を返したらエラーにする', async () => {
    const { fetchImpl } = fakeWikipedia({ error: '混み合っています' }, 503)

    await expect(fetchTownArticle(fetchImpl, '府中市 (広島県)')).rejects.toThrow(TownArticleError)
  })
})
