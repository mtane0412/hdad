/**
 * 画面から読み取った文字の篩（worker/screen-ocr.ts）のテスト
 *
 * ここで確かめたいのは、issue #122 の実測で成立を確かめた3段の篩が、そのとおりに働くことである。
 * - 自前の文字（サイドスーパー・視聴者の発言と表示名・字幕）が落ちること。見切れた行も落ちること
 * - 中身のない行（3文字未満・数字だけ）が落ちること
 * - 同じ画面を撮り続けたときに、2枚目以降がほぼ残らないこと。ただし初出は必ず残ること
 * - 比べ方が完全一致ではないこと（OCRは同じ画面でも毎回違う文字を返すため、ここを外すと2枚目が畳めない）
 */
import { describe, expect, it } from 'vitest'
import { SCREEN_LINE_SIMILARITY, bigramSimilarity, createScreenSieve, extractNewScreenLines, normalizeScreenLine } from './screen-ocr'

describe('normalizeScreenLine', () => {
  it('全角と半角の違い・大文字小文字・空白・記号を落とす', () => {
    expect(normalizeScreenLine('Ｇｏｏｇｌｅ 検索')).toBe('google検索')
    expect(normalizeScreenLine('【速報】岩手 17歳女性殺害事件')).toBe('速報岩手17歳女性殺害事件')
  })

  it('文字そのものは落とさない（畳みすぎると本当に変わった行まで同じに見えるため）', () => {
    expect(normalizeScreenLine('盛岡市')).toBe('盛岡市')
    expect(normalizeScreenLine('カタカナ')).toBe('カタカナ')
  })
})

describe('bigramSimilarity', () => {
  it('同じ文字列なら1を返す', () => {
    expect(bigramSimilarity('盛岡市のガソリンスタンド', '盛岡市のガソリンスタンド')).toBe(1)
  })

  it('1文字だけ違う長い行は、よく似ていると判定できる', () => {
    // OCRの揺れの実測例（「2008」が「2006」として返る）
    expect(bigramSimilarity('2008年6月29日02:00', '2006年6月29日02:00')).toBeGreaterThan(0.7)
  })

  it('別の内容なら低い値を返す', () => {
    expect(bigramSimilarity('岩手17歳女性殺害事件', 'Googleで検索する')).toBeLessThan(0.7)
  })
})

describe('extractNewScreenLines', () => {
  it('初出の行はそのまま残す', () => {
    const remainingLines = extractNewScreenLines('岩手17歳女性殺害事件\n2008年6月29日 02:00', [], [])

    expect(remainingLines).toEqual(['岩手17歳女性殺害事件', '2008年6月29日 02:00'])
  })

  it('自前の文字（サイドスーパー・視聴者の発言・表示名・字幕）を落とす', () => {
    const ownText = ['いま話していること', 'たねのぶ', 'それは面白いですね']

    const remainingLines = extractNewScreenLines('いま話していること\nたねのぶ\nそれは面白いですね\n盛岡市のガソリンスタンド', ownText, [])

    expect(remainingLines).toEqual(['盛岡市のガソリンスタンド'])
  })

  it('自前の文字の一部でしかない行（見切れたチャット）も落とす', () => {
    const remainingLines = extractNewScreenLines('まぁ、岩手は心', ['まぁ、岩手は心の故郷なので'], [])

    expect(remainingLines).toEqual([])
  })

  it('自前の文字を丸ごと含む行も落とす', () => {
    const remainingLines = extractNewScreenLines('>> それは面白いですね', ['それは面白いですね'], [])

    expect(remainingLines).toEqual([])
  })

  it('短い自前の文字では落とさない（表示名の1文字で本文まで消さないため）', () => {
    const remainingLines = extractNewScreenLines('岩手17歳女性殺害事件', ['あ'], [])

    expect(remainingLines).toEqual(['岩手17歳女性殺害事件'])
  })

  it('中身のない行（3文字未満・数字と記号だけ）を落とす', () => {
    const remainingLines = extractNewScreenLines('あ\n12:34\n---\n岩手17歳女性殺害事件', [], [])

    expect(remainingLines).toEqual(['岩手17歳女性殺害事件'])
  })

  it('既に渡した行によく似ていれば落とす（同じ画面を撮り続けたとき）', () => {
    const alreadyPassedLines = ['2008年6月29日 02:00 盛岡市のガソリンスタンドのカメラに映る']

    // OCRの揺れで「2008」が「2006」として返っても、同じ行として畳む
    const remainingLines = extractNewScreenLines('2006年6月29日 02:00 盛岡市のガソリンスタンドのカメラに映る', [], alreadyPassedLines)

    expect(remainingLines).toEqual([])
  })

  it('同じ画面の中で繰り返された行は1度だけ残す', () => {
    const remainingLines = extractNewScreenLines('岩手17歳女性殺害事件\n岩手17歳女性殺害事件', [], [])

    expect(remainingLines).toEqual(['岩手17歳女性殺害事件'])
  })

  it('既に渡した行があっても、初出の行は残す', () => {
    const alreadyPassedLines = ['岩手17歳女性殺害事件']

    const remainingLines = extractNewScreenLines('岩手17歳女性殺害事件\n盛岡市のガソリンスタンド', [], alreadyPassedLines)

    expect(remainingLines).toEqual(['盛岡市のガソリンスタンド'])
  })
})

describe('createScreenSieve', () => {
  it('1枚目に残した行を、2枚目では既出として落とす（同じ篩を続けて使うとき）', () => {
    const sieve = createScreenSieve([], [])

    const firstCapture = sieve.extract('岩手17歳女性殺害事件')
    // OCRの揺れで1文字違って返っても、1枚目に残した行と同じ行として畳む
    const secondCapture = sieve.extract('岩手17歳女性殺書事件\n盛岡市のガソリンスタンド')

    expect(firstCapture).toEqual(['岩手17歳女性殺害事件'])
    expect(secondCapture).toEqual(['盛岡市のガソリンスタンド'])
  })

  it('既出かどうかの判定は、既に渡した行と1行ずつ文字2連の重なりで比べたときと同じになる', () => {
    // 前提: 同じ2連を何度も含む行・しきい値（0.7）の前後の行・長さが大きく違う行を混ぜる
    const alreadyPassedLines = ['ああああああ', '盛岡市のガソリンスタンド', '2008年6月29日0200', '岩手17歳女性殺害事件の続報', 'カメラ']
    // 候補はどれも3文字以上にする（3文字未満は既出の判定より前に、中身のない行として落ちるため）
    const candidateLines = [
      'あああ',
      'ああああ',
      '盛岡市のガソリンスタンド前',
      '盛岡市のコンビニエンスストア',
      '2006年6月29日0200',
      '岩手17歳女性殺害事件',
      'カメラに映る人物',
      'カメラ',
      'まったく別の話題です',
    ]

    for (const candidate of candidateLines) {
      // 期待値: 既に渡した行のどれか1つと、しきい値以上に似ているか（素朴に全部と比べた結果）
      const resemblesAny = alreadyPassedLines.some((passed) => bigramSimilarity(candidate, passed) >= SCREEN_LINE_SIMILARITY)
      const sieve = createScreenSieve([], alreadyPassedLines)

      expect(sieve.extract(candidate), candidate).toEqual(resemblesAny ? [] : [candidate])
    }
  })

  it('自前の文字によく似た行（OCRの揺れ）も落とす', () => {
    const sieve = createScreenSieve(['それは面白いですねえ'], [])

    expect(sieve.extract('それは面臼いですねえ\n盛岡市のガソリンスタンド')).toEqual(['盛岡市のガソリンスタンド'])
  })
})
