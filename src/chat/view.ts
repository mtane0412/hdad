/**
 * チャット欄の表示（HTML要素の組み立てと出し入れ）
 *
 * 全デザイン共通のHTML構造を作る。見た目は各デザインのCSS（src/chat/<id>.css）が決める。
 *   <ol class="chat" data-chat="<id>">
 *     <li class="chat-message" data-id data-login>
 *       <p class="chat-reply">返信元の名前: 返信元の本文</p>
 *       <span class="chat-name">
 *         <time class="chat-time">時分</time>（バッジのSVG）<span class="chat-months">月数</span>
 *         <span class="chat-flag">初見</span><span>名前</span><span class="chat-bits">ビッツ数</span>
 *       </span>
 *       <p class="chat-body">文字 <img class="chat-emote" /> 文字</p>
 *     </li>
 *   </ol>
 *
 * 注意: 視聴者が書いた文字列は必ず textContent / 属性値として入れ、innerHTML は使わない（XSS対策）。
 */
import { readableTextColor, type Badge, type ChatMessage, type ReplyParent } from './message'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const MILLISECONDS_PER_SECOND = 1000
/** 新しい書き込みが入るとき、一覧全体がせり上がるのにかける時間（ミリ秒） */
const SLIDE_DURATION_MS = 260
/** 消えていくアニメーションの時間（ミリ秒）。CSS側の .is-leaving と合わせる */
const LEAVE_DURATION_MS = 400

