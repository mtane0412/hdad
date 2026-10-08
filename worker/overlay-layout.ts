/**
 * 合成オーバーレイの構成（どのオーバーレイにどの素材をどこへ置くか）
 *
 * OBSのブラウザソースはその数だけ Chromium のレンダラを立ち上げるため、素材ごとにページを分けると
 * 配信中のメモリを食う。そこで素材を1枚のページ（overlay/stage/index.html）へ重ね、ブラウザソースは
 * 「オーバーレイ」ごとに1つだけ置く（issue #101・#103）。**ここで言うオーバーレイは、OBSのブラウザソース
 * 1つ＝重なりの1枚**であり、その中に壁紙・時計・チャットといった素材（items）を積む。
 *
 * オーバーレイを複数に分けるのは、アバターやゲーム画面というWebでないソースが間に挟まり、Web側の素材を
 * その前と後ろの両方に置きたいためである。既定では背面（back。壁紙）と前面（front。時計・チャット・
 * サイドスーパー・注目コメント・アラート）の2つを用意し、配信者が増やせる（増やしたときだけOBSへ
 * ブラウザソースを1つ追加する）。名前を固定しておけば、OBSに貼るURLは一度貼ったら変わらず、
 * 「時計を背面から前面へ移す」も「位置を変える」もアプリ上の編集だけで済む
 * （読み上げの設定をURLからWorkerへ移した issue #86 と同じ動機）。
 *
 * 作りは speech-config.ts・moderation-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから
 * 拒む（管理画面で一度に直せるようにするため）。保存先はKVで、読み出しは管理画面
 * （GET /api/admin/overlay/layout）と合成ページ（GET /api/overlay/layout）の2つから通る。
 *
 * 注意: 素材のパラメータは**クエリ文字列のまま**持ち、中身は検証しない。解析するのは
 * src/core/params.ts の parseParams で、それはページ側にある（worker/ から src/ を読み込まない約束の裏返し）。
 * デザインIDも同じ理由でレジストリと照らし合わせず、書式だけを見る（レジストリは src/ にある）。
 * 注意: 位置と大きさは割合（％）で持つ。配信解像度が変わっても崩れないようにするためである。
 * 注意: 素材を1つも持たないオーバーレイは拒む。OBSに貼っても何も映らないURLを作らせないためで、
 * 管理画面は素材のないオーバーレイを送らない（「効果をひとつも持たない行は保存しない」と同じ考え方）。
 */
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'overlay-layout'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = 'オーバーレイの構成'

/** オーバーレイに置ける素材の種類 */
export const ITEM_KINDS = ['wallpaper', 'clock', 'chat', 'alerts', 'sideSuper', 'focus', 'draw', 'bgm', 'tab', 'caption', 'workLog', 'taskDesk', 'pomodoro', 'townTour', 'twister', 'wipe', 'text'] as const

/** オーバーレイに置ける素材の種類 */
export type ItemKind = (typeof ITEM_KINDS)[number]

/**
 * デザインIDを持つ種類。
 *
 * 壁紙・時計・チャットは同じ種類の中にデザインが何種類もあり、レジストリのIDで選ぶ。
 * アラート・サイドスーパー・注目コメントはデザインが1つなのでIDを持たない。
 */
export const KINDS_WITH_ID = ['wallpaper', 'clock', 'chat'] as const satisfies readonly ItemKind[]

/** 既定で用意するオーバーレイの名前。背面（ゲーム画面・アバターより後ろ）と前面（アバターより前） */
export const DEFAULT_OVERLAY_NAMES = ['back', 'front'] as const

/** オーバーレイの上限。OBSに置くブラウザソースの数なので、増え続ける形にはしない */
const MAX_OVERLAYS = 10
/** 1つのオーバーレイに置ける素材の上限。ブラウザソース1つで動かし切れる数に留める */
const MAX_ITEMS = 20
/** デザインIDの長さの上限 */
const MAX_ID_LENGTH = 40
/** デザインIDの書式。レジストリとは照らし合わせず、形だけを見る（レジストリは src/ にある） */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/
/** オーバーレイの名前の書式。OBSに貼るURL（?overlay=）に載るので、大文字や記号を混ぜさせない */
const NAME_PATTERN = /^[a-z0-9-]{1,20}$/
/** パラメータ（クエリ文字列）の長さの上限。壁紙の色が並んでも収まる長さ */
const MAX_PARAMS_LENGTH = 2000
/** 位置（％）の範囲 */
const MIN_POSITION = 0
const MAX_POSITION = 100
/** 大きさ（％）の範囲。1％未満は見えないので置かせない */
const MIN_SIZE = 1
const MAX_SIZE = 100

