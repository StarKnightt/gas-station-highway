/**
 * CPU entry for the inter-plant mat. Re-exports the cover field, the sheet
 * builder and the sprig scatter against the *real* `groundSoil` field, so the
 * mat can be measured against the same soil the renderer will use rather than
 * against a stub that agrees with it by assumption.
 */
export { makeMatField, buildMatSheet, makeRoadFringeRegion, scatterSprigs, thatchSprigGeometry } from "../src/gen/vegMat";
export { makeSoilField } from "../src/gen/groundSoil";
export { DRIVEWAYS, PAD, ROAD } from "../src/site";
