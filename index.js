import {
  MODULE_ID, BUILTINS, ringEffects, worldKey, registeredSheets, readPresetsSafe, getDynamicRingData,
  readBuiltinEditsSafe, effectiveBuiltin
} from "./scripts/presets.js";
import {RingManager, openManager, applyPending} from "./scripts/manager.js";

Hooks.once("init", () => {
  // World scope: every world keeps its own presets.
  game.settings.register(MODULE_ID, "presets", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  // A preset saved this session can only be registered after a reload; it waits here.
  game.settings.register(MODULE_ID, "pending", {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  // Per-world edits of the built-in rings: {overrides: {key: {...}}, hidden: {key: true}}.
  game.settings.register(MODULE_ID, "builtins", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  // Tokenizer setting values we replaced with "Use in Tokenizer", for undo (scripts/tokenizer.js).
  game.settings.register(MODULE_ID, "tokenizerBackup", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.registerMenu(MODULE_ID, "manager", {
    name: "RUTZRINGS.Menu.Name",
    label: "RUTZRINGS.Menu.Label",
    hint: "RUTZRINGS.Menu.Hint",
    icon: "fa-solid fa-ring",
    type: RingManager,
    restricted: true
  });

  const mod = game.modules.get(MODULE_ID);
  if ( mod ) mod.api = {open: openManager};
});

/* Foundry builds ring configs once per session between "setup" and "ready"; addConfig only works inside this hook, and world settings (ours included) are readable here. */
Hooks.on("initializeDynamicTokenRingConfig", registry => {
  const DynamicRingData = getDynamicRingData();
  registeredSheets.clear();

  // Built-ins keep their keys; a world override swaps label + spritesheet, hidden ones are skipped.
  const edits = readBuiltinEditsSafe();
  for ( const builtin of BUILTINS ) {
    const ring = effectiveBuiltin(builtin, edits);
    if ( ring.hidden ) continue;
    try {
      registry.addConfig(ring.key, new DynamicRingData({
        id: ring.key,
        label: ring.label,
        spritesheet: ring.spritesheet,
        effects: ringEffects()
      }));
      registeredSheets.set(ring.key, ring.spritesheet);
    } catch(err) {
      console.error(`${MODULE_ID} | could not register ${ring.key}`, err);
    }
  }

  for ( const preset of readPresetsSafe() ) {
    const key = worldKey(preset.id);
    try {
      registry.addConfig(key, new DynamicRingData({
        id: key,
        label: preset.name || key,
        spritesheet: preset.spritesheet,
        effects: ringEffects()
      }));
      registeredSheets.set(key, preset.spritesheet);
    } catch(err) {
      console.error(`${MODULE_ID} | could not register world preset ${key}`, err);
    }
  }
});

Hooks.once("ready", () => {
  applyPending().catch(err => console.error(`${MODULE_ID} | could not apply pending ring`, err));
});
