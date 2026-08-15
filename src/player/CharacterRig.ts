import type * as THREE from 'three';
import type { SuitDef } from '../game/Suits';
import type { PoseContext } from './PlayerModel';

/**
 * The contract the game needs from a character, whichever way it is built.
 *
 * `PlayerModel` implements this with procedural primitives. `GltfCharacter`
 * implements it by driving a real skinned mesh with baked animation clips.
 * Everything upstream — Player, Game, the camera — only sees this interface,
 * so a loaded model is a drop-in replacement.
 */
export interface CharacterRig {
  /** Scene node to add and to position each frame. */
  readonly root: THREE.Object3D;

  /** Drives pose/animation from the movement state. */
  update(dt: number, ctx: PoseContext): void;

  /** World position the web line should originate from. */
  getHandPosition(out: THREE.Vector3): THREE.Vector3;

  /** Recolours for the equipped skin. A loaded model may ignore this. */
  setSuit(suit: SuitDef): void;

  dispose(): void;
}
