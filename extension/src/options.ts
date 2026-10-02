/**
 * 拡張の設定ページ（options.html。Worker が zip に書く。中身は extension/src/built-files.ts）の入口
 *
 * 映さないサイトの一覧を出し、ホスト名を入力して登録し、消す。中身は options-page.ts にあり、ここは
 * サービスワーカーへの頼み方（chrome.runtime.sendMessage）をつなぐだけにする。
 */
import { mountOptionsPage, sendToServiceWorker } from './options-page'

mountOptionsPage(document.body, sendToServiceWorker)
