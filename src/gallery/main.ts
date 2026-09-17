/**
 * ギャラリー（トップページ）の操作
 *
 * レジストリの背景を一覧し、スキーマから調整用の入力欄を自動生成する。
 * 入力のたびにプレビューとOBS用URLを更新する。選択中の背景はURLのハッシュ（#contour など）に保持する。
 */
import { backgrounds } from '../backgrounds/registry'
import type { BackgroundDefinition } from '../core/background'
import type { ColorParamSpec, ColorsParamSpec, NumberParamSpec, ParamSpec } from '../core/params'
import { buildBackgroundUrl } from './url'

type Value = number | string | readonly string[]
type Values = Record<string, Value>

/** プレビューが実寸として描画する幅（px）。OBSの一般的なキャンバス幅に合わせる */
const PREVIEW_WIDTH = 1920
/** 入力中にプレビューを再読み込みしすぎないための待ち時間（ミリ秒） */
const PREVIEW_DELAY_MS = 150
/** 小数パラメータのスライダーの刻み */
const DECIMAL_STEP = 0.05
/** 透過を解除したときに戻す色が既定値から得られない場合の色 */
const OPAQUE_FALLBACK_COLOR = '#000000'
/** 配色に色を足すときの初期色 */
const ADDED_COLOR = '#ffffff'

const byId = <T extends HTMLElement>(id: string, type: new () => T): T => {
  const element = document.getElementById(id)
  if (!(element instanceof type)) throw new Error(`#${id} の要素が見つかりません`)
  return element
}

const shelf = byId('shelf', HTMLUListElement)
const screen = byId('screen', HTMLDivElement)
const preview = byId('preview', HTMLIFrameElement)
const title = byId('current-title', HTMLHeadingElement)
const description = byId('current-description', HTMLParagraphElement)
const controls = byId('controls', HTMLFormElement)
const resetButton = byId('reset', HTMLButtonElement)
const urlField = byId('url', HTMLInputElement)
const copyButton = byId('copy', HTMLButtonElement)
const copyStatus = byId('copy-status', HTMLParagraphElement)

const defaultsOf = (definition: BackgroundDefinition): Values =>
  Object.fromEntries(Object.entries(definition.schema).map(([name, spec]) => [name, spec.default]))

const [firstBackground] = backgrounds
if (!firstBackground) throw new Error('レジストリに背景が1つも登録されていません')

let current = firstBackground
let values = defaultsOf(current)
let previewTimer: number | undefined

/** 値の変更をURL欄とプレビューへ反映する。プレビューは入力が落ち着いてから読み込み直す */
const publish = (): void => {
  const url = buildBackgroundUrl(location.href, current.id, current.schema, values)
  urlField.value = url
  copyStatus.textContent = ''
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => {
    // iframe の src を直接変えると履歴が積まれるため、replace で置き換える
    preview.contentWindow?.location.replace(url)
  }, PREVIEW_DELAY_MS)
}

const createField = (name: string, labelText: string): HTMLFieldSetElement => {
  const field = document.createElement('fieldset')
  field.className = 'field'
  const head = document.createElement('legend')
  head.textContent = `${labelText} `
  const code = document.createElement('code')
  code.textContent = name
  head.append(code)
  field.append(head)
  return field
}

const createColorInput = (label: string, value: string, onInput: (color: string) => void) => {
  const input = document.createElement('input')
  input.type = 'color'
  input.value = value
  input.setAttribute('aria-label', label)
  input.addEventListener('input', () => onInput(input.value))
  return input
}

const renderNumber = (name: string, spec: NumberParamSpec): HTMLElement => {
  const field = createField(name, spec.description)
  const output = document.createElement('output')
  output.textContent = String(values[name])

  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = String(spec.min)
  slider.max = String(spec.max)
  slider.step = String(spec.integer ? 1 : DECIMAL_STEP)
  slider.value = String(values[name])
  slider.setAttribute('aria-label', spec.description)
  slider.addEventListener('input', () => {
    values[name] = slider.valueAsNumber
    output.textContent = slider.value
    publish()
  })

  const row = document.createElement('div')
  row.className = 'slider-row'
  row.append(slider, output)
  field.append(row)
  return field
}