/** オーバーレイの中での位置と大きさ。オーバーレイの幅・高さに対する割合（％） */
export interface ItemRect {
  /** 左端の位置（％） */
  readonly x: number
  /** 上端の位置（％） */
  readonly y: number
  /** 幅（％） */
  readonly width: number
  /** 高さ（％） */
  readonly height: number
}

/** オーバーレイに積む素材1つ */
export interface OverlayItem {
  /** 素材の種類 */
  readonly kind: ItemKind
  /** デザインID（壁紙・時計・チャットのみ。それ以外は空文字） */
  readonly id: string
  /** その素材のパラメータ（クエリ文字列のまま。中身はページ側が解析する） */
  readonly params: string
  /** オーバーレイの中での位置と大きさ（％） */
  readonly rect: ItemRect
}

/** オーバーレイ1つ（＝OBSのブラウザソース1つ）。items の並びがそのまま重ねる順（あとのものが前）になる */
export interface Overlay {
  /** 名前。OBSに貼るURL（?overlay=）に載るので、変えないかぎりURLは貼り替えなくてよい */
  readonly name: string
  /** 積む素材（並びがそのまま重ねる順） */
  readonly items: readonly OverlayItem[]
}

/** 合成オーバーレイの構成 */
export interface OverlayLayout {
  readonly overlays: readonly Overlay[]
}

