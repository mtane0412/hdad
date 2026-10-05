/**
 * 市町村紹介の一覧の各市町村に、人口と面積を対応させるスクリプト（issue #250）
 *
 * 使い方: node scripts/town-tour/build-stats.ts <住民基本台帳人口の xlsx のパス> <面積調の CSV のパス>
 * - 人口: 総務省「住民基本台帳に基づく人口、人口動態及び世帯数」の【総計】市区町村別の xlsx
 *   （https://www.soumu.go.jp/main_content/001083789.xlsx は令和8年1月1日現在）
 * - 面積: 国土地理院「全国都道府県市区町村別面積調」の CSV
 *   （https://www.gsi.go.jp/KOKUJYOHO/MENCHO/backnumber/R8_07_mencho.csv は令和8年7月1日時点）
 *
 * src/town-tour/towns.json を読み、src/town-tour/stats.json（コード → 人口と面積）を書き出す。
 * 人口と面積は LLM に記事から読ませない（数字を捏造・取り違えるため。docs/principles.md の方針11）ので、公的な統計をここで同梱する。
 * 突き合わせはコードで行い、名前は取り違えの検出にだけ使う。突き合わない市町村があればエラーで止める。
 * 北方領土の6村は住民の記録が無いので、人口を null のまま持つ（方針6）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strFromU8, unzipSync } from 'fflate'
import type { Town } from './build-data'

/** 住民基本台帳人口の表の1行（市区町村の行だけ） */
export type PopulationRow = {
  /** 検査数字を含む6桁の団体コード */
  code: string
  prefecture: string
  /** 町村は郡名つき（「古宇郡泊村」） */
  name: string
  population: number
}

/** 面積調の表の1行（市区町村の行だけ） */
export type AreaRow = {
  /** 標準地域コード。先頭の0が落ちている（北海道は4桁） */
  code: string
  prefecture: string
  name: string
  /** 面積（km²） */
  area: number
}

/** 市町村1件の人口と面積 */
export type TownStats = {
  /** 住民基本台帳の人口。住民の記録が無い市町村（北方領土の6村）は null */
  population: number | null
  /** 面積（km²） */
  area: number
}

/**
 * 住民の記録が無い北方領土の6村（色丹村・国後郡泊村・留夜別村・留別村・紗那村・蘂取村）のコード
 *
 * 人口の表には0人の行がある村もあるが、0人と「記録が無い」は違うので、表の値によらず null にする。
 */
const NORTHERN_TERRITORY_CODES: ReadonlySet<string> = new Set(['01695', '01696', '01697', '01698', '01699', '01700'])

/**
 * 人口の表が一覧（N03）と違う字で書いている市町村の、人口の表での名前（キーは5桁のコード）
 *
 * 字の揺れを規則（異体字の変換）で吸収すると、別の市町村との取り違えを見逃すので、見つかった分だけを人が確かめて表で持つ。
 */
const POPULATION_NAME_VARIANTS: ReadonlyMap<string, string> = new Map([
  // 人口の表は旧字体の「惠」で書く
  ['40344', '糟屋郡須惠町'],
])

/** 一覧のコードの桁数（全国地方公共団体コードから検査数字を除いた5桁） */
const CODE_LENGTH = 5

/**
 * 人口と面積の表を、一覧の市町村ごとの人口と面積に直す
 *
 * @returns コード（5桁）から人口と面積を引く表（コードの順）
 * @throws 人口か面積の表に無い市町村があるとき、コードが同じでも名前が食い違うとき
 */
export const buildStats = (
  towns: readonly Town[],
  populationRows: readonly PopulationRow[],
  areaRows: readonly AreaRow[],
): Record<string, TownStats> => {
  const populationByCode = new Map(populationRows.map((row) => [row.code.slice(0, CODE_LENGTH), row]))
  const areaByCode = new Map(areaRows.map((row) => [row.code.padStart(CODE_LENGTH, '0'), row]))
  const stats: Record<string, TownStats> = {}
  for (const town of [...towns].sort((a, b) => a.code.localeCompare(b.code))) {
    const place = `${town.prefecture}${town.county}${town.name}（${town.code}）`
    const areaRow = areaByCode.get(town.code)
    if (areaRow === undefined) throw new Error(`面積の表に無い市町村があります: ${place}`)
    if (areaRow.prefecture !== town.prefecture || areaRow.name !== town.name) {
      throw new Error(`面積の表の名前が一覧と食い違います: ${place} と ${areaRow.prefecture}${areaRow.name}`)
    }
    stats[town.code] = { population: populationOf(town, populationByCode.get(town.code), place), area: areaRow.area }
  }
  return stats
}

/** 1市町村の人口を決める（北方領土の6村は null） */
const populationOf = (town: Town, row: PopulationRow | undefined, place: string): number | null => {
  if (NORTHERN_TERRITORY_CODES.has(town.code)) return null
  if (row === undefined) throw new Error(`人口の表に無い市町村があります: ${place}`)
  // 人口の表は町村に郡名を付ける（「古宇郡泊村」）ので、郡名つきと郡名なしのどちらでも認める
  const names = [town.name, `${town.county}${town.name}`, POPULATION_NAME_VARIANTS.get(town.code)]
  if (row.prefecture !== town.prefecture || !names.includes(row.name)) {
    throw new Error(`人口の表の名前が一覧と食い違います: ${place} と ${row.prefecture}${row.name}`)
  }
  return row.population
}

