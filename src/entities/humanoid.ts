/**
 * Humanoid: the rigged base model (public/models/base_female.glb, MakeHuman-style skeleton) as the player character.
 *
 * Animation: the procedural anime rig (Hero) still computes every pose (walk, run, weapon runs, fly, hover, brace, land, ride);
 * its meshes are stripped and each frame its joint rotations are retargeted onto the model's bones:
 *   boneWorld = jointWorld (character space) * C * boneRestWorld
 * where C turns the bone from its rest direction (T-pose arms) into the rig's canonical rest direction (limbs hanging down,
 * spine / neck up). Unmapped bones keep their rest local rotation, so fingers, twist bones and the face follow naturally.
 *
 * Reshaping is done on the skeleton (no morph targets needed): bone scales for head / shoulders / bust / hips, the jaw bone for
 * jaw, chin width and chin forward, cheek bones for cheek width, eye bones for eye size / spacing / height; overall height scales
 * the whole model. Colours (skin, hair, outfit) tint the textured toon materials.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Hero, type HeroAssets, type PoseIn, H, SP, HD, SHL, ELL, SHR, ELR, THL, KNL, ANL, THR, KNR, ANR, NJ, JOINT_PARENT } from './hero';
import type { CharacterSpec } from './character';

const URL = '/models/base_female.glb';
/** model units -> metres (the file is authored ~0.135 units tall) */
const UNIT = 12.3;
const SOLE = 0.011;          // the sandal soles sit this far below the model origin
const HIP_Y = 0.0632;        // pelvis height in model units
const RIG_HIP = 0.9;         // Hero's HIP constant

let loading: Promise<THREE.Group> | null = null;
let template: THREE.Group | null = null;
/** start (or join) the base-model download; resolves with the parsed template scene */
export function loadBaseModel(): Promise<THREE.Group> {
  return (loading ??= new GLTFLoader().loadAsync(URL).then((g) => { template = g.scene; return g.scene; }));
}
export const baseModelReady = () => template !== null;

interface Map1 { joint: number; bone: string; down?: boolean; up?: boolean; w?: number }
// x < 0 joints (SHL, ELL, THL...) are the character's right side = MakeHuman "_R"
const MAP: Map1[] = [
  { joint: H, bone: 'root' },
  { joint: SP, bone: 'spine03', w: 0.5 }, { joint: SP, bone: 'spine01' },
  { joint: HD, bone: 'neck02', w: 0.5 }, { joint: HD, bone: 'head' },
  { joint: SHL, bone: 'upperarm01_R', down: true }, { joint: ELL, bone: 'lowerarm01_R', down: true },
  { joint: SHR, bone: 'upperarm01_L', down: true }, { joint: ELR, bone: 'lowerarm01_L', down: true },
  { joint: THL, bone: 'upperleg01_R', down: true }, { joint: KNL, bone: 'lowerleg01_R', down: true }, { joint: ANL, bone: 'foot_R' },
  { joint: THR, bone: 'upperleg01_L', down: true }, { joint: KNR, bone: 'lowerleg01_L', down: true }, { joint: ANR, bone: 'foot_L' },
];
/** child used to measure each mapped bone's rest direction */
const AIM: Record<string, string> = {
  upperarm01_R: 'lowerarm01_R', lowerarm01_R: 'wrist_R', upperarm01_L: 'lowerarm01_L', lowerarm01_L: 'wrist_L',
  upperleg01_R: 'lowerleg01_R', lowerleg01_R: 'foot_R', upperleg01_L: 'lowerleg01_L', lowerleg01_L: 'foot_L',
};

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const ID = new THREE.Quaternion();

export class Humanoid {
  readonly root = new THREE.Group();
  private model: THREE.Object3D;
  private rig: Hero;
  private bones: THREE.Object3D[] = [];              // every node under the model's skeleton root, parents before children
  private restLocal: THREE.Quaternion[] = [];
  private restWorld: THREE.Quaternion[] = [];
  private drive = new Map<number, { joint: number; w: number; corr: THREE.Quaternion }>();
  private jw: THREE.Quaternion[] = Array.from({ length: NJ }, () => new THREE.Quaternion());
  private world: THREE.Quaternion[] = [];
  private rootNode!: THREE.Object3D; private rootRestPos = new THREE.Vector3();
  private scale: number;
  private owned: { dispose(): void }[] = [];
  weapon = 0;

