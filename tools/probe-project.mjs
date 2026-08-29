#!/usr/bin/env node
/**
 * Project world points through one of System 2's capture cameras and print the
 * pixel rows they land on. Lets a measured pixel spacing in a screenshot be
 * converted back into world metres, so "the coursing looks too big" can be
 * settled with a number instead of an opinion.
 *
 *   node tools/probe-project.mjs front -8.7 31.5
 *
 * Pure computation - no servers, no browsers, nothing to tear down.
 */

import * as THREE from "three";

const SHOTS = {
  front: { x: -3.6, z: 22.6, y: 1.66, lookAt: [-4.6, 1.9, 31.6], fov: 50 },
  corner: { x: 12.4, z: 26.0, y: 1.68, lookAt: [-2.2, 2.7, 34.8], fov: 46 },
};

const [name, xRaw, zRaw] = process.argv.slice(2);
const s = SHOTS[name];
const px = Number(xRaw);
const pz = Number(zRaw);

// The lot is close to flat where these cameras stand; 0.02 m of drain slope is
// far below the resolution of the question being asked here.
const GROUND = 0.0;
const F = GROUND + 0.14;

// Must match tools/shoot2.mjs. Getting this wrong once already produced a
// "the coursing is 1.6x too big" result that was purely an arithmetic error.
const W = 1600;
const H = 900;
const cam = new THREE.PerspectiveCamera(s.fov, W / H, 0.05, 500);
cam.position.set(s.x, GROUND + s.y, s.z);
cam.lookAt(new THREE.Vector3(s.lookAt[0], GROUND + s.lookAt[1], s.lookAt[2]));
cam.updateMatrixWorld(true);
cam.updateProjectionMatrix();

const rowOf = (worldY) => {
  const v = new THREE.Vector3(px, worldY, pz).project(cam);
  return ((1 - v.y) / 2) * H;
};

console.log(`camera ${name}, wall point x=${px} z=${pz}, F=${F}`);
for (const [label, y] of [
  ["floor F+0.00", F],
  ["base course top F+0.62", F + 0.62],
  ["one course above base F+0.8232", F + 0.8232],
  ["F+2.00", F + 2.0],
  ["parapet F+4.35", F + 4.35],
]) {
  console.log(`  ${label.padEnd(30)} -> row ${rowOf(y).toFixed(1)}`);
}
const rBase = rowOf(F + 0.62);
const rPar = rowOf(F + 4.35);
const pxPerMetre = Math.abs(rPar - rBase) / (4.35 - 0.62);
console.log(`\npx per metre over the field: ${pxPerMetre.toFixed(2)}`);
console.log(`one 203.2 mm course should measure: ${(pxPerMetre * 0.2032).toFixed(2)} px`);
console.log(`courses between base top and parapet: ${((4.35 - 0.62) / 0.2032).toFixed(1)}`);

const colOf = (worldX, worldZ, worldY) => {
  const v = new THREE.Vector3(worldX, worldY, worldZ).project(cam);
  return ((v.x + 1) / 2) * W;
};
console.log("\ncolumns of known front-wall x values at z=31.5, y=F+2:");
for (const wx of [-9.1, -8.9, -8.7, -8.3, -6.575, -5.425, 1.5, 3.5]) {
  console.log(`  x=${String(wx).padStart(7)} -> col ${colOf(wx, 31.5, F + 2).toFixed(1)}`);
}
process.exit(0);
