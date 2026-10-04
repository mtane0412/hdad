/**
 * 市町村の Wikipedia の記事名の解決（build-articles.ts）のテスト
 *
 * 市町村の名前は一意でない（府中市は東京都と広島県にある）ので、記事は名前ではなく
 * Wikidata の全国地方公共団体コード（P429）から引く。確かめるのは次の4点である。
 * - 5桁のコードに、総務省の規則どおりの検査数字を付けて6桁にできること（余りが0・1になる端の場合を含む）
 * - コードに当たる Wikidata の項目が1件なら、その日本語版の記事名を採ること
 * - 1件も無い市町村があれば、黙って飛ばさずエラーにすること
 * - 複数の項目が同じコードを持つときは、表で指名した項目だけを採り、表に無ければエラーにすること
 */
import { describe, expect, it } from 'vitest'
import { resolveArticles, withCheckDigit, type CodeArticle } from './build-articles'

/** Wikidata の問い合わせ結果の1行を作る */
const row = (code: string, item: string, title: string): CodeArticle => ({ code, item, title })

describe('withCheckDigit', () => {
  it('5桁のコードに検査数字を付ける', () => {
    // 広島県府中市: 3×6 + 4×5 + 2×4 + 0×3 + 8×2 = 62、62 を 11 で割った余りは 7、11 − 7 = 4
    expect(withCheckDigit('34208')).toBe('342084')
  })

  it('余りが0のときは1、余りが1のときは0を付ける', () => {
    // 札幌市: 0×6 + 1×5 + 1×4 + 0×3 + 0×2 = 9 → 余り9 → 2
    expect(withCheckDigit('01100')).toBe('011002')
    // 千代田区: 1×6 + 3×5 + 1×4 + 0×3 + 1×2 = 27 → 余り5 → 6
    expect(withCheckDigit('13101')).toBe('131016')
    // 余り0: 0×6 + 0×5 + 0×4 + 1×3 + 4×2 = 11 → 余り0 → 1
    expect(withCheckDigit('00014')).toBe('000141')
    // 余り1: 0×6 + 0×5 + 0×4 + 0×3 + 6×2 = 12 → 余り1 → 0
    expect(withCheckDigit('00006')).toBe('000060')
  })

  it('5桁の数字でなければエラーにする', () => {
    expect(() => withCheckDigit('3420')).toThrow()
  })
})

describe('resolveArticles', () => {
  it('コードに当たる項目が1件なら、その記事名を採る', () => {
    const articles = resolveArticles(['34208', '13206'], [row('342084', 'Q686775', '府中市 (広島県)'), row('132063', 'Q208818', '府中市 (東京都)')], new Map())

    expect(articles).toEqual({ '34208': '府中市 (広島県)', '13206': '府中市 (東京都)' })
  })

  it('記事の無い市町村があればエラーにする', () => {
    expect(() => resolveArticles(['34208', '13206'], [row('342084', 'Q686775', '府中市 (広島県)')], new Map())).toThrow('13206')
  })

  it('同じコードの項目が複数あれば、表で指名した項目を採る', () => {
    const rows = [row('473243', 'Q973994', '読谷村'), row('473243', 'Q138722100', '読谷村文化センター')]

    expect(resolveArticles(['47324'], rows, new Map([['47324', 'Q973994']]))).toEqual({ '47324': '読谷村' })
  })

  it('同じコードの項目が複数あって表に無ければエラーにする', () => {
    const rows = [row('473243', 'Q973994', '読谷村'), row('473243', 'Q138722100', '読谷村文化センター')]

    expect(() => resolveArticles(['47324'], rows, new Map())).toThrow('47324')
  })
})
