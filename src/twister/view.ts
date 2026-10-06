/**
 * ツイスターの描画（three.js の3Dと、上に重ねる2Dの文言・スピナー）
 *
 * 3Dは WebGL の canvas に、マット・2人の人形・顔のアイコンを描く。人形は関節に球を置き、関節のあいだに円柱を渡しただけの姿で、
 * 姿勢（関節の位置）は game.ts の場面からそのまま受け取る。顔はアイコンを丸く切り抜いたスプライトにして、いつもカメラを向かせる。
 * 2Dは別の canvas に、名札・対戦の見出し・スピナー・指示・結果を描く（文言は hud.ts が決める）。
 *
 * カメラは対戦の経過時間だけから決まる位置でゆっくり揺らす（フレーム間の状態を持たない）。
 * 背景は透明にし、配信画面の上にマットが浮かぶように重ねる。
 *
 * 注意: 描画だけを受け持つのでテストを持たない（何をどこに出すかは game.ts・hud.ts・spinner.ts が決め、そちらをテストする）。
 */
import {
  CanvasTexture,
  CircleGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three'
import { BONES, JOINT_RADII, JOINTS, LIMB_LABELS, LIMBS, type Joint, type Pose } from './body'
import type { TwisterCall } from './call'
import type { GameScene } from './game'
import { hudTextOf } from './hud'
import { ALL_SPOTS, COLOR_HEX, MAT_COLORS, MAT_DEPTH, MAT_WIDTH, SPOT_RADIUS, spotPosition } from './mat'
import { PLAYER_INDEXES } from './players'
import { SEGMENT_ANGLE, SPIN_TURN_MS, SPINNER_SEGMENTS, spinnerAngleAt } from './spinner'

/** 画面に出す文字の書体（市町村紹介と同じ） */
const FONT_FAMILY = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif'
/** 2人の体の色（0: レイドした人、1: 配信者） */
const PLAYER_COLORS: readonly [string, string] = ['#8e44ad', '#ff7043']
/** マットの地の色 */
const MAT_BASE_COLOR = '#f5f3ee'
/** 2Dの大きさの基準にする画面の高さ（px）。配信画面（1080）に合わせて、文字の大きさをこの比で拡大縮小する */
const BASE_HEIGHT = 1080
/** 2Dの文字・図形の大きさ（BASE_HEIGHT のときの px） */
const SIZES = {
  titleFont: 72,
  nameFont: 30,
  turnFont: 40,
  instructionFont: 64,
  headlineFont: 96,
  detailFont: 44,
  spinnerRadius: 150,
  spinnerMargin: 40,
  outline: 8,
} as const
/** カメラの視野角（度）・注視点の高さ（m）・注視点からの水平の距離（m）・高さ（m） */
const CAMERA_FOV = 35
const CAMERA_TARGET_HEIGHT = 0.3
const CAMERA_DISTANCE = 4.4
const CAMERA_HEIGHT = 2.7
/** カメラの基準の向き（ラジアン）。x の負の側から見て、レイドした人（z の負の端）が画面の左に来るようにする */
const CAMERA_BASE_ANGLE = Math.PI
/** カメラを揺らす幅（ラジアン）と周期（ミリ秒） */
const CAMERA_SWAY = 0.3
const CAMERA_SWAY_PERIOD_MS = 9000
/** 顔のスプライトの大きさ（m）と、頭の中心からカメラの側へ出す距離（m） */
const FACE_SIZE = 0.3
const FACE_OFFSET = 0.14
/** 顔のテクスチャの画素数 */
const FACE_TEXTURE_SIZE = 256
/** 指された円を光らせる輪の点滅の周期（ミリ秒） */
const HIGHLIGHT_PERIOD_MS = 500
/** 影の描画範囲（m）と影の画素数 */
const SHADOW_EXTENT = 2.5
const SHADOW_MAP_SIZE = 1024

/** 1フレームぶんの描くもの */
export interface TwisterFrame {
  readonly call: TwisterCall
  readonly scene: GameScene
  /** 再生を始めてからのミリ秒（カメラの揺れと点滅に使う） */
  readonly elapsedMs: number
}

export interface TwisterRenderer {
  /** 顔を差し替える。アイコンを読み込めなかった人・アイコンの無い人は null（名前の頭文字の顔にする） */
  setFaces(call: TwisterCall, images: readonly [HTMLImageElement | null, HTMLImageElement | null]): void
  /** 1フレームを描く。frame が null なら何も映さない（対戦していないあいだ） */
  render(hud: CanvasRenderingContext2D, width: number, height: number, frame: TwisterFrame | null): void
}

/** 円柱1本（骨）と、それを渡す関節 */
interface BoneMesh {
  readonly mesh: Mesh
  readonly from: Joint
  readonly to: Joint
}

/** 人形1人ぶんの3Dの部品 */
interface Doll {
  readonly group: Group
  readonly bones: readonly BoneMesh[]
  readonly joints: ReadonlyMap<Joint, Mesh>
  readonly face: Sprite
}

/** 円柱の向きの基準（円柱は y 方向に伸びている） */
const CYLINDER_AXIS = new Vector3(0, 1, 0)

/** 人形1人ぶんの部品を作る。大きさは単位の形を拡大して合わせる（形を毎フレーム作り直さない） */
const createDoll = (color: string, cylinder: CylinderGeometry, sphere: SphereGeometry): Doll => {
  const material = new MeshStandardMaterial({ color, roughness: 0.55 })
  const group = new Group()
  const bones = BONES.map((bone) => {
    const mesh = new Mesh(cylinder, material)
    mesh.castShadow = true
    // 円柱の太さは骨の半径。長さは毎フレーム合わせる
    mesh.scale.set(bone.radius, 1, bone.radius)
    group.add(mesh)
    return { mesh, from: bone.from, to: bone.to }
  })
  const joints = new Map<Joint, Mesh>()
  for (const joint of JOINTS) {
    const mesh = new Mesh(sphere, material)
    mesh.castShadow = true
    // 関節の球は、その関節につながる骨のうちいちばん太いものに合わせ、継ぎ目を隠す
    const radius = Math.max(JOINT_RADII[joint] * (joint === 'head' ? 1 : 0.9), ...BONES.filter((bone) => bone.from === joint || bone.to === joint).map((bone) => bone.radius))
    mesh.scale.setScalar(radius)
    group.add(mesh)
    joints.set(joint, mesh)
  }
  const face = new Sprite(new SpriteMaterial({ transparent: true }))
  face.scale.set(FACE_SIZE, FACE_SIZE, 1)
  group.add(face)
  return { group, bones, joints, face }
}

/** 名前の頭文字（絵文字や結合文字でも1文字ぶんに切る） */
const initialOf = (name: string): string => [...name][0] ?? '?'

/** アイコン（無ければ頭文字）を丸く切り抜き、体の色の縁を付けた顔の絵を作る */
const drawFace = (image: HTMLImageElement | null, name: string, color: string): HTMLCanvasElement => {
  const canvas = document.createElement('canvas')
  canvas.width = FACE_TEXTURE_SIZE
  canvas.height = FACE_TEXTURE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('顔の絵を描く canvas の2D描画コンテキストを取得できませんでした')
  const half = FACE_TEXTURE_SIZE / 2
  const border = FACE_TEXTURE_SIZE * 0.06
  ctx.beginPath()
  ctx.arc(half, half, half - border / 2, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.save()
  ctx.clip()
  if (image === null) {
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${FACE_TEXTURE_SIZE * 0.5}px ${FONT_FAMILY}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(initialOf(name), half, half)
  } else {
    ctx.drawImage(image, 0, 0, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE)
  }
  ctx.restore()
  ctx.lineWidth = border
  ctx.strokeStyle = color
  ctx.stroke()
  return canvas
}

/** マット（地と色の円）を作る */
const createMat = (): Group => {
  const group = new Group()
  const base = new Mesh(new PlaneGeometry(MAT_WIDTH, MAT_DEPTH), new MeshStandardMaterial({ color: MAT_BASE_COLOR, roughness: 0.9 }))
  base.rotation.x = -Math.PI / 2
  base.receiveShadow = true
  group.add(base)
  const circle = new CircleGeometry(SPOT_RADIUS, 40)
  const materials = Object.fromEntries(MAT_COLORS.map((color) => [color, new MeshStandardMaterial({ color: COLOR_HEX[color], roughness: 0.7 })]))
  for (const spot of ALL_SPOTS) {
    const mesh = new Mesh(circle, materials[spot.color])
    const position = spotPosition(spot)
    mesh.rotation.x = -Math.PI / 2
    // 地とちらつかないよう、わずかに浮かせる
    mesh.position.set(position.x, 0.002, position.z)
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return group
}

/** 姿勢を人形の部品へ映す */
const applyPose = (doll: Doll, pose: Pose, camera: PerspectiveCamera): void => {
  const direction = new Vector3()
  const rotation = new Quaternion()
  for (const bone of doll.bones) {
    const from = pose[bone.from]
    const to = pose[bone.to]
    direction.set(to.x - from.x, to.y - from.y, to.z - from.z)
    const length = direction.length()
    bone.mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2)
    bone.mesh.quaternion.copy(length < 1e-9 ? rotation.identity() : rotation.setFromUnitVectors(CYLINDER_AXIS, direction.divideScalar(length)))
    bone.mesh.scale.y = Math.max(length, 1e-6)
  }
  for (const [joint, mesh] of doll.joints) {
    const position = pose[joint]
    mesh.position.set(position.x, position.y, position.z)
  }
  // 顔は頭の中心からカメラの側へ少し出し、頭の球に埋もれないようにする
  const head = new Vector3(pose.head.x, pose.head.y, pose.head.z)
  const towardCamera = camera.position.clone().sub(head).normalize().multiplyScalar(FACE_OFFSET)
  doll.face.position.copy(head.add(towardCamera))
}

/** 縁取りした文字を描く（配信画面のどんな背景の上でも読めるように） */
const outlinedText = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, unit: number, color = '#ffffff'): void => {
  ctx.font = `bold ${size * unit}px ${FONT_FAMILY}`
  ctx.lineJoin = 'round'
  ctx.lineWidth = SIZES.outline * unit
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

/** スピナーの盤と針を描く。角度は盤の真上を 0 とした時計回り */
const drawSpinner = (ctx: CanvasRenderingContext2D, centerX: number, centerY: number, radius: number, angle: number, unit: number): void => {
  // canvas の角度は x 軸から時計回りなので、真上を 0 にするため4分の1回転ずらす
  const toCanvas = (value: number): number => value - Math.PI / 2
  for (let index = 0; index < SPINNER_SEGMENTS; index += 1) {
    const color = MAT_COLORS[index % MAT_COLORS.length]
    if (color === undefined) continue
    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.arc(centerX, centerY, radius, toCanvas(index * SEGMENT_ANGLE), toCanvas((index + 1) * SEGMENT_ANGLE))
    ctx.closePath()
    ctx.fillStyle = COLOR_HEX[color]
    ctx.fill()
  }
  // 手足の区切りの線と、手足の名前
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 6 * unit
  const quarter = (Math.PI * 2) / LIMBS.length
  LIMBS.forEach((limb, index) => {
    const edge = toCanvas(index * quarter)
    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(centerX + Math.cos(edge) * radius, centerY + Math.sin(edge) * radius)
    ctx.stroke()
    const middle = toCanvas((index + 0.5) * quarter)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    outlinedText(ctx, LIMB_LABELS[limb], centerX + Math.cos(middle) * radius * 0.62, centerY + Math.sin(middle) * radius * 0.62, 26, unit)
  })
  ctx.beginPath()
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2)
  ctx.stroke()
  // 針
  const tip = toCanvas(angle)
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)'
  ctx.lineWidth = 16 * unit
  ctx.beginPath()
  ctx.moveTo(centerX, centerY)
  ctx.lineTo(centerX + Math.cos(tip) * radius * 0.88, centerY + Math.sin(tip) * radius * 0.88)
  ctx.stroke()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 8 * unit
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(centerX, centerY, 14 * unit, 0, Math.PI * 2)
  ctx.fillStyle = '#222222'
  ctx.fill()
  ctx.lineCap = 'butt'
}

