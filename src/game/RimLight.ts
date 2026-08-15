import * as THREE from 'three';

/**
 * Adds a Fresnel rim term to a standard/physical material.
 *
 * This is the single highest-value trick for making primitive-built characters
 * read as solid form rather than as a pile of spheres. A bright edge where the
 * surface turns away from the viewer is exactly the cue the eye uses to infer
 * a silhouette, so a capsule with a rim reads far more like an arm than the
 * same capsule flat-lit.
 *
 * Implemented via `onBeforeCompile` so it rides on top of the normal PBR
 * pipeline — shadows, normal maps and clearcoat all still work.
 */
export function applyRimLight(
  material: THREE.MeshStandardMaterial,
  color: number,
  strength = 0.55,
  power = 2.6,
): void {
  const rimColor = new THREE.Color(color);

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: rimColor };
    shader.uniforms.uRimStrength = { value: strength };
    shader.uniforms.uRimPower = { value: power };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform vec3 uRimColor;
         uniform float uRimStrength;
         uniform float uRimPower;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         // vNormal and vViewPosition are both view-space in the standard
         // fragment shader, so the facing ratio needs no extra plumbing.
         float rimFacing = abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
         float rim = pow( 1.0 - rimFacing, uRimPower );
         totalEmissiveRadiance += uRimColor * rim * uRimStrength;`,
      );
  };

  // Force a recompile if the material has already been used.
  material.needsUpdate = true;
}

