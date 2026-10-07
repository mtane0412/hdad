/**
 * アプリ内のページ移動
 *
 * ページUIは決まった数のパス（/・/wallpaper/ など）しか持たないので、ルーティングのライブラリは使わず、
 * History API で現在のパスを持つだけにする。Link は普通の <a> なので、新しいタブで開く操作などはブラウザに任せる。
 *
 * 未保存の変更があるページ（useUnsavedChanges で知らせたページ）からの移動は、すぐには行わず確認を待つ
 * （usePendingNavigation）。止めるのは navigate（Link とページを探す窓が使う）とブラウザの「戻る・進む」の両方で、
 * 再読み込みとタブを閉じる操作は beforeunload でブラウザに止めてもらう。ページは移った時点で作り直され、
 * 編集中の内容が黙って消えるため（issue #182）。
 *
 * ページの外（WebMCP のツール）が設定を保存したときは、reloadPage で今のページを作り直して読み直させる。
 *
 * 注意: OBSに載せるページ（/overlay/stage/ など）と /api/* はアプリの外にある。Link では開かず、普通の <a> で開くこと。
 */
import { useEffect, useSyncExternalStore } from 'react'

/** 確認を待っている移動。どちらかを呼ぶと確認は終わる */
export interface PendingNavigation {
  /** 未保存の変更を捨てて移る */
  proceed(): void
  /** 移らずに今のページに留まる */
  stay(): void
}

/** 未保存の変更があるページ。「戻る」で変わったURLを元に戻すため、そのページの履歴の位置も持つ */
interface Blocker {
  pathname: string
  index: number
}

/** 末尾のスラッシュの有無を区別しない（/chat と /chat/ は同じページ） */
const normalize = (pathname: string): string => (pathname.endsWith('/') ? pathname : `${pathname}/`)

/**
 * 履歴の項目の位置。navigate で積むたびに1つ進め、「戻る・進む」でいくつ動いたかを知るのに使う。
 * 位置を持たない項目（URLを直接開いたとき）は先頭（0）として扱う。
 */
const historyIndex = (state: unknown): number =>
  typeof state === 'object' && state !== null && 'index' in state && typeof state.index === 'number' ? state.index : 0

const blockers = new Set<Blocker>()
let pending: PendingNavigation | null = null
/** 「戻る」を止めてURLを元に戻しているあいだ、画面に出し続けるパス（URLはまだ移った先を指している） */
let held: string | null = null
/** 確認で「移る」を選んだ「戻る・進む」。次の popstate だけは止めない */
let allowNextPop = false

const listeners = new Set<() => void>()
const notify = (): void => {
  for (const listener of listeners) listener()
}
const subscribe = (onChange: () => void): (() => void) => {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

const setPending = (next: PendingNavigation | null): void => {
  pending = next
  notify()
}

/** 未保存の変更があるページのうち1つ（同時に開けるページは1つなので、どれでもそのページを指す） */
const firstBlocker = (): Blocker | undefined => blockers.values().next().value

const pushPath = (href: string): void => {
  window.history.pushState({ index: historyIndex(window.history.state) + 1 }, '', href)
  window.scrollTo(0, 0)
  notify()
}

window.addEventListener('popstate', (event) => {
  const index = historyIndex(event.state)
  const blocker = firstBlocker()
  if (allowNextPop || blocker === undefined) {
    allowNextPop = false
    held = null
    notify()
    return
  }
  if (index === blocker.index) {
    // 止めた「戻る」を元に戻し終えた（URLが未保存のページへ戻った）
    held = null
    notify()
    return
  }
  // URLはもう移った先を指しているので、未保存のページの位置まで戻し、そのあいだも同じページを出し続ける
  const delta = blocker.index - index
  held = blocker.pathname
  window.history.go(delta)
  setPending({
    proceed: () => {
      setPending(null)
      allowNextPop = true
      window.history.go(-delta)
    },
    stay: () => setPending(null),
  })
})

/** 現在のパス（末尾は必ずスラッシュ）。移動のたびに描き直される */
export const usePathname = (): string => useSyncExternalStore(subscribe, () => held ?? normalize(window.location.pathname))

/**
 * 再読み込みなしでアプリ内のパスへ移動する。移った先は先頭から見せる（前のページのスクロール位置を持ち越さない）。
 * 未保存の変更があるページからは、確認で「移る」が選ばれるまで移らない
 */
export const navigate = (href: string): void => {
  const target = normalize(new URL(href, window.location.href).pathname)
  const blocker = firstBlocker()
  // 今のページへの移動はページを作り直さず、編集中の内容も消えないので確かめない
  if (blocker === undefined || target === blocker.pathname) {
    pushPath(href)
    return
  }
  setPending({
    proceed: () => {
      setPending(null)
      pushPath(href)
    },
    stay: () => setPending(null),
  })
}

/** 確認を待っている移動。なければ null */
export const usePendingNavigation = (): PendingNavigation | null => useSyncExternalStore(subscribe, () => pending)

/** beforeunload でブラウザに確認を出してもらう（文面はブラウザが決め、こちらからは変えられない） */
const preventUnload = (event: BeforeUnloadEvent): void => event.preventDefault()

/**
 * このページに未保存の変更があるかを知らせる。true のあいだは、ページを離れる前に確認を出す。
 *
 * 注意: 読み込み中など、まだ比べる基準（保存済みの中身）が無いあいだは false を渡すこと
 */
export const useUnsavedChanges = (unsaved: boolean): void => {
  useEffect(() => {
    if (!unsaved) return
    const blocker: Blocker = { pathname: normalize(window.location.pathname), index: historyIndex(window.history.state) }
    blockers.add(blocker)
    window.addEventListener('beforeunload', preventUnload)
    return () => {
      blockers.delete(blocker)
      window.removeEventListener('beforeunload', preventUnload)
    }
  }, [unsaved])
}

/**
 * いま開いているページに未保存の変更があるか。フックの外（WebMCP のツール。src/webmcp/settings-tools.ts）から読むためのもの
 */
export const hasUnsavedChanges = (): boolean => blockers.size > 0

/** 今のページを作り直した回数。アプリの枠がページの key に含め、増えたらページを作り直す */
let reloads = 0

/**
 * 今のページを作り直し、保存済みの中身を読み直させる。
 *
 * ページの外（WebMCP のツール）が設定を保存したとき、開いているページに古い中身を出し続けさせないために使う。
 * 注意: 編集中の内容は消えるので、未保存の変更があるとき（hasUnsavedChanges）は呼ばないこと
 */
export const reloadPage = (): void => {
  reloads += 1
  notify()
}

/** 今のページを作り直した回数（アプリの枠がページの key に使う） */
export const usePageReloads = (): number => useSyncExternalStore(subscribe, () => reloads)

/** 修飾キーなしの左クリックだけをアプリ内の移動として扱う（Cmd+クリックで新しいタブに開く操作などを奪わない） */
const isPlainLeftClick = (event: React.MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** アプリ内のページへのリンク */
export const Link = ({ href, onClick, ...props }: React.ComponentProps<'a'> & { href: string }) => (
  <a
    {...props}
    href={href}
    onClick={(event) => {
      onClick?.(event)
      if (event.defaultPrevented || !isPlainLeftClick(event)) return
      event.preventDefault()
      navigate(href)
    }}
  />
)
