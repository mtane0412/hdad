/**
 * 管理画面の一覧の組み立て
 *
 * 素材の一覧とトリガーの一覧をDOMの要素として組み立てる。状態（素材・報酬・入力中のトリガー）は持たず、
 * 受け取った内容を描き、操作されたら呼び出し側（stage.ts）へ知らせるだけにする。
 * 文字はすべて textContent や value で入れる（ファイル名や報酬名をHTMLとして解釈させない）。
 */
import type { MediaItem, Reward } from './api'
import { formatBytes, rewardOptions, type SelectOption, type TriggerDraft } from './form'

const MEDIA_PATH = '/api/media/'
const KIND_LABELS = { image: '画像', video: '動画', audio: '音声' } as const
const MIN_DURATION_SECONDS = 1
const MAX_DURATION_SECONDS = 60
const MAX_MESSAGE_LENGTH = 200

/** 素材の中身のURL。管理画面は配信者のセッションで読めるので、オーバーレイ用キーは付けない */
const mediaUrl = (id: string): string => `${MEDIA_PATH}${encodeURIComponent(id)}`

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text) node.textContent = text
  return node
}

/** 素材を小さく試し見・試し聴きするための要素 */
const preview = (item: MediaItem): HTMLElement => {
  if (item.kind === 'image') {
    const image = element('img')
    image.src = mediaUrl(item.id)
    image.alt = ''
    image.loading = 'lazy'
    return image
  }
  const player = element(item.kind)
  player.src = mediaUrl(item.id)
  player.controls = true
  // 一覧を開いただけで全素材を読み込まないようにする（動画は大きい）
  player.preload = 'none'
  player.setAttribute('aria-label', `${item.name} の再生`)
  return player
}

/** 素材の一覧を描き直す */
export const renderMediaList = (list: HTMLElement, media: readonly MediaItem[], onRemove: (item: MediaItem) => void): void => {
  if (media.length === 0) {
    list.replaceChildren(element('li', 'empty', '素材はまだありません。'))
    return
  }
  list.replaceChildren(
    ...media.map((item) => {
      const row = element('li')
      const figure = element('div', 'media-preview')
      figure.append(preview(item))

      const caption = element('div', 'media-caption')
      caption.append(element('strong', '', item.name), element('span', '', `${KIND_LABELS[item.kind]}・${formatBytes(item.size)}`))

      const remove = element('button', 'quiet', '削除')
      remove.type = 'button'
      remove.setAttribute('aria-label', `${item.name} を削除`)
      remove.addEventListener('click', () => onRemove(item))

      row.append(figure, caption, remove)
      return row
    }),
  )
}

const select = (options: readonly SelectOption[], selected: string): HTMLSelectElement => {
  const node = element('select')
  node.append(
    ...options.map((option) => {
      const item = element('option', '', option.label)
      item.value = option.value
      return item
    }),
  )
  node.value = selected
  return node
}

/** ラベルと入力欄を1組にする */
const field = (label: string, control: HTMLElement): HTMLLabelElement => {
  const wrapper = element('label', 'admin-field')
  wrapper.append(element('span', '', label), control)
  return wrapper
}

interface TriggerListOptions {
  drafts: readonly TriggerDraft[]
  media: readonly MediaItem[]
  rewards: readonly Reward[]
  /** 入力欄が書き換えられた（一覧は描き直さない。描き直すと入力中の欄からフォーカスが外れる） */
  onChange(index: number, draft: TriggerDraft): void
  onRemove(index: number): void
}

/** トリガーの一覧を描き直す */
export const renderTriggerList = (list: HTMLElement, { drafts, media, rewards, onChange, onRemove }: TriggerListOptions): void => {
  if (drafts.length === 0) {
    list.replaceChildren(element('li', 'empty', 'トリガーはまだありません。'))
    return
  }

  const mediaOptions = media.map((item) => ({ value: item.id, label: `${item.name}（${KIND_LABELS[item.kind]}）` }))

  list.replaceChildren(
    ...drafts.map((draft, index) => {
      const row = element('li')
      let current = draft
      const update = (patch: Partial<TriggerDraft>): void => {
        current = { ...current, ...patch }
        onChange(index, current)
      }

      const reward = select(rewardOptions(rewards, draft.rewardId), draft.rewardId)
      reward.addEventListener('change', () => update({ rewardId: reward.value }))

      const mediaSelect = select(mediaOptions, draft.mediaId)
      mediaSelect.addEventListener('change', () => update({ mediaId: mediaSelect.value }))

      const duration = element('input')
      duration.type = 'number'
      duration.min = String(MIN_DURATION_SECONDS)
      duration.max = String(MAX_DURATION_SECONDS)
      duration.value = draft.durationSeconds
      duration.addEventListener('input', () => update({ durationSeconds: duration.value }))

      const volume = element('input')
      volume.type = 'range'
      volume.min = '0'
      volume.max = '100'
      volume.value = draft.volumePercent
      const volumeValue = element('output', '', `${draft.volumePercent}%`)
      volume.addEventListener('input', () => {
        volumeValue.textContent = `${volume.value}%`
        update({ volumePercent: volume.value })
      })
      const volumeRow = element('span', 'slider-row')
      volumeRow.append(volume, volumeValue)

      const message = element('input')
      message.type = 'text'
      message.maxLength = MAX_MESSAGE_LENGTH
      message.value = draft.message
      message.placeholder = '{user} さんが「{reward}」を交換しました'
      message.addEventListener('input', () => update({ message: message.value }))

      const remove = element('button', 'quiet', 'このトリガーを外す')
      remove.type = 'button'
      remove.addEventListener('click', () => onRemove(index))

      row.append(
        field('報酬', reward),
        field('素材', mediaSelect),
        field('表示時間（1〜60秒）', duration),
        field('音量', volumeRow),
        field('文言（空欄なら出さない）', message),
        remove,
      )
      return row
    }),
  )
}