/** 自前のバッジアイコン（16×16 の単色パス）。公式のバッジ画像は認証付きAPIが必要なため使わない */
const BADGE_ICONS: Readonly<Record<Badge, { readonly label: string; readonly path: string }>> = {
  broadcaster: {
    label: '配信者',
    path: 'M2 4h8a1 1 0 0 1 1 1v1.5l3.5-2v7L11 9.5V11a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  },
  moderator: { label: 'モデレーター', path: 'M8 1l6 2v5c0 3.5-2.5 6-6 7-3.5-1-6-3.5-6-7V3z' },
  vip: { label: 'VIP', path: 'M8 1.5l6.5 5.5L8 15 1.5 7z' },
  subscriber: {
    label: 'サブスクライバー',
    path: 'M8 1l2.1 4.6 5 .5-3.7 3.4 1 4.9L8 12l-4.4 2.4 1-4.9L.9 6.1l5-.5z',
  },
}

/** 表示の設定 */
export interface ChatViewOptions {
  /** 同時に表示する件数 */
  readonly max: number
  /** 書き込みを消すまでの秒数（0 で消さない） */
  readonly lifetime: number
  /** バッジを表示するか */
  readonly badges: boolean
  /** 書き込まれた時刻を表示するか */
  readonly timestamps: boolean
}

/** チャット欄の操作 */
export interface ChatView {
  add(message: ChatMessage): void
  /** 接続状況など、システムからのお知らせを1行表示する */
  addNotice(text: string): void
  removeById(id: string): void
  removeByLogin(login: string): void
  clear(): void
}

const createBadge = (badge: Badge): SVGElement => {
  const { label, path } = BADGE_ICONS[badge]
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg')
  svg.setAttribute('class', 'chat-badge')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  const shape = document.createElementNS(SVG_NAMESPACE, 'path')
  shape.setAttribute('d', path)
  svg.append(shape)
  return svg
}

/** class と文字だけを持つ要素を作る（返信元・目印・月数・ビッツで使い回す） */
const createLabel = (className: string, text: string): HTMLSpanElement => {
  const element = document.createElement('span')
  element.className = className
  element.textContent = text
  return element
}

/** 返信元の引用行。返信元の本文はエモートの位置が届かないため、文字のまま出す */
const createReply = (reply: ReplyParent): HTMLParagraphElement => {
  const element = document.createElement('p')
  element.className = 'chat-reply'
  element.textContent = `${reply.displayName}: ${reply.body}`
  return element
}

/** 書き込まれた時刻（時分）。並べ替えや読み上げのため、datetime 属性に機械可読な時刻も入れる */
const createTime = (sentAt: number): HTMLTimeElement => {
  const element = document.createElement('time')
  element.className = 'chat-time'
  const sent = new Date(sentAt)
  element.dateTime = sent.toISOString()
  const hours = String(sent.getHours()).padStart(2, '0')
  const minutes = String(sent.getMinutes()).padStart(2, '0')
  element.textContent = `${hours}:${minutes}`
  return element
}

/** 初回・久しぶりの視聴者に付ける目印。どちらでもなければ undefined */
const flagOf = (message: ChatMessage): string | undefined => {
  if (message.firstMessage) return '初見'
  if (message.returningChatter) return 'おかえり'
  return undefined
}

const classNameOf = (message: ChatMessage): string => {
  const names = ['chat-message']
  if (message.action) names.push('is-action')
  if (message.firstMessage) names.push('is-first')
  if (message.returningChatter) names.push('is-returning')
  if (message.bits > 0) names.push('is-cheer')
  return names.join(' ')
}

const createMessageElement = (message: ChatMessage, options: ChatViewOptions): HTMLLIElement => {
  const item = document.createElement('li')
  item.className = classNameOf(message)
  item.dataset.id = message.id
  item.dataset.login = message.login

  const name = document.createElement('span')
  name.className = 'chat-name'
  name.style.setProperty('--name-color', message.color)
  name.style.setProperty('--name-text', readableTextColor(message.color))
  if (options.timestamps && message.sentAt !== undefined) name.append(createTime(message.sentAt))
  if (options.badges) {
    name.append(...message.badges.map(createBadge))
    if (message.subscriberMonths > 0) {
      const months = createLabel('chat-months', String(message.subscriberMonths))
      months.title = `サブスク${message.subscriberMonths}ヶ月`
      name.append(months)
    }
  }
  const flag = flagOf(message)
  if (flag !== undefined) name.append(createLabel('chat-flag', flag))
  name.append(createLabel('chat-name-text', message.displayName))
  if (message.bits > 0) {
    const bits = createLabel('chat-bits', String(message.bits))
    bits.title = `${message.bits}ビッツ`
    name.append(bits)
  }

  const body = document.createElement('p')
  body.className = 'chat-body'
  body.append(
    ...message.fragments.map((fragment) => {
      if (fragment.type === 'text') return fragment.text
      const image = document.createElement('img')
      image.className = 'chat-emote'
      image.src = fragment.url
      image.alt = fragment.name
      return image
    }),
  )

  if (message.reply !== undefined) item.append(createReply(message.reply))
  item.append(name, body)
  return item
}

/**
 * チャット欄を作る。
 *
 * @param root 書き込みを並べる要素（ol.chat）
 */
export const createChatView = (root: HTMLElement, options: ChatViewOptions): ChatView => {
  const items = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(':scope > li')]

  const insert = (item: HTMLElement): void => {
    root.append(item)
    for (const overflowed of items().slice(0, -options.max)) overflowed.remove()

    // 新しい1件の高さぶん下げた位置から元の位置へ動かし、一覧全体がなめらかにせり上がるように見せる
    const lift = item.getBoundingClientRect().height
    root.animate([{ transform: `translateY(${lift}px)` }, { transform: 'none' }], {
      duration: SLIDE_DURATION_MS,
      easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)',
    })

    if (options.lifetime > 0) {
      window.setTimeout(() => {
        item.classList.add('is-leaving')
        window.setTimeout(() => item.remove(), LEAVE_DURATION_MS)
      }, options.lifetime * MILLISECONDS_PER_SECOND)
    }
  }

  return {
    add: (message) => insert(createMessageElement(message, options)),
    addNotice: (text) => {
      const item = document.createElement('li')
      item.className = 'chat-notice'
      item.textContent = text
      insert(item)
    },
    removeById: (id) => {
      for (const item of items()) if (item.dataset.id === id) item.remove()
    },
    removeByLogin: (login) => {
      for (const item of items()) if (item.dataset.login === login) item.remove()
    },
    clear: () => root.replaceChildren(),
  }
}
