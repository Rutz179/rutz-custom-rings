/** Shared constants and helpers for ring presets. */
export const MODULE_ID = "rutz-custom-rings";

/** Built-in ring folders and their sheet images (for thumbnails). */
const BUILTIN_DIRS = [
  ["sot", "token-ring-sheet-sot.webp"],
  ["spider-web", "token-ring-sheet.webp"],
  ["hr", "token-ring-sheet-hr.webp"],
  ["slinky", "slinky.webp"],
  ["silver", "token-ring-sheet-silver.webp"]
];

/** Key/label rules: "spider-web" -> "spiderwebRing" / "RUTZ Spider Web Ring". */
export const BUILTINS = BUILTIN_DIRS.map(([ring, image]) => ({
  key: ring.replace(/-/g, "") + "Ring",
  label: "RUTZ " + ring.replace(/-/g, " ").replace(/\b\w/g, l => l.toUpperCase()) + " Ring",
  spritesheet: `modules/${MODULE_ID}/assets/ring/${ring}/rings.json`,
  image: `modules/${MODULE_ID}/assets/ring/${ring}/${image}`
}));

/** A fresh effects object for each DynamicRingData (the model may take ownership of it). */
export function ringEffects() {
  return {
    RING_PULSE: "TOKEN.RING.EFFECTS.RING_PULSE",
    BKG_WAVE: "TOKEN.RING.EFFECTS.BKG_WAVE",
    INVISIBILITY: "TOKEN.RING.EFFECTS.INVISIBILITY"
  };
}

/** Ring config key for a world preset id. */
export function worldKey(id) {
  return `rutz_${id}`;
}

/** World preset keys registered at startup, with the spritesheet they were registered with. */
export const registeredSheets = new Map();

/** DynamicRingData class (V13+ namespace first, V12 fallback). */
export function getDynamicRingData() {
  return foundry.canvas.placeables?.tokens?.DynamicRingData ?? foundry.canvas.tokens?.DynamicRingData;
}

/** All world presets as a plain object { id: preset }. */
export function getPresets() {
  const value = game.settings.get(MODULE_ID, "presets");
  return foundry.utils.deepClone(value && (typeof value === "object") ? value : {});
}

export async function setPresets(presets) {
  return game.settings.set(MODULE_ID, "presets", presets);
}

/** World presets that can be registered; never throws. */
export function readPresetsSafe() {
  try {
    return Object.values(getPresets()).filter(p => p && (typeof p.id === "string") && p.id
      && (typeof p.spritesheet === "string") && p.spritesheet);
  } catch(err) {
    console.warn(`${MODULE_ID} | could not read world ring presets`, err);
    return [];
  }
}

/** Per-world changes to built-in rings: { overrides: { key: override }, hidden: { key: true } }; an override keeps the key but swaps label and spritesheet. */
export function getBuiltinEdits() {
  const value = game.settings.get(MODULE_ID, "builtins");
  const data = (value && (typeof value === "object")) ? foundry.utils.deepClone(value) : {};
  const obj = v => ((v && (typeof v === "object") && !Array.isArray(v)) ? v : {});
  return {overrides: obj(data.overrides), hidden: obj(data.hidden)};
}

export async function setBuiltinEdits(edits) {
  return game.settings.set(MODULE_ID, "builtins", {overrides: edits.overrides ?? {}, hidden: edits.hidden ?? {}});
}

/** Built-in edits for registration; never throws. */
export function readBuiltinEditsSafe() {
  try {
    return getBuiltinEdits();
  } catch(err) {
    console.warn(`${MODULE_ID} | could not read built-in ring edits`, err);
    return {overrides: {}, hidden: {}};
  }
}

/** What a built-in should look like in this world (original unless edited). */
export function effectiveBuiltin(ring, edits) {
  const override = edits.overrides[ring.key];
  const valid = !!override && (typeof override.spritesheet === "string") && !!override.spritesheet;
  return {
    ...ring,
    label: (valid && override.name) ? String(override.name) : ring.label,
    spritesheet: valid ? override.spritesheet : ring.spritesheet,
    image: (valid && override.image) ? override.image : ring.image,
    edited: valid,
    hidden: edits.hidden[ring.key] === true
  };
}

/** IDs of every ring config Foundry knows about this session. */
export function registeredIds() {
  const ring = CONFIG.Token?.ring;
  if ( !ring ) return [];
  return ring.configIDs ?? Object.keys(ring.configLabels ?? {});
}

/** The ring id the core setting points to. */
export function currentRingId() {
  try {
    return game.settings.get("core", "dynamicTokenRing");
  } catch {
    return null;
  }
}

/** Foundry's own default for the core ring setting. */
export function coreDefaultRingId() {
  const ids = registeredIds();
  const config = game.settings.settings.get("core.dynamicTokenRing");
  let value = config?.default;
  const field = config?.type;
  if ( ((value === undefined) || (value === null)) && field ) {
    value = (typeof field.getInitialValue === "function") ? field.getInitialValue({}) : field.initial;
    if ( typeof value === "function" ) value = value();
  }
  if ( !ids.includes(value) ) value = ["coreBronze", "coreSteel"].find(id => ids.includes(id)) ?? ids[0];
  return value;
}
