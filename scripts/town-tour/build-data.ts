/**
 * 市町村紹介の一覧と地図を、国土数値情報の行政区域（N03）から作り直すスクリプト
 *
 * 使い方: node scripts/town-tour/build-data.ts <N03-YYYYMMDD.shp のパス>
 * N03 の全国版（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-2026.html の「全国」）を展開した shp を渡す。
 *
 * 出力は次の2つで、どちらもリポジトリに同梱する（配信中に外部へ取りに行かないため）。
 * - src/town-tour/towns.json: 引く対象の市町村の一覧（コード・都道府県・郡・名前）
 * - public/town-tour/japan.topo.json: 市町村ごとの形を簡略化した TopoJSON（各形の properties.code が一覧のコード）
 *
 * 政令市の区は市にまとめ、どの市町村にも属さない「所属未定地」は一覧からも地図からも外す。
 * 形の結合と簡略化は mapshaper の CLI に任せる。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** N03 の1件分の属性（都道府県・郡または政令市・市区町村・政令市の区・行政区域コード）。無い項目は空文字になる */
export type N03Record = {
  N03_001: string
  N03_003: string
  N03_004: string
  N03_005: string
  N03_007: string
}

/** 引く対象の市町村1件 */
export type Town = {
  /** 全国地方公共団体コード（検査数字を除く5桁）。政令市は区ではなく市のコード */
  code: string
  prefecture: string
  /** 郡名（郡に属さないときは空文字）。同名の村（古宇郡泊村と国後郡泊村）を見分けるのに使う */
  county: string
  name: string
}

/**
 * 政令市の市のコード（キーは都道府県名＋市名）
 *
 * N03 は政令市を区の単位でしか持たず、市そのもののコードが無い。区のコードから市のコードは機械的に導けない
 * （札幌市清田区は 01110 だが札幌市は 01100、浜松市の区は 22138〜 だが浜松市は 22130）ので、表で持つ。
 */
const DESIGNATED_CITY_CODES: ReadonlyMap<string, string> = new Map([
  ['北海道札幌市', '01100'],
  ['宮城県仙台市', '04100'],
  ['埼玉県さいたま市', '11100'],
  ['千葉県千葉市', '12100'],
  ['神奈川県横浜市', '14100'],
  ['神奈川県川崎市', '14130'],
  ['神奈川県相模原市', '14150'],
  ['新潟県新潟市', '15100'],
  ['静岡県静岡市', '22100'],
  ['静岡県浜松市', '22130'],
  ['愛知県名古屋市', '23100'],
  ['京都府京都市', '26100'],
  ['大阪府大阪市', '27100'],
  ['大阪府堺市', '27140'],
  ['兵庫県神戸市', '28100'],
  ['岡山県岡山市', '33100'],
  ['広島県広島市', '34100'],
  ['福岡県北九州市', '40100'],
  ['福岡県福岡市', '40130'],
  ['熊本県熊本市', '43100'],
])

/** どの市町村にも属さない区域（埋立地など）の N03 上の名前 */
const UNAFFILIATED_NAME = '所属未定地'

/**
 * N03 の属性を、引く対象の市町村の一覧に直す
 *
 * 政令市の区は市にまとめ、所属未定地は外す。一覧はコードの順に並べる。
 * townCodeByAreaCode は N03 の行政区域コード（政令市では区のコード）から一覧のコードを引く表で、地図の形をまとめるのに使う。
 *
 * @throws 市のコードを知らない政令市が現れたとき（政令市が増えたら DESIGNATED_CITY_CODES に足す）
 */
export const buildTowns = (
  records: readonly N03Record[],
): { towns: Town[]; townCodeByAreaCode: Map<string, string> } => {
  const townByCode = new Map<string, Town>()
  const townCodeByAreaCode = new Map<string, string>()
  for (const record of records) {
    if (record.N03_004 === UNAFFILIATED_NAME) continue
    const town = record.N03_005 === '' ? municipalityOf(record) : designatedCityOf(record)
    townByCode.set(town.code, town)
    townCodeByAreaCode.set(record.N03_007, town.code)
  }
  const towns = [...townByCode.values()].sort((a, b) => a.code.localeCompare(b.code))
  return { towns, townCodeByAreaCode }
}

/** 区を持たない市町村（東京23区を含む）を、その行政区域コードのまま1件にする */
const municipalityOf = (record: N03Record): Town => ({
  code: record.N03_007,
  prefecture: record.N03_001,
  county: record.N03_003,
  name: record.N03_004,
})

/** 政令市の区を、その市の1件にする */
const designatedCityOf = (record: N03Record): Town => {
  const key = `${record.N03_001}${record.N03_004}`
  const code = DESIGNATED_CITY_CODES.get(key)
  if (code === undefined) throw new Error(`市のコードを知らない政令市があります: ${key}`)
  return { code, prefecture: record.N03_001, county: '', name: record.N03_004 }
}

/** 地図の簡略化の度合い（残す頂点の割合）。いちばん小さい村（富山県舟橋村）に寄っても形が分かる粗さにしてある */
const SIMPLIFY_PERCENTAGE = '3%'
/** TopoJSON の座標の量子化の細かさ */
const QUANTIZATION = '100000'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const townsPath = join(repositoryRoot, 'src/town-tour/towns.json')
const mapPath = join(repositoryRoot, 'public/town-tour/japan.topo.json')
const mapshaperPath = join(repositoryRoot, 'node_modules/.bin/mapshaper')

/** mapshaper の CLI を実行する（失敗したら例外がそのまま上がる） */
const mapshaper = (...args: string[]): void => {
  execFileSync(mapshaperPath, args, { stdio: 'inherit' })
}

/** N03 の shp から一覧と地図を作り、リポジトリの所定の場所へ書き出す */
const main = (shpPath: string): void => {
  const workDir = mkdtempSync(join(tmpdir(), 'town-tour-'))
  try {
    // 1. 形を捨てて、行政区域ごとの属性だけを取り出す（N03 は島ごとに1件なので、同じ属性のものをまとめる）
    const attributesPath = join(workDir, 'attributes.json')
    mapshaper(shpPath, '-dissolve', 'N03_001,N03_003,N03_004,N03_005,N03_007', '-o', attributesPath, 'format=json')
    const records: N03Record[] = JSON.parse(readFileSync(attributesPath, 'utf8'))
    const { towns, townCodeByAreaCode } = buildTowns(records)

    // 2. 行政区域コードに一覧のコードを結び付け、一覧のコードごとに形をまとめて簡略化する。
    //    結び付かなかった所属未定地は code が空になるので落とす
    const joinPath = join(workDir, 'codes.csv')
    const rows = [...townCodeByAreaCode].map(([areaCode, townCode]) => `${areaCode},${townCode}`)
    writeFileSync(joinPath, ['N03_007,code', ...rows].join('\n'))
    mapshaper(
      shpPath,
      '-join', joinPath, 'keys=N03_007,N03_007', 'string-fields=N03_007,code',
      '-filter', 'Boolean(code)',
      '-dissolve', 'code',
      '-simplify', SIMPLIFY_PERCENTAGE, 'keep-shapes',
      '-rename-layers', 'towns',
      '-o', mapPath, 'format=topojson', `quantization=${QUANTIZATION}`,
    )
    writeFileSync(townsPath, `${JSON.stringify(towns, null, 2)}\n`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

// テストから読み込まれたときは buildTowns だけを使うので、直接実行されたときだけ書き出す
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const shpPath = process.argv[2]
  if (shpPath === undefined) throw new Error('N03 の shp のパスを渡してください')
  main(shpPath)
}