/** 3Dの位置を、2Dの canvas の座標（CSS の px）へ映す */
const projectToScreen = (camera: PerspectiveCamera, point: Vector3, width: number, height: number): { x: number; y: number } => {
  const projected = point.clone().project(camera)
  return { x: ((projected.x + 1) / 2) * width, y: ((1 - projected.y) / 2) * height }
}

/** 文言・名札・スピナーを2Dの canvas に描く */
const drawHud = (ctx: CanvasRenderingContext2D, width: number, height: number, frame: TwisterFrame, camera: PerspectiveCamera): void => {
  const unit = height / BASE_HEIGHT
  const text = hudTextOf(frame.scene, frame.call)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // 名札は頭の少し上に出す（倒れ込んだ後は2人の頭が重なって読めず、顔のアイコンで見分けられるので出さない）
  if (frame.scene.phase !== 'collapse' && frame.scene.phase !== 'result') {
    for (const player of PLAYER_INDEXES) {
      const head = frame.scene.poses[player].head
      const at = projectToScreen(camera, new Vector3(head.x, head.y + 0.32, head.z), width, height)
      outlinedText(ctx, frame.call.players[player].name, at.x, at.y, SIZES.nameFont, unit, PLAYER_COLORS[player])
    }
  }
  if (text.title !== null) outlinedText(ctx, text.title, width / 2, height * 0.16, SIZES.titleFont, unit)
  if (text.headline !== null) outlinedText(ctx, text.headline, width / 2, height * 0.2, SIZES.headlineFont, unit)
  if (text.detail !== null) outlinedText(ctx, text.detail, width / 2, height * 0.2 + (SIZES.headlineFont + 20) * unit, SIZES.detailFont, unit)

  const { spin } = frame.scene
  if (spin === null) return
  const radius = SIZES.spinnerRadius * unit
  const centerX = width - (SIZES.spinnerMargin + SIZES.spinnerRadius) * unit
  const centerY = height - (SIZES.spinnerMargin + SIZES.spinnerRadius) * unit
  drawSpinner(ctx, centerX, centerY, radius, spinnerAngleAt({ limb: spin.move.limb, color: spin.move.spot.color }, spin.elapsedMs), unit)
  // 番と指示は、スピナーの左に右寄せで出す
  ctx.textAlign = 'right'
  const textRight = centerX - radius - 30 * unit
  if (text.turn !== null) outlinedText(ctx, text.turn, textRight, centerY - 50 * unit, SIZES.turnFont, unit, PLAYER_COLORS[spin.move.player])
  if (text.instruction !== null) outlinedText(ctx, text.instruction, textRight, centerY + 30 * unit, SIZES.instructionFont, unit)
}

