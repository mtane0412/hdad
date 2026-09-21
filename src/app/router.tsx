/**
 * アプリ内のページ移動
 *
 * ページUIは決まった数のパス（/・/wallpaper/ など）しか持たないので、ルーティングのライブラリは使わず、
 * History API で現在のパスを持つだけにする。Link は普通の <a> なので、新しいタブで開く操作などはブラウザに任せる。
 *
 * 注意: 素材ページ（/wallpaper/<id>/ など）と /api/* はアプリの外にある。Link では開かず、普通の <a> で開くこと。
 */
import { useSyncExternalStore } from 'react'

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

/** 末尾のスラッシュの有無を区別しない（/chat と /chat/ は同じページ） */
const normalize = (pathname: string): string => (pathname.endsWith('/') ? pathname : `${pathname}/`)

/** 現在のパス（末尾は必ずスラッシュ）。移動のたびに描き直される */
export const usePathname = (): string => useSyncExternalStore(subscribe, () => normalize(window.location.pathname))

/** 再読み込みなしでアプリ内のパスへ移動する */
export const navigate = (href: string): void => {
  window.history.pushState(null, '', href)
  // pushState は popstate を起こさないので、自分で知らせる
  window.dispatchEvent(new PopStateEvent('popstate'))
}

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
