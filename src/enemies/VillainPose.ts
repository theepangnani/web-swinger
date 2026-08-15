import type * as THREE from 'three';
import { clamp, damp } from '../core/MathUtils';

/**
 * Villain limb animation.
 *
 * Every villain used to attack by scaling: a swell during the wind-up and a
 * snap on the contact frame, with the arms welded in whatever pose they were
 * modelled in. That reads as a pulsing statue, not as somebody hitting you —
 * and it also meant the telegraph, which the whole dodge system is scored
 * against, was carried entirely by a size change the player has no reason to
 * associate with a punch.
 *
 * `VillainBuilder` now commits named joints, so this drives them. It is
 * deliberately one shared function rather than one per villain: what differs
 * between them is reach and speed, not what a shoulder does, and six
 * near-identical pose functions would drift apart within a week.
 */

/** How a villain's arms should be behaving this frame. */
export type PoseIntent =
  | 'IDLE'
  | 'WALK'
  /** Winding up a melee swing. `progress` runs 0 to 1 across the telegraph. */
  | 'WINDUP'
  /** The swing itself. */
  | 'SWING'
  /** Both arms forward — throwing, casting, discharging. */
  | 'RANGED'
  /** Arms up and out: the shove, the pillar, the scream. */
  | 'RAISE'
  /** Limp — collapsed, winded, or cocooned. */
  | 'LIMP';

export interface PoseState {
  /** Advances the idle sway and the walk cycle. */
  phase: number;
}

/**
 * Per-villain proportions.
 *
 * `reach` scales every angle: Sandman's arms are enormous and slow, Black
 * Cat's are quick and tight, and using one set of numbers for both made her
 * flail and him look twitchy.
 */
export interface PoseProfile {
  /** Multiplier on swing amplitude. */
  reach: number;
  /** Multiplier on how fast poses are approached. */
  speed: number;
  /** Which arm leads a swing: -1 for their right, +1 for their left. */
  lead: number;
  /** True if the model has hip/knee joints as well as arms. */
  legs: boolean;
}

export const DEFAULT_PROFILE: PoseProfile = { reach: 1, speed: 1, lead: -1, legs: false };

/**
 * Drives one villain's joints.
 *
 * Missing joints are simply skipped, so a model with no articulation costs a
 * handful of map lookups and nothing else.
 */