/** 未保存のときに使う構成。まだ何も置いていない状態 */
export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = { overlays: [] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const hasId = (kind: ItemKind): boolean => (KINDS_WITH_ID as readonly ItemKind[]).includes(kind)

/**
 * 管理画面から送られてきた構成を検証し、保存用の形にする。
 *
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseOverlayLayout = (input: unknown): OverlayLayout => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['構成はオブジェクトで指定してください'])
  const rawOverlays = input.overlays
  if (!Array.isArray(rawOverlays)) throw new ConfigError(SUBJECT, ['overlays: 配列で指定してください'])
  if (rawOverlays.length > MAX_OVERLAYS) {
    throw new ConfigError(SUBJECT, [`overlays: オーバーレイは${MAX_OVERLAYS}個以内にしてください`])
  }

  const problems: string[] = []
  /** すでに出てきた名前。同じ名前が2つあると、1つのURLで2通りの中身になってしまう */
  const seenNames = new Set<string>()
  /**
   * ワイプをすでに読んだか。ワイプはそれぞれがチャットを読み上げるので、構成全体で2つあると
   * （別々のオーバーレイでも）同じ発言が二重に読まれる
   */
  let wipeSeen = false

  /** 素材1件を読む。読めなければ問題点を積んで空を返し、並びから外す */
  const readItem = (raw: unknown, at: string): OverlayItem[] => {
    if (!isRecord(raw)) {
      problems.push(`${at}: 素材はオブジェクトで指定してください`)
      return []
    }

    const kind = raw.kind
    if (typeof kind !== 'string' || !(ITEM_KINDS as readonly string[]).includes(kind)) {
      // 種類が決まらないとIDの要否も判断できないので、この1件はここで諦める
      problems.push(`${at}.kind: ${ITEM_KINDS.join(' / ')} のいずれかで指定してください`)
      return []
    }
    const itemKind = kind as ItemKind
    if (itemKind === 'wipe') {
      if (wipeSeen) {
        problems.push(`${at}: ワイプは構成全体で1つまでにしてください（それぞれがチャットを読み上げ、同じ発言が二重に読まれるため）`)
        return []
      }
      wipeSeen = true
    }

    /** デザインIDを読む。持つ種類では空でないこと、持たない種類では空であることを見る */
    const readId = (): string => {
      const value = raw.id
      if (typeof value !== 'string') {
        problems.push(`${at}.id: 文字列で指定してください`)
        return ''
      }
      if (hasId(itemKind)) {
        if (ID_PATTERN.test(value)) return value
        problems.push(`${at}.id: デザインIDを指定してください（英数字と下線・ハイフン、${MAX_ID_LENGTH}文字まで）`)
        return ''
      }
      if (value === '') return ''
      problems.push(`${at}.id: ${itemKind} はデザインIDを持たないので、空文字にしてください`)
      return ''
    }

    /** パラメータを読む。中身は見ず、クエリ文字列として渡せる形かだけを見る */
    const readParams = (): string => {
      const value = raw.params
      if (typeof value !== 'string') {
        problems.push(`${at}.params: クエリ文字列（speed=2&colors=ff8ad8 の形）で指定してください`)
        return ''
      }
      if (value.startsWith('?')) {
        problems.push(`${at}.params: 先頭の ? は付けないでください`)
        return ''
      }
      if (value.length > MAX_PARAMS_LENGTH) {
        problems.push(`${at}.params: ${MAX_PARAMS_LENGTH}文字以内にしてください`)
        return ''
      }
      return value
    }

    /** 位置と大きさを読む。割合（％）なので、範囲の外は拒む */
    const readRect = (): ItemRect => {
      const value = raw.rect
      if (!isRecord(value)) {
        problems.push(`${at}.rect: 位置と大きさを { x, y, width, height } の割合（％）で指定してください`)
        return { x: 0, y: 0, width: 100, height: 100 }
      }
      const readNumber = (name: 'x' | 'y' | 'width' | 'height', min: number, max: number): number => {
        const rawValue = value[name]
        if (typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue >= min && rawValue <= max) return rawValue
        problems.push(`${at}.rect.${name}: ${min}〜${max} の数（％）で指定してください`)
        return min
      }
      // 呼ぶ順番が、問題点に並ぶ順番になる
      return {
        x: readNumber('x', MIN_POSITION, MAX_POSITION),
        y: readNumber('y', MIN_POSITION, MAX_POSITION),
        width: readNumber('width', MIN_SIZE, MAX_SIZE),
        height: readNumber('height', MIN_SIZE, MAX_SIZE),
      }
    }

    // 呼ぶ順番が、問題点に並ぶ順番になる
    const id = readId()
    const params = readParams()
    const rect = readRect()
    return [{ kind: itemKind, id, params, rect }]
  }

  /** オーバーレイ1つを読む。名前が読めなければ問題点を積んで空を返し、並びから外す */
  const readOverlay = (raw: unknown, index: number): Overlay[] => {
    const at = `overlays[${index}]`
    if (!isRecord(raw)) {
      problems.push(`${at}: オーバーレイはオブジェクトで指定してください`)
      return []
    }

    const name = raw.name
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      problems.push(`${at}.name: オーバーレイの名前は英小文字・数字・ハイフン（20文字まで）で指定してください`)
      return []
    }
    if (seenNames.has(name)) {
      problems.push(`${at}.name: 「${name}」という名前のオーバーレイが2つあります`)
      return []
    }
    seenNames.add(name)

    const rawItems = raw.items
    if (!Array.isArray(rawItems)) {
      problems.push(`${at}.items: 配列で指定してください`)
      return []
    }
    if (rawItems.length === 0) {
      problems.push(`${at}.items: 素材を1つ以上置いてください（素材のないオーバーレイは貼っても何も映りません）`)
      return []
    }
    if (rawItems.length > MAX_ITEMS) {
      problems.push(`${at}.items: 素材は${MAX_ITEMS}件以内にしてください`)
      return []
    }

    const items = rawItems.flatMap((rawItem: unknown, itemIndex) => readItem(rawItem, `${at}.items[${itemIndex}]`))
    return [{ name, items }]
  }

  const overlays = rawOverlays.flatMap((raw: unknown, index) => readOverlay(raw, index))

  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return { overlays }
}

export const saveOverlayLayout = (store: KeyValueStore, layout: OverlayLayout): Promise<void> =>
  store.put(CONFIG_KEY, JSON.stringify(layout))

/**
 * 保存済みの構成を読む。未保存ならオーバーレイが1つもない構成を返す。
 *
 * 注意: 保存されている形が古ければ（オーバーレイごとに分ける前の平らな形）読み替えずにエラーにし、
 * 直し方（KVのキーを消して保存し直す）を文面に出す（loadAlertConfig・loadLlmSettings と同じ考え方。
 * 開発中で後方互換を保つ必要がないため、暗黙の読み替えを増やさない）。
 */
export const loadOverlayLayout = async (store: KeyValueStore): Promise<OverlayLayout> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return DEFAULT_OVERLAY_LAYOUT
  try {
    return parseOverlayLayout(JSON.parse(text))
  } catch (error) {
    throw new Error(
      `保存されている${SUBJECT}を読めません（${error instanceof Error ? error.message : String(error)}）。KVの ${CONFIG_KEY} を消してから、管理画面で保存し直してください`,
      { cause: error },
    )
  }
}
