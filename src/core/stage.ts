/**
 * 背景ページ（wallpaper/<id>/index.html）のエントリスクリプト
 *
 * canvas の data-background 属性に書かれた背景IDを、壁紙レジストリから探して起動する。
 */
import { backgrounds } from '../wallpaper/registry'
import { mountStage } from './mount'

mountStage({ definitions: backgrounds, attribute: 'background' })