  constructor(assets: HeroAssets, spec: CharacterSpec, ink = true) {
    if (!template) throw new Error('base model not loaded (await loadBaseModel() first)');
    void ink;
    // the anime rig keeps doing the animation work; its own meshes are discarded
    this.rig = new Hero(assets, spec, false, 0.3);
    this.rig.stripMeshes();
    this.weapon = this.rig.weapon;

    this.model = cloneSkinned(template);
    this.scale = UNIT * spec.height;
    this.model.scale.setScalar(this.scale);
    this.model.position.y = SOLE * this.scale;
    this.root.add(this.model);
    this.dressMaterials(assets, spec);

    this.fixEyeBind();
    // skeleton: record rest rotations (local + world in model space) in parent-first order
    this.rootNode = this.model.getObjectByName('root')!;
    this.rootRestPos.copy(this.rootNode.position);
    const order: THREE.Object3D[] = [];
    const walk = (o: THREE.Object3D) => { order.push(o); for (const c of o.children) walk(c); };
    walk(this.rootNode);
    this.bones = order;
    this.model.updateMatrixWorld(true);
    const inv = new THREE.Quaternion(); this.model.getWorldQuaternion(inv).invert();
    for (const b of order) {
      this.restLocal.push(b.quaternion.clone());
      const w = new THREE.Quaternion(); b.getWorldQuaternion(w); this.restWorld.push(inv.clone().multiply(w));
      this.world.push(new THREE.Quaternion());
    }
    const idx = (n: string) => order.findIndex((o) => o.name === n);
    for (const m of MAP) {
      const i = idx(m.bone); if (i < 0) continue;
      const corr = new THREE.Quaternion();
      if (m.down && AIM[m.bone]) {
        const a = order[i], c = order[idx(AIM[m.bone])];
        a.getWorldPosition(_v); c.getWorldPosition(_v2);
        const dir = _v2.sub(_v).normalize().applyQuaternion(inv);
        corr.setFromUnitVectors(dir, new THREE.Vector3(0, -1, 0));
      }
      this.drive.set(i, { joint: m.joint, w: m.w ?? 1, corr });
    }
    this.parentIdx = order.map((b, i) => (i === 0 ? -1 : order.indexOf(b.parent!)));
    this.reshape(spec);
    if (this.weapon) this.attachWeapon(this.weapon);
  }

