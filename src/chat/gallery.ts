/**
 * チャットボックスのギャラリー（chat/index.html）のエントリスクリプト
 *
 * プレビューは常にサンプル表示（demo=true）にする。調整のたびにTwitchへ接続し直さないためと、
 * チャンネル名が未入力でも見た目を確かめられるようにするため。OBS用のURLには影響しない。
 */
import { mountGallery } from '../core/gallery/gallery'
import { chats } from './registry'

mountGallery({ definitions: chats, noun: 'チャットボックス', previewOverrides: { demo: true } })