/** 面積調の CSV の列（標準地域コード・都道府県・郡等・市区町村・最新の面積） */
const AREA_COLUMNS = { code: 0, prefecture: 1, name: 3, area: 4 } as const

/**
 * 面積調の CSV から、市区町村の行（コードと市区町村名を持つ行）だけを取り出す
 *
 * 説明・見出し・全国や都道府県や郡の合計・「北海道(市部)」・風蓮湖のような湖の行は、コードか市区町村名が空なので落ちる。
 * 項目に引用符やカンマを含む行は無いので、カンマで区切るだけで読む。
 *
 * @throws 市区町村の行の面積が数として読めないとき
 */
export const areaRowsOf = (csv: string): AreaRow[] =>
  csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.split(','))
    .filter((cells) => /^\d+$/.test(cells[AREA_COLUMNS.code] ?? '') && (cells[AREA_COLUMNS.name] ?? '') !== '')
    .map((cells) => {
      const [code, prefecture, name, area] = [
        cells[AREA_COLUMNS.code],
        cells[AREA_COLUMNS.prefecture],
        cells[AREA_COLUMNS.name],
        Number(cells[AREA_COLUMNS.area]),
      ]
      if (code === undefined || prefecture === undefined || name === undefined || !Number.isFinite(area) || area <= 0) {
        throw new Error(`面積調の行を読めません: ${cells.join(',')}`)
      }
      return { code, prefecture, name, area }
    })

/** 住民基本台帳人口の表の列（A: 団体コード・B: 都道府県名・C: 市区町村名・F: 人口の計） */
const POPULATION_COLUMNS = { code: 'A', prefecture: 'B', name: 'C', population: 'F' } as const

/** 都道府県の小計・全国の合計の行の市区町村名 */
const SUBTOTAL_NAME = '-'

/** XML の文字参照を戻す（表の文字列に現れる5つだけ） */
const decodeXml = (text: string): string =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')

/**
 * xlsx の1枚目のシートを、行ごとに「列の記号 → 値」の表にして読む
 *
 * xlsx は XML を zip にまとめたものなので、fflate で展開して正規表現で読む（この表の読み取りにだけ使う簡易な読み方）。
 * 共有文字列のふりがな（rPh）は値に含めない。
 */
const readSheetRows = (xlsx: Uint8Array): Map<string, string>[] => {
  const files = unzipSync(xlsx)
  const sharedXml = files['xl/sharedStrings.xml']
  const sheetXml = files['xl/worksheets/sheet1.xml']
  if (sharedXml === undefined || sheetXml === undefined) throw new Error('xlsx に共有文字列か1枚目のシートがありません')
  const sharedStrings = [...strFromU8(sharedXml).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, item = '']) =>
    decodeXml(
      [...item.replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, text = '']) => text).join(''),
    ),
  )
  return [...strFromU8(sheetXml).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(([, row = '']) => {
    const cells = new Map<string, string>()
    for (const [, column = '', attributes = '', value = ''] of row.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>[\s\S]*?<v>([\s\S]*?)<\/v>[\s\S]*?<\/c>)/g)) {
      if (!attributes.includes('t="s"')) {
        cells.set(column, decodeXml(value))
        continue
      }
      const shared = sharedStrings[Number(value)]
      if (shared === undefined) throw new Error(`xlsx の共有文字列の番号が範囲外です: ${value}`)
      cells.set(column, shared)
    }
    return cells
  })
}

/**
 * 住民基本台帳人口の xlsx から、市区町村の行（6桁の団体コードを持ち、小計でない行）だけを取り出す
 *
 * @throws 市区町村の行の人口が数として読めないとき
 */
const populationRowsOf = (xlsx: Uint8Array): PopulationRow[] =>
  readSheetRows(xlsx)
    .filter((cells) => /^\d{6}$/.test(cells.get(POPULATION_COLUMNS.code) ?? '') && cells.get(POPULATION_COLUMNS.name) !== SUBTOTAL_NAME)
    .map((cells) => {
      const code = cells.get(POPULATION_COLUMNS.code) ?? ''
      const prefecture = cells.get(POPULATION_COLUMNS.prefecture)
      const name = cells.get(POPULATION_COLUMNS.name)
      const population = Number(cells.get(POPULATION_COLUMNS.population))
      if (prefecture === undefined || name === undefined || !Number.isInteger(population) || population < 0) {
        throw new Error(`住民基本台帳人口の行を読めません: ${code}`)
      }
      return { code, prefecture, name, population }
    })

const repositoryRoot = resolve(import.meta.dirname, '../..')
const townsPath = resolve(repositoryRoot, 'src/town-tour/towns.json')
const statsPath = resolve(repositoryRoot, 'src/town-tour/stats.json')

/** 一覧を読み、人口と面積の表を突き合わせて、所定の場所へ書き出す */
const main = (populationPath: string, areaPath: string): void => {
  const towns: Town[] = JSON.parse(readFileSync(townsPath, 'utf8'))
  const stats = buildStats(towns, populationRowsOf(readFileSync(populationPath)), areaRowsOf(readFileSync(areaPath, 'utf8')))
  writeFileSync(statsPath, `${JSON.stringify(stats, null, 2)}\n`)
}

// テストから読み込まれたときは buildStats と areaRowsOf だけを使うので、直接実行されたときだけ書き出す
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [populationPath, areaPath] = process.argv.slice(2)
  if (populationPath === undefined || areaPath === undefined) {
    throw new Error('住民基本台帳人口の xlsx と面積調の CSV のパスを、この順に渡してください')
  }
  main(populationPath, areaPath)
}