/**
 * ツイスターの描画を作る。
 *
 * @throws WebGL を使えない場合（three.js の WebGLRenderer が投げる）
 */
export const createTwisterRenderer = (glCanvas: HTMLCanvasElement): TwisterRenderer => {
  const renderer = new WebGLRenderer({ canvas: glCanvas, alpha: true, antialias: true })
  renderer.setClearColor(0x000000, 0)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap

  const scene = new Scene()
  scene.add(new HemisphereLight(0xffffff, 0x445066, 1.3))
  const sun = new DirectionalLight(0xffffff, 1.8)
  sun.position.set(-2, 5, 1.5)
  sun.castShadow = true
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
  sun.shadow.camera.left = -SHADOW_EXTENT
  sun.shadow.camera.right = SHADOW_EXTENT
  sun.shadow.camera.top = SHADOW_EXTENT
  sun.shadow.camera.bottom = -SHADOW_EXTENT
  scene.add(sun)

  const world = new Group()
  world.add(createMat())
  // 指された円を知らせる輪（スピナーが止まってから手足が届くまで点滅させる）
  const highlight = new Mesh(new RingGeometry(SPOT_RADIUS * 1.05, SPOT_RADIUS * 1.35, 40), new MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', transparent: true }))
  highlight.rotation.x = -Math.PI / 2
  world.add(highlight)
  const cylinder = new CylinderGeometry(1, 1, 1, 16)
  const sphere = new SphereGeometry(1, 20, 14)
  const dolls: readonly [Doll, Doll] = [createDoll(PLAYER_COLORS[0], cylinder, sphere), createDoll(PLAYER_COLORS[1], cylinder, sphere)]
  for (const doll of dolls) world.add(doll.group)
  scene.add(world)

  const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 50)
  let size = { width: 0, height: 0, ratio: 0 }
  /** 顔のテクスチャを作った呼び出し。同じ呼び出しのあいだは作り直さない */
  let facesFor: TwisterCall | null = null

  const setFaces: TwisterRenderer['setFaces'] = (call, images) => {
    facesFor = call
    for (const player of PLAYER_INDEXES) {
      const texture = new CanvasTexture(drawFace(images[player], call.players[player].name, PLAYER_COLORS[player]))
      texture.colorSpace = SRGBColorSpace
      const material = dolls[player].face.material
      material.map?.dispose()
      material.map = texture
      material.needsUpdate = true
    }
  }

  const render: TwisterRenderer['render'] = (hud, width, height, frame) => {
    const ratio = window.devicePixelRatio
    if (size.width !== width || size.height !== height || size.ratio !== ratio) {
      renderer.setPixelRatio(ratio)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      size = { width, height, ratio }
    }
    world.visible = frame !== null
    if (frame === null) {
      renderer.render(scene, camera)
      return
    }
    if (facesFor !== frame.call) setFaces(frame.call, [null, null])

    const angle = CAMERA_BASE_ANGLE + CAMERA_SWAY * Math.sin((frame.elapsedMs / CAMERA_SWAY_PERIOD_MS) * Math.PI * 2)
    camera.position.set(Math.cos(angle) * CAMERA_DISTANCE, CAMERA_HEIGHT, Math.sin(angle) * CAMERA_DISTANCE)
    camera.lookAt(0, CAMERA_TARGET_HEIGHT, 0)
    camera.updateMatrixWorld()

    for (const player of PLAYER_INDEXES) applyPose(dolls[player], frame.scene.poses[player], camera)
    updateHighlight(highlight, frame)
    renderer.render(scene, camera)
    drawHud(hud, width, height, frame, camera)
  }

  return { setFaces, render }
}

/** 指された円の輪を、針が止まってから手足を運び終えるまで点滅させる */
const updateHighlight = (highlight: Mesh, frame: TwisterFrame): void => {
  const { spin } = frame.scene
  const showing = spin !== null && spin.elapsedMs >= SPIN_TURN_MS && frame.scene.phase !== 'collapse'
  highlight.visible = showing
  if (!showing) return
  const position = spotPosition(spin.move.spot)
  highlight.position.set(position.x, 0.004, position.z)
  const material = highlight.material
  if (material instanceof MeshStandardMaterial) material.opacity = 0.5 + 0.5 * Math.abs(Math.sin((frame.elapsedMs / HIGHLIGHT_PERIOD_MS) * Math.PI))
}
