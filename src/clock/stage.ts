/**
 * 時計ページ（clock/<id>/index.html）のエントリスクリプト
 *
 * canvas の data-clock 属性に書かれた時計IDを、時計レジストリから探して起動する。
 */
import { mountStage } from '../core/mount'
import { clocks } from './registry'

mountStage({ definitions: clocks, attribute: 'clock' })