  /**
   * In this asset the eye bones' node rest pose differs from the pose the eye mesh was bound in (the eyeballs end up turned
   * ~90 degrees, showing their empty back). Snap those bones to their bind pose: world = bindMatrix * inverse(boneInverse).
   */
  private fixEyeBind(): void {
    this.model.updateMatrixWorld(true);
    this.model.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !/highpolyeyes/.test(sm.name)) return;
      const sk = sm.skeleton;
      sk.bones.forEach((bone, i) => {
        if (!/^eye_[LR]$/.test(bone.name) || !bone.parent) return;
        const want = new THREE.Matrix4().copy(sm.matrixWorld).multiply(sm.bindMatrix).multiply(new THREE.Matrix4().copy(sk.boneInverses[i]).invert());
        const local = new THREE.Matrix4().copy(bone.parent.matrixWorld).invert().multiply(want);
        local.decompose(bone.position, bone.quaternion, bone.scale);
        bone.updateMatrixWorld(true);
      });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------
  private dressMaterials(assets: HeroAssets, spec: CharacterSpec): void {
    const tint = (hex: string, toWhite: number) => new THREE.Color(hex).lerp(new THREE.Color(0xffffff), toWhite);
    const O = spec.outfit;
    this.model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      m.castShadow = true; m.frustumCulled = false;
      const src = m.material as THREE.MeshBasicMaterial;
      const name = src.name || '';
      const hair = /^mat[123]$/.test(name), cutout = hair || /eyebrow|Heelsandal|vnecktop/.test(name);
      const unlit = /Eye|eyebrow/.test(name); // eyes / brows were authored unlit (inward normals): keep them unlit
      const mat: THREE.MeshToonMaterial | THREE.MeshBasicMaterial = unlit
        ? new THREE.MeshBasicMaterial({ map: src.map, alphaTest: 0.3 }) // the cornea shell is fully transparent in the texture
        : new THREE.MeshToonMaterial({ map: src.map, gradientMap: assets.ramp, alphaTest: cutout ? 0.45 : 0, side: hair ? THREE.DoubleSide : THREE.FrontSide });
      if (src.map) src.map.colorSpace = THREE.SRGBColorSpace;
      if (/young_caucasian_female/.test(name)) mat.color.copy(tint(spec.skin, 0.32));
      else if (hair) mat.color.copy(tint(spec.hair.color, 0.25)).multiplyScalar(1.15);
      else if (/vnecktop/.test(name)) mat.color.copy(tint(O.primary, 0.2));
      else if (/pleated|material\.001/.test(name)) mat.color.copy(tint(O.secondary, 0.2));
      else if (/Heelsandal/.test(name)) mat.color.copy(tint(O.bootColor, 0.3));
      else if (/Eye/.test(name)) mat.color.copy(tint(spec.face.iris, 0.55));
      else if (/eyebrow/.test(name)) mat.color.copy(tint(spec.hair.color, 0.1));
      m.material = mat; this.owned.push(mat);
    });
  }

  /** skeleton-based body + face shaping from the spec */
  private reshape(spec: CharacterSpec): void {
    const F = spec.face, get = (n: string) => this.model.getObjectByName(n);
    const scaleBone = (n: string, s: number, compensate?: string[]) => {
      const b = get(n); if (!b) return;
      b.scale.multiplyScalar(s);
      for (const c of compensate ?? []) { const k = get(c); if (k) k.scale.multiplyScalar(1 / s); }
    };
    /** move a bone by a model-space offset (converted into its parent's frame) */
    const nudge = (n: string, dx: number, dy: number, dz: number) => {
      const b = get(n); if (!b || !b.parent) return;
      this.model.updateMatrixWorld(true);
      const pq = new THREE.Quaternion(); b.parent.getWorldQuaternion(pq);
      const mq = new THREE.Quaternion(); this.model.getWorldQuaternion(mq);
      const ps = new THREE.Vector3(); b.parent.getWorldScale(ps);
      const d = new THREE.Vector3(dx, dy, dz).applyQuaternion(mq).applyQuaternion(pq.invert());
      d.multiplyScalar(this.scale / ps.x);
      b.position.add(d);
    };
    scaleBone('head', 0.92 + 0.3 * (spec.head - 1));
    scaleBone('clavicle_L', 1 + 0.22 * ((spec.shoulders ?? 0.5) - 0.5), ['upperarm01_L']);
    scaleBone('clavicle_R', 1 + 0.22 * ((spec.shoulders ?? 0.5) - 0.5), ['upperarm01_R']);
    const bust = spec.gender === 'male' ? 0.55 : 0.75 + 0.6 * ((spec.bust ?? 0.5) - 0.3);
    scaleBone('breast_L', bust); scaleBone('breast_R', bust);
    const hips = 1 + 0.12 * (spec.build - 0.3) + (spec.gender === 'male' ? -0.05 : 0);
    scaleBone('pelvis_L', hips, ['upperleg01_L']); scaleBone('pelvis_R', hips, ['upperleg01_R']);
    // face: jaw shape, chin, cheeks, eyes (offsets in model units; the head is ~0.025 units tall)
    // the jaw bone carries the lower lip too, so keep its moves small enough that the mouth never opens
    const jb = this.model.getObjectByName('jaw');
    if (jb) jb.scale.set(1 + 0.05 * F.jaw + 0.09 * (F.chinWidth ?? 0), 1 + 0.03 * F.jaw, 1 + 0.03 * F.jaw);
    nudge('jaw', 0, -0.00004 * Math.abs(F.chin ?? 0), 0.00016 * (F.chin ?? 0));
    for (const [n, sx] of [['risorius03_L', 1], ['risorius03_R', -1], ['levator06_L', 1], ['levator06_R', -1]] as [string, number][]) nudge(n, sx * 0.00028 * (F.cheekWidth ?? 0), 0, 0);
    const eyeS = 1 + 0.35 * (F.eyeSize - 1);
    for (const [n, sx] of [['eye_L', 1], ['eye_R', -1]] as [string, number][]) {
      scaleBone(n, eyeS);
      nudge(n, sx * 0.00018 * F.eyeSpacing, 0.00015 * F.eyeHeight, 0);
    }
    for (const n of ['orbicularis03_L', 'orbicularis04_L', 'orbicularis03_R', 'orbicularis04_R']) scaleBone(n, 1 + 0.25 * (F.eyeSize - 1));
  }

  private attachWeapon(w: number): void {
    const mat = new THREE.MeshToonMaterial({ color: 0x14121c }), gold = new THREE.MeshToonMaterial({ color: 0xd9a441 }), red = new THREE.MeshToonMaterial({ color: 0xc8283c });
    this.owned.push(mat, gold, red);
    const sword = () => {
      const g = new THREE.Group();
      const part = (len: number, r: number, y: number, m: THREE.Material) => { const geo = new THREE.CylinderGeometry(r, r, len, 10); geo.translate(0, y, 0); this.owned.push(geo); const me = new THREE.Mesh(geo, m); me.castShadow = true; g.add(me); };
      part(0.68, 0.019, 0, mat); part(0.018, 0.045, 0.35, gold); part(0.19, 0.016, 0.455, red); part(0.03, 0.022, -0.35, red);
      return g;
    };
    // weapons hang from the hips (waist katana) or the upper spine (back sheaths), placed in metres in character space
    const host = (n: string) => this.model.getObjectByName(n)!;
    const place = (obj: THREE.Object3D, boneName: string, pos: THREE.Vector3, rot: THREE.Euler) => {
      const bone = host(boneName); this.root.updateMatrixWorld(true);
      const m = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(rot), new THREE.Vector3(1, 1, 1));
      const inv = new THREE.Matrix4().copy(bone.matrixWorld).invert();
      new THREE.Matrix4().multiplyMatrices(inv, new THREE.Matrix4().copy(this.root.matrixWorld).multiply(m)).decompose(obj.position, obj.quaternion, obj.scale);
      bone.add(obj);
    };
    const hipH = (HIP_Y + SOLE) * this.scale;
    if (w === 1) place(sword(), 'spine05', new THREE.Vector3(0.155, hipH - 0.06, -0.03), new THREE.Euler(1.1, 0, -0.12));
    else {
      place(sword(), 'spine01', new THREE.Vector3(0, hipH + 0.3, -0.13), new THREE.Euler(0, 0, 0.62));
      if (w === 3) place(sword(), 'spine01', new THREE.Vector3(0, hipH + 0.3, -0.14), new THREE.Euler(0, 0, -0.62));
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------
  pose(p: PoseIn): void {
    this.rig.pose(p);
    const J = this.rig.joints;
    // joint world rotations in character space (pivots are unrotated at rest, so rotations compose directly)
    for (let j = 0; j < NJ; j++) {
      _q.setFromEuler(_e.copy(J[j].rotation));
      const par = JOINT_PARENT[j];
      if (par < 0) this.jw[j].copy(_q); else this.jw[j].multiplyQuaternions(this.jw[par], _q);
    }
    const n = this.bones.length;
    for (let i = 0; i < n; i++) {
      const b = this.bones[i], parentIdx = this.parentIdx[i];
      const pw = parentIdx < 0 ? this.parentRest : this.world[parentIdx];
      const d = this.drive.get(i);
      if (d) {
        const par = JOINT_PARENT[d.joint];
        if (d.w < 1) {
          _q2.setFromEuler(_e.copy(J[d.joint].rotation)); _q.copy(ID).slerp(_q2, d.w);
          if (par >= 0) _q.premultiply(this.jw[par]);
        } else _q.copy(this.jw[d.joint]);
        this.world[i].multiplyQuaternions(_q, d.corr).multiply(this.restWorld[i]);
        b.quaternion.copy(pw).invert().multiply(this.world[i]);
      } else {
        b.quaternion.copy(this.restLocal[i]);
        this.world[i].multiplyQuaternions(pw, b.quaternion);
      }
    }
    // pelvis height follows the rig (crouches, bobs, landings)
    const dy = (this.rig.pelvisY - RIG_HIP) * 0.92 * (this.scale / UNIT) / this.scale;
    this.rootNode.position.set(this.rootRestPos.x, this.rootRestPos.y + dy, this.rootRestPos.z);
  }
  private parentRest = new THREE.Quaternion();
  private parentIdx: number[] = [];

  /** standing height in metres (for framing cameras) */
  get height(): number { return (0.124 + SOLE) * this.scale; }
  /** eye-level height and head size (m) for close-up framing */
  get faceY(): number { return (0.111 + SOLE) * this.scale; }
  get headSize(): number { return 0.025 * this.scale; }

  get seatHeight(): number { return (HIP_Y + SOLE) * this.scale + (this.rig.pelvisY - RIG_HIP) * 0.92 * (this.scale / UNIT) - 0.06; }

  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
    this.root.removeFromParent();
  }
}
void _v; void _v2;

/** What the game needs from a character body (both the rigged base model and the classic anime build provide it). */
export interface CharacterBody { readonly root: THREE.Group; pose(p: PoseIn): void; readonly seatHeight: number; readonly height: number; readonly faceY: number; readonly headSize: number; dispose(): void }

/** Build the body the spec asks for; falls back to the classic build if the base model hasn't loaded. */
export function makeCharacter(assets: HeroAssets, spec: CharacterSpec, ink = true, detail = 1): CharacterBody {
  if ((spec.base ?? 0) === 0 && baseModelReady()) {
    try { return new Humanoid(assets, spec, ink); } catch (e) { console.error('base model failed, using the classic body', e); }
  }
  return new Hero(assets, spec, ink, detail);
}
