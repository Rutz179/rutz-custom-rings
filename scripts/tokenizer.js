/**
 * "Use in Tokenizer": make a ring preset the default frame of Tokenizer (vtta-tokenizer) and/or
 * Tokenizer 2 (tokenizer-2), and put the replaced values back. The pure helpers take their inputs;
 * applyToTokenizers / restoreTokenizers do the work through an `io` object the window supplies.
 * vtta-tokenizer: world settings "default-frame-pc" / "-npc" / "-neutral", each a "[source] path" string.
 * tokenizer-2: world setting "frame-rules" { enabled, rules: { [systemId]: [{ fact, op, value, frame }] }, otherwise }, plain paths.
 */
import {MODULE_ID} from "./presets.js";

export const VTTA = "vtta-tokenizer";
export const TOK2 = "tokenizer-2";
export const TOKENIZERS = [VTTA, TOK2];

/** Hidden world setting: {moduleId: {preset: ringKey, values: {settingKey: valueBeforeUs}}}. */
export const BACKUP_KEY = "tokenizerBackup";

export const VTTA_FRAME_KEYS = Object.freeze(["default-frame-pc", "default-frame-npc", "default-frame-neutral", "default-frame-tint"]);
export const TOK2_RULES_KEY = "frame-rules";
const DISPOSITIONS = ["friendly", "neutral", "hostile"];

/** Tokenizer module ids that are active in this world. */
export function activeTokenizers(modules = globalThis.game?.modules) {
  return TOKENIZERS.filter(id => modules?.get?.(id)?.active === true);
}

/** Tokenizer's "[source] path" value. */
export function vttaValue(source, path) {
  return `[${source || "data"}] ${path}`;
}

/** Frame rules for one system with a single frame for every disposition; other systems and fields kept. */
export function tok2RulesValue(current, systemId, path) {
  const cur = (current && (typeof current === "object")) ? current : {};
  const rules = (cur.rules && (typeof cur.rules === "object") && !Array.isArray(cur.rules)) ? {...cur.rules} : {};
  rules[systemId] = DISPOSITIONS.map(value => ({fact: "disposition", op: "is", value, frame: path}));
  return {
    enabled: cur.enabled === true,
    rules,
    otherwise: (typeof cur.otherwise === "string") ? cur.otherwise : ""
  };
}

/** The settings one tokenizer gets: {key: newValue}. ctx: { path (uploaded frame path), source (upload source), systemId, read(moduleId, key) → current value } */
export function writesFor(id, {path, source, systemId, read}) {
  if ( id === VTTA ) return Object.fromEntries(VTTA_FRAME_KEYS.map(k => [k, vttaValue(source, path)]));
  if ( id === TOK2 ) return {[TOK2_RULES_KEY]: tok2RulesValue(read(TOK2, TOK2_RULES_KEY), systemId, path)};
  return {};
}

/** The key of the ring each tokenizer currently uses from us (or null). */
export function appliedPreset(backup, id) {
  const entry = backup?.[id];
  return (entry && (typeof entry === "object") && entry.preset) ? entry.preset : null;
}

/** Is this ring the one we gave to any active tokenizer? */
export function isApplied(backup, key, active) {
  return active.some(id => appliedPreset(backup, id) === key);
}

function readBackup(io) {
  try {
    const v = io.settings.get(MODULE_ID, BACKUP_KEY);
    return (v && (typeof v === "object")) ? structuredClone(v) : {};
  } catch {
    return {};
  }
}

function safeRead(io) {
  return (ns, key) => {
    try {
      return io.settings.get(ns, key);
    } catch {
      return undefined;
    }
  };
}

/** Make a ring the default frame of every active tokenizer (GM only, after a confirm). io: {isGM, active, settings, systemId, systemLabel, confirm(lines), makeFrame(ring) → {path, source}, notify(level, key, data)}. → true when something was written */
export async function applyToTokenizers(ring, io) {
  if ( !io.isGM ) {
    io.notify("warn", "Notify.GMOnly");
    return false;
  }
  const active = io.active;
  if ( !active.length || !ring?.spritesheet ) return false;
  const lines = active.map(id => (id === VTTA) ? {key: "Tokenizer.Vtta"} : {key: "Tokenizer.Tok2", data: {system: io.systemLabel}});
  if ( !(await io.confirm(ring.name, lines)) ) return false;
  try {
    const {path, source} = await io.makeFrame(ring);
    const read = safeRead(io);
    const backup = readBackup(io);
    for ( const id of active ) {
      const writes = writesFor(id, {path, source, systemId: io.systemId, read});
      // Keep the values from before our first change, so undo always goes back to the GM's own setup.
      const values = backup[id]?.values ?? Object.fromEntries(Object.keys(writes).map(k => [k, read(id, k)]));
      for ( const [k, v] of Object.entries(writes) ) await io.settings.set(id, k, v);
      backup[id] = {preset: ring.key, values};
    }
    await io.settings.set(MODULE_ID, BACKUP_KEY, backup);
    io.notify("info", "Tokenizer.Applied", {name: ring.name});
    return true;
  } catch(err) {
    console.error(`${MODULE_ID} | Tokenizer frame failed`, err);
    io.notify("error", "Tokenizer.Failed", {error: err?.message ?? String(err)});
    return false;
  }
}

/** Put back what we replaced for this ring (or, without a key, for any ring) in every active tokenizer (GM only). */
export async function restoreTokenizers(io, key = null) {
  if ( !io.isGM ) {
    io.notify("warn", "Notify.GMOnly");
    return false;
  }
  const backup = readBackup(io);
  let done = false;
  try {
    for ( const id of io.active ) {
      const entry = backup[id];
      if ( !entry?.values || (key && (entry.preset !== key)) ) continue;
      for ( const [k, v] of Object.entries(entry.values) ) {
        // undefined = the setting could not be read before; leave it alone.
        if ( v !== undefined ) await io.settings.set(id, k, v);
      }
      delete backup[id];
      done = true;
    }
    if ( done ) {
      await io.settings.set(MODULE_ID, BACKUP_KEY, backup);
      io.notify("info", "Tokenizer.Restored");
    }
  } catch(err) {
    console.error(`${MODULE_ID} | Tokenizer restore failed`, err);
    io.notify("error", "Tokenizer.Failed", {error: err?.message ?? String(err)});
    return false;
  }
  return done;
}
