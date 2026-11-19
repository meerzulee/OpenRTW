import { findTerrainMaterialSource } from './terrain-material-source.js';

// Recovered selector inputs only. World-category production, climate selection,
// unnamed texture-slot meaning, UVs and blending require separate evidence.
export const aerialMaterialSelectionSpec = Object.freeze({
  schema: 'openrtw-aerial-material-selection-v1',
  sourceFunction: '0x009e860a',
  scope: 'selector-input-to-role',
  categoryProducerEstablished: false,
  climateSelectionEstablished: false,
  textureSlotSemanticsEstablished: false,
  uvEstablished: false,
  nativeRenderingEquivalent: false,
});
const roles = Object.freeze([
  'fertility_low',
  'fertility_medium',
  'fertility_high',
  'fertility_low',
  'mountains_high',
  'mountains_low',
  'hills',
  'forest_dense',
  'forest_sparse',
  'swamp',
  'beach',
  'beach',
  'beach',
  'beach',
]);
const cultivated = Object.freeze(['cultivated_low', 'cultivated_medium', 'cultivated_high']);
const refuse = (message) => {
  throw new TypeError('Aerial material selection: ' + message);
};
const isByte = (value) => Number.isInteger(value) && value >= 0 && value <= 255;

// Flags are byte arguments, and only the exact value 1 takes either branch.
// A scorched request overrides category dispatch, including its null result.
export function selectAerialMaterialRole(category, byteArg4 = 0, byteArg5 = 0) {
  if (!Number.isInteger(category) || category < -2147483648 || category > 2147483647)
    refuse('category must be int32');
  if (!isByte(byteArg4) || !isByte(byteArg5)) refuse('flags must be uint8');
  if (byteArg5 === 1) return 'scorched';
  if (byteArg4 === 1 && category >= 0 && category <= 2) return cultivated[category];
  return category >= 0 && category < roles.length ? roles[category] : null;
}

// The literal helper preserves separate exact/default declarations. A null
// selector role performs no declaration lookup; it never substitutes default.
export function findAerialMaterialSelection(
  declarations,
  { climateName, category, byteArg4 = 0, byteArg5 = 0 } = {}
) {
  const role = selectAerialMaterialRole(category, byteArg4, byteArg5);
  const declarationLookup =
    role === null
      ? null
      : findTerrainMaterialSource(declarations, { climateName, groundType: role });
  return Object.freeze({
    selectorInput: Object.freeze({ category, byteArg4, byteArg5 }),
    role,
    declarationLookup,
  });
}