export function poseVillain(
  joints: Map<string, THREE.Group>,
  state: PoseState,
  profile: PoseProfile,
  intent: PoseIntent,
  progress: number,
  dt: number,
  speed: number,
): void {
  if (joints.size === 0) return;

  const { reach, speed: rate } = profile;
  state.phase += dt * (1.1 + Math.min(speed, 12) * 0.28);
  const cycle = Math.sin(state.phase);
  const stride = clamp(speed / 7, 0, 1);

  const leadTag = profile.lead > 0 ? 'L' : 'R';
  const offTag = profile.lead > 0 ? 'R' : 'L';

  const shoulderLead = joints.get(`shoulder${leadTag}`);
  const shoulderOff = joints.get(`shoulder${offTag}`);
  const elbowLead = joints.get(`elbow${leadTag}`);
  const elbowOff = joints.get(`elbow${offTag}`);

  switch (intent) {
    case 'WINDUP': {
      // Cocked back and across the body, the off arm dropping as a counter.
      const t = progress;
      set(shoulderLead, -0.35 - t * 1.5 * reach, 0, -profile.lead * t * 0.7, 20 * rate, dt);
      set(elbowLead, -0.4 - t * 1.35 * reach, 0, 0, 20 * rate, dt);
      set(shoulderOff, 0.2 + t * 0.5, 0, profile.lead * 0.35, 12 * rate, dt);
      set(elbowOff, -0.3 - t * 0.3, 0, 0, 12 * rate, dt);
      break;
    }

    case 'SWING': {
      // Fast out, slower back, peaking on the damage frame.
      const t = progress < 0.35 ? progress / 0.35 : 1 - (progress - 0.35) / 0.65;
      const punch = t * t * (3 - 2 * t);
      // Direct assignment, not damped: a swing that eases into place lands
      // after the damage has already been dealt.
      hard(shoulderLead, -1.5 + punch * 2.3 * reach, 0, profile.lead * (0.5 - punch * 0.75));
      hard(elbowLead, -1.7 + punch * 1.6 * reach, 0, 0);
      hard(shoulderOff, 0.7 - punch * 0.9, 0, profile.lead * 0.4);
      hard(elbowOff, -0.6, 0, 0);
      break;
    }

    case 'RANGED': {
      // Both arms forward and level — throw, blast, or spray.
      const t = progress;
      set(shoulderLead, -1.1 - t * 0.9 * reach, 0, profile.lead * 0.25, 16 * rate, dt);
      set(shoulderOff, -0.9 - t * 0.7 * reach, 0, -profile.lead * 0.25, 14 * rate, dt);
      set(elbowLead, -0.5 + t * 0.4, 0, 0, 16 * rate, dt);
      set(elbowOff, -0.6 + t * 0.35, 0, 0, 14 * rate, dt);
      break;
    }

    case 'RAISE': {
      // Arms up and wide. Used by the shove, Sandman's pillar and the screech.
      const t = 0.4 + progress * 0.6;
      set(shoulderLead, -2.0 * t * reach, 0, profile.lead * 0.8 * t, 12 * rate, dt);
      set(shoulderOff, -2.0 * t * reach, 0, -profile.lead * 0.8 * t, 12 * rate, dt);
      set(elbowLead, -0.9 * t, 0, 0, 12 * rate, dt);
      set(elbowOff, -0.9 * t, 0, 0, 12 * rate, dt);
      break;
    }

    case 'LIMP': {
      set(shoulderLead, 0.35, 0, profile.lead * 0.15, 5, dt);
      set(shoulderOff, 0.35, 0, -profile.lead * 0.15, 5, dt);
      set(elbowLead, -0.25, 0, 0, 5, dt);
      set(elbowOff, -0.25, 0, 0, 5, dt);
      break;
    }

    default: {
      // Idle and walk are the same pose at different amplitudes: arms swing
      // opposite the legs, with a slow sway underneath so a standing villain
      // is never completely still.
      const swing = cycle * (0.18 + stride * 0.55) * reach;
      set(shoulderLead, -0.12 - swing, 0, profile.lead * 0.22, 9 * rate, dt);
      set(shoulderOff, -0.12 + swing, 0, -profile.lead * 0.22, 9 * rate, dt);
      set(elbowLead, -0.42 - Math.max(0, swing) * 0.4, 0, 0, 9 * rate, dt);
      set(elbowOff, -0.42 - Math.max(0, -swing) * 0.4, 0, 0, 9 * rate, dt);
      break;
    }
  }

  if (!profile.legs) return;

  // Legs only exist on the models big enough for a stride to be visible.
  const hipL = joints.get('hipL');
  const hipR = joints.get('hipR');
  const kneeL = joints.get('kneeL');
  const kneeR = joints.get('kneeR');
  const gait = intent === 'LIMP' ? 0 : stride;
  set(hipL, cycle * 0.5 * gait, 0, 0, 12, dt);
  set(hipR, -cycle * 0.5 * gait, 0, 0, 12, dt);
  // Knees bend one way only, or the leg inverts at the joint.
  set(kneeL, Math.max(0, -cycle) * 0.62 * gait, 0, 0, 12, dt);
  set(kneeR, Math.max(0, cycle) * 0.62 * gait, 0, 0, 12, dt);
}

/** Eases a joint toward an angle. */
function set(
  joint: THREE.Group | undefined,
  x: number,
  y: number,
  z: number,
  lambda: number,
  dt: number,
): void {
  if (!joint) return;
  joint.rotation.x = damp(joint.rotation.x, x, lambda, dt);
  joint.rotation.y = damp(joint.rotation.y, y, lambda, dt);
  joint.rotation.z = damp(joint.rotation.z, z, lambda, dt);
}

/** Snaps a joint to an angle, for frames where timing beats smoothness. */
function hard(joint: THREE.Group | undefined, x: number, y: number, z: number): void {
  if (!joint) return;
  joint.rotation.set(x, y, z);
}