const renderColor = (name: string, spec: ColorParamSpec): HTMLElement => {
  const field = createField(name, spec.description)
  const row = document.createElement('div')
  row.className = 'swatches'

  const currentValue = String(values[name])
  const isTransparent = currentValue === 'transparent'
  const opaqueDefault = spec.default === 'transparent' ? OPAQUE_FALLBACK_COLOR : spec.default
  const picker = createColorInput(spec.description, isTransparent ? opaqueDefault : currentValue, (color) => {
    values[name] = color
    publish()
  })
  picker.disabled = isTransparent
  row.append(picker)

  if (spec.allowTransparent) {
    const check = document.createElement('label')
    check.className = 'check'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = isTransparent
    box.addEventListener('change', () => {
      values[name] = box.checked ? 'transparent' : picker.value
      picker.disabled = box.checked
      publish()
    })
    check.append(box, '透過にする')
    row.append(check)
  }

  field.append(row)
  return field
}

const renderColors = (name: string, spec: ColorsParamSpec): HTMLElement => {
  const field = createField(name, spec.description)
  const row = document.createElement('div')
  row.className = 'swatches'

  const value = values[name]
  const colors = Array.isArray(value) ? [...value] : [...spec.default]
  /** 色の数が変わる操作は入力欄の作り直しが必要なので、全体を描き直す */
  const resize = (next: string[]): void => {
    values[name] = next
    renderControls()
    publish()
  }

  colors.forEach((color, index) => {
    row.append(
      createColorInput(`${spec.description} ${index + 1}色目`, color, (picked) => {
        colors[index] = picked
        values[name] = [...colors]
        publish()
      }),
    )
  })

  const add = document.createElement('button')
  add.type = 'button'
  add.textContent = '色を足す'
  add.disabled = colors.length >= spec.maxCount
  add.addEventListener('click', () => resize([...colors, ADDED_COLOR]))

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.textContent = '色を減らす'
  remove.disabled = colors.length <= spec.minCount
  remove.addEventListener('click', () => resize(colors.slice(0, -1)))

  row.append(add, remove)
  field.append(row)
  return field
}

const renderParam = (name: string, spec: ParamSpec): HTMLElement => {
  switch (spec.type) {
    case 'number':
      return renderNumber(name, spec)
    case 'color':
      return renderColor(name, spec)
    case 'colors':
      return renderColors(name, spec)
  }
}

function renderControls(): void {
  controls.replaceChildren(
    ...Object.entries(current.schema).map(([name, spec]) => renderParam(name, spec)),
  )
}

const renderShelf = (): void => {
  shelf.replaceChildren(
    ...backgrounds.map((background) => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = background.title
      button.setAttribute('aria-current', String(background.id === current.id))
      button.addEventListener('click', () => {
        location.hash = background.id
      })
      item.append(button)
      return item
    }),
  )
}

const select = (definition: BackgroundDefinition): void => {
  current = definition
  values = defaultsOf(definition)
  title.textContent = definition.title
  description.textContent = definition.description
  renderShelf()
  renderControls()
  publish()
}

/** ハッシュが指す背景を選ぶ。ハッシュなしは先頭の背景、未登録のIDはエラーにする */
const selectFromHash = (): void => {
  const id = location.hash.slice(1)
  if (id === '') {
    select(firstBackground)
    return
  }
  const definition = backgrounds.find((background) => background.id === id)
  if (!definition) {
    title.textContent = `背景「${id}」は登録されていません`
    description.textContent = '左の一覧から背景を選んでください。'
    return
  }
  select(definition)
}

resetButton.addEventListener('click', () => select(current))

/** コピーできなかったことを伝え、手動でコピーできるようURL欄を選択状態にする */
const reportCopyFailure = (): void => {
  urlField.select()
  copyStatus.textContent = 'URLをコピーできませんでした。URL欄を選択したので、手動でコピーしてください。'
}

copyButton.addEventListener('click', () => {
  // Clipboard API は https か localhost でしか提供されず、それ以外では navigator.clipboard が undefined になる。
  // 型定義上は常に存在する扱いだが、実行時には無い場合があるので確認する
  if (!navigator.clipboard) {
    reportCopyFailure()
    return
  }
  navigator.clipboard.writeText(urlField.value).then(() => {
    copyStatus.textContent = 'URLをコピーしました。OBSの「ソース > ブラウザ」のURL欄に貼り付けてください。'
  }, reportCopyFailure)
})

// プレビューは 1920px 幅の実寸で描画し、表示枠の幅に合わせて縮小する
new ResizeObserver(([entry]) => {
  if (!entry) return
  screen.style.setProperty('--preview-scale', String(entry.contentRect.width / PREVIEW_WIDTH))
}).observe(screen)

window.addEventListener('hashchange', selectFromHash)
selectFromHash()
