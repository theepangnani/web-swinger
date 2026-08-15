import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { SuitDef } from '../game/Suits';
import type { CharacterRig } from './CharacterRig';
import type { PoseContext } from './PlayerModel';
import { PlayerState } from './PlayerState';
import { clamp, dampAngle } from '../core/MathUtils';
import { CONFIG } from '../core/Config';

/** Target height in metres, so any model matches the physics capsule. */
const TARGET_HEIGHT = 1.95;

/**
 * Clip names this rig will look for, in priority order, per movement state.
 * Matching is case-insensitive and substring-based, because exported clip
 * names vary wildly between sources (Mixamo, Quaternius, Sketchfab...).
 */
const CLIPS: Record<string, readonly string[]> = {
  idle: ['idle', 'breathing', 'stand'],
  run: ['run', 'sprint', 'jog'],
  air: ['fall', 'falling', 'air', 'jump'],
  swing: ['swing', 'flying', 'fly', 'glide'],
  attack: ['punch', 'attack', 'kick', 'strike'],
  crawl: ['crawl', 'climb'],
  dodge: ['roll', 'dodge', 'dive'],
  land: ['land'],
};

const _box = new THREE.Box3();
const _size = new THREE.Vector3();

/**
 * A character driven by a loaded glTF/GLB file.
 *
 * This is the only route to sculpted-quality characters — procedural
 * primitives cannot approach a hand-modelled mesh. Supply your own model
 * (see `public/models/README.md`) and it replaces the built-in rig wholesale.
 */
export class GltfCharacter implements CharacterRig {
  readonly root: THREE.Object3D;

  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentName = '';
  private handBone: THREE.Object3D | null = null;
  private facing = 0;

  private constructor(scene: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.root = new THREE.Group();
    this.root.add(scene);

    // Normalise scale so any source model matches our physics height, and sit
    // the feet on the capsule's base.
    _box.setFromObject(scene);
    _box.getSize(_size);
    if (_size.y > 0.01) {
      const scale = TARGET_HEIGHT / _size.y;
      scene.scale.setScalar(scale);
      _box.setFromObject(scene);
    }
    // The root is placed at the physics position, which is the *centre* of the
    // collision sphere -- not the ground. Dropping the feet to the root origin
    // would leave the model hovering by one radius.
    scene.position.y -= _box.min.y + CONFIG.physics.playerRadius;

    scene.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        node.frustumCulled = false;
      }
      // Grab a right-hand bone for the web origin if the rig has one.
      const name = node.name.toLowerCase();
      if (!this.handBone && /hand/.test(name) && /(right|_r\b|\.r\b|r_)/.test(name)) {
        this.handBone = node;
      }
    });

    this.mixer = new THREE.AnimationMixer(scene);
    for (const clip of clips) {
      this.actions.set(clip.name.toLowerCase(), this.mixer.clipAction(clip));
    }
  }

  /**
   * Loads a model. Resolves to null if the file is missing or unreadable, so
   * the caller can fall back to the procedural rig without a hard failure.
   */
  static async load(url: string): Promise<GltfCharacter | null> {
    try {
      // Probe first: a 404 from the dev server returns an HTML page, which
      // GLTFLoader would otherwise report as a confusing parse error.
      const probe = await fetch(url, { method: 'HEAD' });
      if (!probe.ok) return null;

      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);
      const character = new GltfCharacter(gltf.scene, gltf.animations);
      console.info(
        `[web-swinger] Loaded character "${url}" with ${gltf.animations.length} clip(s):`,
        gltf.animations.map((c) => c.name),
      );
      return character;
    } catch (error) {
      console.warn(`[web-swinger] Could not load character "${url}":`, error);
      return null;
    }
  }

  update(dt: number, ctx: PoseContext): void {
    const speed = ctx.velocity.length();
    const horizontal = Math.hypot(ctx.velocity.x, ctx.velocity.z);

    // Face the direction of travel, same rule as the procedural rig.
    const target = horizontal > 1.2 ? Math.atan2(ctx.velocity.x, ctx.velocity.z) : ctx.cameraYaw;
    this.facing = dampAngle(this.facing, target, 9, dt);
    this.root.rotation.y = this.facing;

    this.play(this.clipFor(ctx.state), ctx.state === PlayerState.Attacking);

    // Run playback rate tracks actual speed so footfalls do not slide.
    if (this.currentName === 'run' && this.current) {
      this.current.timeScale = clamp(horizontal / 6, 0.5, 2.2);
    } else if (this.current) {
      this.current.timeScale = 1;
    }

    this.mixer.update(dt);
    void speed;
  }

  getHandPosition(out: THREE.Vector3): THREE.Vector3 {
    if (this.handBone) {
      this.handBone.getWorldPosition(out);
      return out;
    }
    // No hand bone in the rig: approximate from the root.
    this.root.getWorldPosition(out);
    out.y += 1.2;
    return out;
  }

  setSuit(_suit: SuitDef): void {
    // A supplied model carries its own materials; skins do not apply.
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.root.traverse((node) => {
      if (node instanceof THREE.Mesh) {
        node.geometry.dispose();
        const material = node.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      }
    });
  }

  // ---------------------------------------------------------------- private

  private clipFor(state: PlayerState): string {
    switch (state) {
      case PlayerState.Running:
      case PlayerState.Sprinting:
        return 'run';
      case PlayerState.Swinging:
      case PlayerState.Gliding:
        return 'swing';
      case PlayerState.Attacking:
      case PlayerState.Striking:
        return 'attack';
      case PlayerState.WallCrawl:
      case PlayerState.WallRun:
        return 'crawl';
      case PlayerState.Dodging:
        return 'dodge';
      case PlayerState.Airborne:
      case PlayerState.Trick:
        return 'air';
      default:
        return 'idle';
    }
  }

  /** Cross-fades to the best-matching clip for a logical name. */
  private play(logical: string, restart = false): void {
    if (logical === this.currentName && !restart) return;

    const action = this.resolve(logical) ?? this.resolve('idle');
    if (!action) return;
    if (action === this.current && !restart) return;

    action.reset().fadeIn(0.18).play();
    this.current?.fadeOut(0.18);
    this.current = action;
    this.currentName = logical;
  }

  /** Fuzzy-matches a logical name against the clips the file actually has. */
  private resolve(logical: string): THREE.AnimationAction | null {
    const candidates = CLIPS[logical] ?? [logical];
    for (const needle of candidates) {
      for (const [name, action] of this.actions) {
        if (name.includes(needle)) return action;
      }
    }
    return null;
  }
}
