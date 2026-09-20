/**
 * 時計ギャラリー（clock/index.html）のエントリスクリプト
 */
import { mountGallery } from '../core/gallery/gallery'
import { clocks } from './registry'

mountGallery({ definitions: clocks, noun: '時計' })
