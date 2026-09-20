/**
 * 壁紙ギャラリー（wallpaper/index.html）のエントリスクリプト
 */
import { mountGallery } from '../core/gallery/gallery'
import { backgrounds } from './registry'

mountGallery({ definitions: backgrounds, noun: '背景' })
