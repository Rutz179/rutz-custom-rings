import {
  MODULE_ID, BUILTINS, worldKey, registeredSheets, getPresets, setPresets,
  registeredIds, currentRingId, coreDefaultRingId, getBuiltinEdits, setBuiltinEdits, effectiveBuiltin
} from "./presets.js";
import {
  DEFAULTS, loadImage, composeSheet, buildRingsJson, encodeSheet, drawPreview, makeSampleSubject,
  cropFrame, renderRingFrame, renderBackgroundFrame, composeSheetFrom, measureDisc, patchRingsJson, ringFrameKey,
  NO_TINT_BAND, addInnerShadow, flatRingFrame
} from "./sheet.js";
import {activeTokenizers, isApplied, applyToTokenizers, restoreTokenizers, BACKUP_KEY} from "./tokenizer.js";

const {ApplicationV2} = foundry.applications.api;

const PREVIEW_SIZE = 280;

function L(key, data) {
  const k = `RUTZRINGS.${key}`;
  return data ? game.i18n.format(k, data) : game.i18n.localize(k);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[c]);
}

function cssUrl(path) {
  return `url("${String(path).replace(/["\\\n\r]/g, encodeURIComponent)}")`;
}

function filePickerClass() {
  return foundry.applications.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

function uploadSource() {
  return (globalThis.ForgeVTT?.usingTheForge) ? "forgevtt" : "data";
}

/** Foundry's reload prompt; with world: true it reloads every connected client. */
async function reloadWorld() {
  const SettingsConfig = foundry.applications.settings?.SettingsConfig ?? globalThis.SettingsConfig;
  if ( SettingsConfig?.reloadConfirm ) return SettingsConfig.reloadConfirm({world: true});
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: {title: L("Reload.Title")},
    content: `<p>${esc(L("Reload.Content"))}</p>`,
    rejectClose: false
  });
  if ( ok ) foundry.utils.debouncedReload();
}

/** Create a folder; an existing folder is fine. */
async function ensureDirectory(source, path) {
  try {
    await filePickerClass().createDirectory(source, path, {});
  } catch(err) {
    const message = String(err?.message ?? err);
    if ( !/exist/i.test(message) ) console.debug(`${MODULE_ID} | createDirectory ${path}:`, message);
  }
}

async function uploadFile(source, dir, file) {
  const response = await filePickerClass().upload(source, dir, file, {}, {notify: false});
  if ( !response?.path ) throw new Error(response?.message || response?.error || `Upload failed: ${file.name}`);
  return response.path;
}

function dirname(path) {
  const i = path.lastIndexOf("/");
  return (i >= 0) ? path.slice(0, i) : "";
}

const imageCache = new Map();
function cachedImage(src) {
  if ( !src ) return Promise.resolve(null);
  if ( !imageCache.has(src) ) imageCache.set(src, loadImage(src).catch(err => {
    imageCache.delete(src);
    throw err;
  }));
  return imageCache.get(src);
}

let sampleSubject = null;
async function getSampleSubject() {
  if ( sampleSubject ) return sampleSubject;
  let img = null;
  try {
    img = await cachedImage(CONST.DEFAULT_TOKEN || "icons/svg/mystery-man.svg");
  } catch {
    img = null;
  }
  sampleSubject = makeSampleSubject(img);
  return sampleSubject;
}

/** Foundry's colour band when a frame has none. */
const FOUNDRY_BAND = {startRadius: 0.59, endRadius: 0.7225};

const round2 = n => Math.round(Number(n) * 100) / 100;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.004;

/** Form values for a stored colour band: a zero-width band (start == end) means tint off. */
function bandToForm(band) {
  const start = Number(band?.startRadius);
  const end = Number(band?.endRadius);
  const on = Number.isFinite(start) && Number.isFinite(end) && !near(start, end);
  return on
    ? {tintOn: true, bandStart: round2(start), bandEnd: round2(end)}
    : {tintOn: false, bandStart: DEFAULTS.bandStart, bandEnd: DEFAULTS.bandEnd};
}

/** The band to write: tint off = the zero-width band 0.99-0.99 (keeps the ring art's colours). */
function formBand(data) {
  return data.tintOn
    ? {bandStart: data.bandStart, bandEnd: data.bandEnd}
    : {bandStart: NO_TINT_BAND.startRadius, bandEnd: NO_TINT_BAND.endRadius};
}

async function fetchJson(path) {
  const response = await fetch(path);
  if ( !response.ok ) throw new Error(`${response.status} ${path}`);
  return response.json();
}

/** Load a built-in for editing: the picture is rebuilt from the module's original sheet plus the stored choices (nothing stacks); rings.json values come from the world override when there is one. */
async function loadBuiltinBase(builtin, override = null) {
  const original = await fetchJson(builtin.spritesheet);
  const imageName = original?.meta?.image;
  if ( !imageName ) throw new Error(`No meta.image in ${builtin.spritesheet}`);
  const imageUrl = `${dirname(builtin.spritesheet)}/${imageName}`;
  const img = await loadImage(imageUrl);
  const ringKey = ringFrameKey(original);
  const ringRect = original.frames?.[ringKey]?.frame;
  const bkgRect = original.frames?.[`${ringKey}-bkg`]?.frame;
  if ( !ringRect ) throw new Error(`No ring frame in ${builtin.spritesheet}`);
  const bkgFrame = bkgRect ? cropFrame(img, bkgRect) : null;
  const json = override ? await fetchJson(override.spritesheet) : original;
  return {
    key: builtin.key, json, imageUrl, imageName, frame: ringRect.w,
    ringFrame: cropFrame(img, ringRect), bkgFrame, disc: bkgFrame ? measureDisc(bkgFrame) : null
  };
}

/** GM window: list ring presets, make or edit world presets, pick the ring this world uses. */
export class RingManager extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "rutz-custom-rings-{id}",
    classes: ["rutz-rings-app"],
    tag: "div",
    window: {
      title: "RUTZRINGS.Title",
      icon: "fa-solid fa-ring",
      resizable: true
    },
    position: {width: 900, height: 700},
    actions: {
      newPreset: RingManager.#onNew,
      editPreset: RingManager.#onEdit,
      editBuiltin: RingManager.#onEditBuiltin,
      resetBuiltin: RingManager.#onResetBuiltin,
      hideBuiltin: RingManager.#onHideBuiltin,
      showBuiltin: RingManager.#onShowBuiltin,
      deletePreset: RingManager.#onDelete,
      usePreset: RingManager.#onUse,
      applySelected: RingManager.#onApplySelected,
      useDefault: RingManager.#onUseDefault,
      browse: RingManager.#onBrowse,
      clearField: RingManager.#onClearField,
      cancelEdit: RingManager.#onCancel,
      savePreset: RingManager.#onSave,
      tokenizer: RingManager.#onTokenizer
    }
  };

  /** Editor state: null when no preset is open. */
  editing = null;

  busy = false;

  #previewFrame = null;

  #previewToken = 0;

  /** Frames of the built-in being edited. */
  #base = null;

  #hiddenOpen = false;

  async _prepareContext(_options) {
    const current = currentRingId();
    const ids = registeredIds();
    const labels = CONFIG.Token?.ring?.configLabels ?? {};
    const pending = game.settings.get(MODULE_ID, "pending") || "";
    const presets = Object.values(getPresets()).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const tokenizers = activeTokenizers();
    const tokBackup = tokenizers.length ? (game.settings.get(MODULE_ID, BACKUP_KEY) ?? {}) : {};
    const tok = key => (tokenizers.length ? {tok: true, tokApplied: isApplied(tokBackup, key, tokenizers)} : {tok: false});

    const edits = getBuiltinEdits();
    const builtinRows = BUILTINS.map(b => {
      const ring = effectiveBuiltin(b, edits);
      return {
        ...tok(ring.key),
        key: ring.key, name: ring.label, image: ring.image, builtin: true, edited: ring.edited, hidden: ring.hidden,
        active: current === ring.key, registered: registeredSheets.get(ring.key) === ring.spritesheet
      };
    });
    const builtins = builtinRows.filter(r => !r.hidden);
    const hidden = builtinRows.filter(r => r.hidden);
    const world = presets.map(p => {
      const key = worldKey(p.id);
      const registered = registeredSheets.get(key) === p.spritesheet;
      return {
        ...tok(key),
        key, id: p.id, name: p.name || key, image: p.image, builtin: false,
        active: current === key, registered, pending: pending === key
      };
    });

    const choices = ids.map(id => ({id, label: game.i18n.localize(labels[id] ?? id), selected: id === current}));
    const pendingPreset = world.find(p => p.pending);
    return {current, choices, builtins, hidden, world, pendingName: pendingPreset?.name ?? null, editing: this.editing};
  }

  async _renderHTML(context, _options) {
    const root = document.createElement("div");
    root.className = "rr-root";
    root.innerHTML = `
      <header class="rr-current">
        <label for="rr-current-select">${esc(L("Current"))}</label>
        <select id="rr-current-select" name="currentRing">
          ${context.choices.map(c => `<option value="${esc(c.id)}"${c.selected ? " selected" : ""}>${esc(c.label)}</option>`).join("")}
        </select>
        <button type="button" data-action="applySelected"><i class="fa-solid fa-check"></i> ${esc(L("Apply"))}</button>
        <button type="button" data-action="useDefault"><i class="fa-solid fa-rotate-left"></i> ${esc(L("UseDefault"))}</button>
      </header>
      ${context.pendingName ? `<p class="rr-note"><i class="fa-solid fa-clock"></i> ${esc(L("PendingNote", {name: context.pendingName}))}</p>` : ""}
      <div class="rr-body">
        <section class="rr-list">
          <h3>${esc(L("WorldPresets"))}</h3>
          <button type="button" class="rr-new" data-action="newPreset"><i class="fa-solid fa-plus"></i> ${esc(L("New"))}</button>
          ${context.world.length ? context.world.map(p => this.#rowHTML(p)).join("") : `<p class="rr-empty">${esc(L("NoPresets"))}</p>`}
          <h3>${esc(L("BuiltIn"))}</h3>
          ${context.builtins.map(p => this.#rowHTML(p)).join("")}
          ${context.hidden.length ? `
          <details class="rr-hidden"${this.#hiddenOpen ? " open" : ""}>
            <summary>${esc(L("HiddenCount", {n: context.hidden.length}))}</summary>
            ${context.hidden.map(p => this.#hiddenRowHTML(p)).join("")}
          </details>` : ""}
        </section>
        <section class="rr-editor-pane">
          ${context.editing ? this.#editorHTML(context.editing) : `<p class="rr-empty">${esc(L("PickHint"))}</p>`}
        </section>
      </div>`;
    return root;
  }

  _replaceHTML(result, content, _options) {
    content.replaceChildren(result);
  }

  #rowHTML(p) {
    const thumb = p.image ? `style="${esc(`background-image: ${cssUrl(p.image)}, ${cssUrl(p.image)}`)}"` : "";
    const badges = [];
    if ( p.active ) badges.push(`<span class="rr-badge rr-active">${esc(L("Active"))}</span>`);
    if ( p.edited ) badges.push(`<span class="rr-badge">${esc(L("Edited"))}</span>`);
    if ( p.tokApplied ) badges.push(`<span class="rr-badge">${esc(L("Tokenizer.Badge"))}</span>`);
    if ( !p.registered ) badges.push(`<span class="rr-badge">${esc(L("NeedsReload"))}</span>`);
    const id = p.builtin ? "" : ` data-id="${esc(p.id)}"`;
    const key = ` data-key="${esc(p.key)}"`;
    const icon = (action, label, fa, attrs) => `<button type="button" data-action="${action}"${attrs} data-tooltip="${esc(label)}" aria-label="${esc(label)}"><i class="fa-solid ${fa}"></i></button>`;
    return `
      <div class="rr-row${p.active ? " active" : ""}">
        <div class="rr-thumb" ${thumb}></div>
        <div class="rr-row-main">
          <div class="rr-row-name">${esc(p.name)}</div>
          <div class="rr-row-badges">${badges.join("")}</div>
        </div>
        <div class="rr-row-buttons">
          <button type="button" data-action="usePreset" data-key="${esc(p.key)}" data-tooltip="${esc(L("UseHint"))}"${p.active && p.registered ? " disabled" : ""}>${esc(L("Use"))}</button>
          ${p.tok ? (p.tokApplied
    ? icon("tokenizer", L("Tokenizer.Undo"), "fa-clock-rotate-left", `${key} data-undo="1"`)
    : icon("tokenizer", L("Tokenizer.Use"), "fa-circle-user", key)) : ""}
          ${p.builtin ? [
    icon("editBuiltin", L("Edit"), "fa-pen", key),
    p.edited ? icon("resetBuiltin", L("Reset"), "fa-rotate-left", key) : "",
    icon("hideBuiltin", L("Hide"), "fa-eye-slash", key)
  ].join("") : [
    icon("editPreset", L("Edit"), "fa-pen", id),
    icon("deletePreset", L("Delete"), "fa-trash", id)
  ].join("")}
        </div>
      </div>`;
  }

  #hiddenRowHTML(p) {
    const thumb = p.image ? `style="${esc(`background-image: ${cssUrl(p.image)}, ${cssUrl(p.image)}`)}"` : "";
    return `
      <div class="rr-row rr-row-hidden">
        <div class="rr-thumb" ${thumb}></div>
        <div class="rr-row-main"><div class="rr-row-name">${esc(p.name)}</div></div>
        <div class="rr-row-buttons">
          <button type="button" data-action="showBuiltin" data-key="${esc(p.key)}">${esc(L("Show"))}</button>
        </div>
      </div>`;
  }

  #fileField(name, value, label, hint, {clearable = false, placeholder = null} = {}) {
    return `
      <div class="rr-field">
        <label>${esc(label)}</label>
        <div class="rr-file">
          <input type="text" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder ?? hint)}">
          <button type="button" data-action="browse" data-target="${name}" data-tooltip="${esc(L("Browse"))}" aria-label="${esc(L("Browse"))}"><i class="fa-solid fa-file-import"></i></button>
          ${clearable ? `<button type="button" data-action="clearField" data-target="${name}" data-tooltip="${esc(L("Clear"))}" aria-label="${esc(L("Clear"))}"><i class="fa-solid fa-xmark"></i></button>` : ""}
        </div>
      </div>`;
  }

  #rangeField(name, value, label, {min = 0, max = 1, step = 0.01, hint = "", disabled = false, percent = false} = {}) {
    return `
      <div class="rr-field">
        <label>${esc(label)}</label>
        <div class="rr-range">
          <input type="range" name="${name}" min="${min}" max="${max}" step="${step}" value="${esc(value)}"${disabled ? " disabled" : ""}>
          <output data-for="${name}"${percent ? " data-percent" : ""}>${esc(percent ? `${Math.round(Number(value) * 100)}%` : Number(value).toFixed(2))}</output>
        </div>
        ${hint ? `<p class="rr-hint">${esc(hint)}</p>` : ""}
      </div>`;
  }

  #editorHTML(e) {
    return `
      <form class="rr-editor" autocomplete="off">
        <input type="hidden" name="id" value="${esc(e.id ?? "")}">
        <input type="hidden" name="builtin" value="${esc(e.builtin ?? "")}">
        <div class="rr-editor-grid">
          <div class="rr-fields">
            <div class="rr-field">
              <label>${esc(L("Field.Name"))}</label>
              <input type="text" name="name" value="${esc(e.name)}" maxlength="60">
            </div>
            ${this.#fileField("ringImg", e.ringImg, L("Field.Ring"), L("Field.RingHint"),
    {clearable: !!e.builtin, placeholder: e.builtin ? L("Field.BuiltinPicture") : null})}
            ${this.#fileField("bkgImg", e.bkgImg, L("Field.Bkg"), L("Field.BkgHint"),
    {clearable: true, placeholder: e.builtin ? L("Field.BuiltinPicture") : null})}
            <div class="rr-field">
              <label>${esc(L("Field.BkgColor"))}</label>
              <div class="rr-inline">
                <input type="checkbox" name="bkgColorOn"${e.bkgColorOn ? " checked" : ""} aria-label="${esc(L("Field.BkgColor"))}">
                <input type="color" name="bkgColor" value="${esc(e.bkgColor)}">
              </div>
            </div>
            ${this.#rangeField("bkgSize", e.bkgSize, L("Field.BkgSize"), {min: 0.3, max: 1})}
            ${this.#rangeField("ringThickness", e.ringThickness, L("Field.Thickness"), {min: 0, max: 0.6, hint: L("Field.ThicknessHint")})}
            ${this.#rangeField("shadow", e.shadow ?? 0, L("Field.Shadow"), {hint: L("Field.ShadowHint"), percent: true})}
            <div class="rr-field">
              <label>${esc(L("Field.RingColor"))}</label>
              <input type="color" name="ringColor" value="${esc(e.ringColor)}">
            </div>
            <div class="rr-field">
              <label class="rr-check"><input type="checkbox" name="tintOn"${e.tintOn ? " checked" : ""}> ${esc(L("Field.Tint"))}</label>
              <p class="rr-hint">${esc(L("Field.TintHint"))}</p>
            </div>
            ${this.#rangeField("bandStart", e.bandStart, L("Field.BandStart"), {disabled: !e.tintOn})}
            ${this.#rangeField("bandEnd", e.bandEnd, L("Field.BandEnd"), {hint: L("Field.BandHint"), disabled: !e.tintOn})}
          </div>
          <div class="rr-preview">
            <canvas class="rr-preview-canvas" width="${PREVIEW_SIZE}" height="${PREVIEW_SIZE}"></canvas>
            <p class="rr-hint">${esc(L("PreviewHint"))}</p>
            ${this.#fileField("previewImg", e.previewImg, L("Field.PreviewToken"), L("Field.PreviewTokenHint"), {clearable: true})}
          </div>
        </div>
        <footer class="rr-editor-buttons">
          <button type="button" data-action="cancelEdit"><i class="fa-solid fa-xmark"></i> ${esc(L("Cancel"))}</button>
          <button type="button" data-action="savePreset" class="rr-save"${this.busy ? " disabled" : ""}><i class="fa-solid fa-floppy-disk"></i> ${esc(this.busy ? L("Saving") : L("Save"))}</button>
        </footer>
      </form>`;
  }

  async _onRender(context, options) {
    await super._onRender?.(context, options);
    const details = this.element.querySelector("details.rr-hidden");
    details?.addEventListener("toggle", () => this.#hiddenOpen = details.open);
    const form = this.element.querySelector("form.rr-editor");
    if ( !form ) return;
    form.addEventListener("submit", event => event.preventDefault());
    form.addEventListener("input", event => {
      const out = form.querySelector(`output[data-for="${event.target?.name}"]`);
      if ( out ) {
        const v = Number(event.target.value);
        out.textContent = out.hasAttribute("data-percent") ? `${Math.round(v * 100)}%` : v.toFixed(2);
      }
      if ( event.target?.name ) this.#keepEdits();
      this.#schedulePreview();
    });
    form.addEventListener("change", event => {
      if ( event.target?.name === "tintOn" ) {
        for ( const n of ["bandStart", "bandEnd"] ) form.elements[n].disabled = !event.target.checked;
      }
      this.#keepEdits();
      this.#schedulePreview();
    });
    this.#schedulePreview();
  }

  /** Values currently in the editor form. */
  #readForm() {
    const form = this.element?.querySelector("form.rr-editor");
    if ( !form ) return null;
    const el = form.elements;
    const num = (name, fallback) => {
      const n = Number(el[name]?.value);
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      id: el.id.value || null,
      builtin: el.builtin?.value || null,
      name: el.name.value.trim(),
      ringImg: el.ringImg.value.trim(),
      bkgImg: el.bkgImg.value.trim(),
      bkgColorOn: el.bkgColorOn.checked,
      bkgColor: el.bkgColor.value || DEFAULTS.bkgColor,
      bkgSize: num("bkgSize", DEFAULTS.bkgSize),
      ringThickness: num("ringThickness", DEFAULTS.ringThickness),
      shadow: num("shadow", 0),
      ringColor: el.ringColor.value || DEFAULTS.ringColor,
      tintOn: !!el.tintOn?.checked,
      bandStart: num("bandStart", DEFAULTS.bandStart),
      bandEnd: num("bandEnd", DEFAULTS.bandEnd),
      previewImg: el.previewImg.value.trim()
    };
  }

  /** Keep typed values across re-renders. */
  #keepEdits() {
    const data = this.#readForm();
    if ( data && this.editing ) Object.assign(this.editing, data);
  }

  /** Built-in edit: did the GM change the background (new texture, tint or size)? */
  #bkgChanged(data) {
    const initial = this.editing?.initial;
    if ( !initial ) return true;
    return !!data.bkgImg || data.bkgColorOn || !near(data.bkgSize, initial.bkgSize);
  }

  #schedulePreview() {
    if ( this.#previewFrame ) return;
    this.#previewFrame = requestAnimationFrame(() => {
      this.#previewFrame = null;
      this.#drawPreview();
    });
  }

  async #drawPreview() {
    const canvas = this.element?.querySelector(".rr-preview-canvas");
    const data = this.#readForm();
    if ( !canvas || !data ) return;
    const token = ++this.#previewToken;
    const safe = p => p.catch(() => null);
    const [ring, bkg, custom] = await Promise.all([
      safe(cachedImage(data.ringImg)), safe(cachedImage(data.bkgImg)), safe(cachedImage(data.previewImg))
    ]);
    const subject = custom ?? await getSampleSubject();
    if ( token !== this.#previewToken ) return;
    // Built-in: draw its own frames until a new picture is picked.
    const base = (data.builtin && (this.#base?.key === data.builtin)) ? this.#base : null;
    const ringFrame = (base && !data.ringImg) ? base.ringFrame : null;
    const bkgFrame = (base && !this.#bkgChanged(data)) ? base.bkgFrame : null;
    drawPreview(canvas, {
      ring, ringFrame, subject,
      bkg: bkg ?? ((base && !bkgFrame) ? (base.disc?.canvas ?? null) : null),
      bkgFrame,
      bkgColor: data.bkgColorOn ? data.bkgColor : null,
      bkgSize: data.bkgSize,
      ringThickness: data.ringThickness,
      shadow: data.shadow,
      ringColor: data.ringColor,
      ...formBand(data)
    });
  }

  /* Actions */

  static #onNew() {
    this.editing = {
      id: null, name: "", ringImg: "", bkgImg: "", bkgColorOn: false, bkgColor: DEFAULTS.bkgColor,
      bkgSize: DEFAULTS.bkgSize, ringThickness: DEFAULTS.ringThickness, ringColor: DEFAULTS.ringColor,
      shadow: DEFAULTS.shadow, tintOn: false, bandStart: DEFAULTS.bandStart, bandEnd: DEFAULTS.bandEnd, previewImg: ""
    };
    this.#base = null;
    this.render();
  }

  static #onEdit(_event, target) {
    const preset = getPresets()[target.dataset.id];
    if ( !preset ) return;
    this.editing = {
      id: preset.id,
      name: preset.name ?? "",
      ringImg: preset.ringImg ?? "",
      bkgImg: preset.bkgImg ?? "",
      bkgColorOn: !!preset.bkgColor,
      bkgColor: preset.bkgColor || DEFAULTS.bkgColor,
      bkgSize: preset.bkgSize ?? DEFAULTS.bkgSize,
      ringThickness: preset.ringThickness ?? DEFAULTS.ringThickness,
      shadow: preset.shadow ?? 0,
      ringColor: preset.ringColor ?? DEFAULTS.ringColor,
      ...bandToForm({startRadius: preset.bandStart, endRadius: preset.bandEnd}),
      previewImg: this.editing?.previewImg ?? ""
    };
    this.#base = null;
    this.render();
  }

  /** Open a built-in in the editor, prefilled from its rings.json and its own picture. */
  static async #onEditBuiltin(_event, target) {
    const builtin = BUILTINS.find(b => b.key === target.dataset.key);
    if ( !builtin ) return;
    const edits = getBuiltinEdits();
    const ring = effectiveBuiltin(builtin, edits);
    const override = ring.edited ? edits.overrides[ring.key] : null;
    let base;
    try {
      base = await loadBuiltinBase(builtin, override);
    } catch(err) {
      console.error(`${MODULE_ID} | could not load ${ring.spritesheet}`, err);
      return ui.notifications.error(L("Notify.LoadFailed", {error: err?.message ?? String(err)}));
    }
    const frame = base.json.frames?.[ringFrameKey(base.json)] ?? {};
    const configColor = base.json.config?.defaultRingColor;
    const band = frame.colorBand ?? FOUNDRY_BAND;
    // Rounded to the slider steps, so an untouched slider counts as unchanged.
    const initial = {
      ringThickness: round2(frame.ringThickness ?? DEFAULTS.ringThickness),
      ringColor: /^#[0-9a-f]{6}$/i.test(configColor ?? "") ? configColor.toLowerCase() : DEFAULTS.ringColor,
      ...bandToForm(band),
      bkgSize: Math.min(1, Math.max(0.3, round2(base.disc?.size ?? DEFAULTS.bkgSize)))
    };
    this.#base = base;
    // Picture choices of an earlier edit (applied again on top of the original picture).
    this.editing = {
      id: null, builtin: ring.key, name: ring.label, ...initial,
      ringImg: override?.ringImg || "",
      bkgImg: override?.bkgImg || "",
      bkgColorOn: !!override?.bkgColor,
      bkgColor: override?.bkgColor || DEFAULTS.bkgColor,
      bkgSize: Number.isFinite(override?.bkgSize) ? override.bkgSize : initial.bkgSize,
      shadow: Number.isFinite(override?.shadow) ? override.shadow : 0,
      previewImg: this.editing?.previewImg ?? "", initial
    };
    this.render();
  }

  static async #onResetBuiltin(_event, target) {
    const key = target.dataset.key;
    const builtin = BUILTINS.find(b => b.key === key);
    const edits = getBuiltinEdits();
    if ( !builtin || !edits.overrides[key] ) return;
    const name = edits.overrides[key].name || builtin.label;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: {title: L("ResetDlg.Title")},
      content: `<p>${esc(L("ResetDlg.Content", {name, original: builtin.label}))}</p>`,
      rejectClose: false
    });
    if ( !ok ) return;
    delete edits.overrides[key];
    await setBuiltinEdits(edits);
    if ( this.editing?.builtin === key ) {
      this.editing = null;
      this.#base = null;
    }
    await this.render();
    if ( currentRingId() === key ) await reloadWorld();
  }

  static async #onHideBuiltin(_event, target) {
    const key = target.dataset.key;
    const builtin = BUILTINS.find(b => b.key === key);
    if ( !builtin ) return;
    const edits = getBuiltinEdits();
    const ring = effectiveBuiltin(builtin, edits);
    const inUse = currentRingId() === key;
    const content = `<p>${esc(L("HideDlg.Content", {name: ring.label}))}</p>`
      + (inUse ? `<p>${esc(L("DeleteDlg.InUse"))}</p>` : "");
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: {title: L("HideDlg.Title")}, content, rejectClose: false
    });
    if ( !ok ) return;
    if ( inUse ) await game.settings.set("core", "dynamicTokenRing", coreDefaultRingId());
    if ( game.settings.get(MODULE_ID, "pending") === key ) await game.settings.set(MODULE_ID, "pending", "");
    edits.hidden[key] = true;
    await setBuiltinEdits(edits);
    if ( this.editing?.builtin === key ) {
      this.editing = null;
      this.#base = null;
    }
    await this.render();
    if ( inUse ) await reloadWorld();
  }

  static async #onShowBuiltin(_event, target) {
    const edits = getBuiltinEdits();
    delete edits.hidden[target.dataset.key];
    await setBuiltinEdits(edits);
    await this.render();
  }

  static #onCancel() {
    this.editing = null;
    this.#base = null;
    this.render();
  }

  static #onBrowse(_event, target) {
    const name = target.dataset.target;
    const input = this.element.querySelector(`form.rr-editor [name="${name}"]`);
    if ( !input ) return;
    const FP = filePickerClass();
    const picker = new FP({
      type: "image",
      current: input.value,
      callback: path => {
        input.value = path;
        input.dispatchEvent(new Event("change", {bubbles: true}));
      }
    });
    picker.render(true);
  }

  static #onClearField(_event, target) {
    const input = this.element.querySelector(`form.rr-editor [name="${target.dataset.target}"]`);
    if ( !input ) return;
    input.value = "";
    input.dispatchEvent(new Event("change", {bubbles: true}));
  }

  static async #onSave() {
    if ( this.busy ) return;
    const data = this.#readForm();
    if ( !data ) return;
    if ( !data.name ) return ui.notifications.warn(L("Notify.NeedName"));
    if ( !data.ringImg && !data.builtin ) return ui.notifications.warn(L("Notify.NeedRing"));
    this.editing = {...this.editing, ...data};
    this.busy = true;
    this.render();
    try {
      const saved = data.builtin ? await this.#saveBuiltin(data) : await this.#savePreset(data);
      const savedKey = data.builtin ? data.builtin : worldKey(saved.id);
      this.editing = null;
      this.#base = null;
      ui.notifications.info(L("Notify.Saved", {name: saved.name}));
      if ( currentRingId() === savedKey ) {
        this.busy = false;
        await this.render();
        await reloadWorld();
        return;
      }
    } catch(err) {
      console.error(`${MODULE_ID} | save failed`, err);
      ui.notifications.error(L("Notify.SaveFailed", {error: err?.message ?? String(err)}));
    }
    this.busy = false;
    this.render();
  }

  /** Build the sheet in the browser, upload sheet + rings.json, store the preset. */
  async #savePreset(data) {
    const [ring, bkg] = await Promise.all([loadImage(data.ringImg), data.bkgImg ? loadImage(data.bkgImg) : null]);
    const bkgColor = data.bkgColorOn ? data.bkgColor : null;
    const sheet = composeSheet({
      ring, bkg, bkgColor, bkgSize: data.bkgSize, shadow: data.shadow, ringThickness: data.ringThickness
    });
    const {blob, ext, type} = await encodeSheet(sheet);

    const id = data.id || foundry.utils.randomID(12);
    const stamp = Date.now().toString(36);
    const source = uploadSource();
    const base = `worlds/${game.world.id}/${MODULE_ID}`;
    const dir = `${base}/${id}`;
    await ensureDirectory(source, base);
    await ensureDirectory(source, dir);

    const imageName = `sheet-${stamp}.${ext}`;
    await uploadFile(source, dir, new File([blob], imageName, {type}));
    const json = buildRingsJson({
      imageName,
      ringThickness: data.ringThickness,
      ringColor: data.ringColor,
      ...formBand(data)
    });
    const jsonName = `rings-${stamp}.json`;
    const jsonFile = new File([JSON.stringify(json, null, 2)], jsonName, {type: "application/json"});
    const spritesheet = await uploadFile(source, dir, jsonFile);

    const preset = {
      id,
      name: data.name,
      spritesheet,
      image: `${dirname(spritesheet)}/${imageName}`,
      ringImg: data.ringImg,
      bkgImg: data.bkgImg,
      bkgColor,
      bkgSize: data.bkgSize,
      shadow: data.shadow,
      ringThickness: json.frames["token-ring"].ringThickness,
      ringColor: json.config.defaultRingColor,
      bandStart: json.frames["token-ring"].colorBand.startRadius,
      bandEnd: json.frames["token-ring"].colorBand.endRadius,
      updated: Date.now()
    };
    const presets = getPresets();
    presets[id] = preset;
    await setPresets(presets);
    return preset;
  }

  /** Save an edited built-in as a world override under the same key: the sheet is copied as-is without a new picture, else recomposed keeping the untouched frame; only changed values go into the copied rings.json. */
  async #saveBuiltin(data) {
    const key = data.builtin;
    const base = this.#base;
    const initial = this.editing?.initial;
    if ( !base || (base.key !== key) || !initial ) throw new Error("Built-in ring not loaded.");
    const bkgChanged = this.#bkgChanged(data);
    const shadow = (data.shadow > 0.004) ? data.shadow : 0;
    const pictureChanged = !!data.ringImg || bkgChanged || (shadow > 0);

    const stamp = Date.now().toString(36);
    const source = uploadSource();
    const root = `worlds/${game.world.id}/${MODULE_ID}`;
    const dir = `${root}/builtin-${key}`;
    await ensureDirectory(source, root);
    await ensureDirectory(source, dir);

    let imageName;
    let frame = null;
    if ( !pictureChanged ) {
      const response = await fetch(base.imageUrl);
      if ( !response.ok ) throw new Error(`${response.status} ${base.imageUrl}`);
      const blob = await response.blob();
      const ext = (base.imageName.split(".").pop() || "webp").toLowerCase();
      imageName = `sheet-${stamp}.${ext}`;
      await uploadFile(source, dir, new File([blob], imageName, {type: blob.type || `image/${ext}`}));
    } else {
      frame = base.frame;
      const ringArt = data.ringImg ? renderRingFrame(await loadImage(data.ringImg), frame) : base.ringFrame;
      const ringFrame = addInnerShadow(ringArt, {strength: shadow, ringThickness: data.ringThickness});
      let bkgFrame = base.bkgFrame;
      if ( bkgChanged ) {
        const texture = data.bkgImg ? await loadImage(data.bkgImg) : (base.disc?.canvas ?? null);
        bkgFrame = renderBackgroundFrame({
          bkg: texture, bkgColor: data.bkgColorOn ? data.bkgColor : null, bkgSize: data.bkgSize
        }, frame);
      }
      const {blob, ext, type} = await encodeSheet(composeSheetFrom(ringFrame, bkgFrame, frame));
      imageName = `sheet-${stamp}.${ext}`;
      await uploadFile(source, dir, new File([blob], imageName, {type}));
    }

    // Toggling the tint counts as a change; slider moves only count while the tint is on.
    const bandChanged = (data.tintOn !== initial.tintOn)
      || (data.tintOn && (!near(data.bandStart, initial.bandStart) || !near(data.bandEnd, initial.bandEnd)));
    const band = formBand(data);
    const json = patchRingsJson(base.json, {
      imageName,
      frame,
      ringThickness: near(data.ringThickness, initial.ringThickness) ? undefined : data.ringThickness,
      ringColor: (data.ringColor.toLowerCase() === initial.ringColor) ? undefined : data.ringColor,
      bandStart: bandChanged ? band.bandStart : undefined,
      bandEnd: bandChanged ? band.bandEnd : undefined
    });
    const jsonFile = new File([JSON.stringify(json, null, 2)], `rings-${stamp}.json`, {type: "application/json"});
    const spritesheet = await uploadFile(source, dir, jsonFile);

    const edits = getBuiltinEdits();
    edits.overrides[key] = {
      name: data.name,
      spritesheet,
      image: `${dirname(spritesheet)}/${imageName}`,
      ringImg: data.ringImg || null,
      bkgImg: data.bkgImg || null,
      bkgColor: data.bkgColorOn ? data.bkgColor : null,
      bkgSize: data.bkgSize,
      shadow,
      ringThickness: data.ringThickness,
      ringColor: data.ringColor,
      ...band,
      updated: Date.now()
    };
    await setBuiltinEdits(edits);
    return {name: data.name, key};
  }

  static async #onDelete(_event, target) {
    const presets = getPresets();
    const preset = presets[target.dataset.id];
    if ( !preset ) return;
    const key = worldKey(preset.id);
    const inUse = currentRingId() === key;
    const content = `<p>${esc(L("DeleteDlg.Content", {name: preset.name}))}</p>`
      + (inUse ? `<p>${esc(L("DeleteDlg.InUse"))}</p>` : "");
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: {title: L("DeleteDlg.Title")}, content, rejectClose: false
    });
    if ( !ok ) return;
    if ( inUse ) await game.settings.set("core", "dynamicTokenRing", coreDefaultRingId());
    if ( game.settings.get(MODULE_ID, "pending") === key ) await game.settings.set(MODULE_ID, "pending", "");
    delete presets[preset.id];
    await setPresets(presets);
    if ( this.editing?.id === preset.id ) this.editing = null;
    await this.render();
    if ( inUse ) await reloadWorld();
  }

  /** "Use in Tokenizer" / undo on the same button. */
  static async #onTokenizer(_event, target) {
    if ( this.busy ) return;
    const key = target.dataset.key;
    const io = tokenizerIO();
    this.busy = true;
    try {
      if ( target.dataset.undo ) await restoreTokenizers(io, key);
      else {
        const ring = this.#ringByKey(key);
        if ( ring ) await applyToTokenizers(ring, io);
      }
    } finally {
      this.busy = false;
    }
    await this.render();
  }

  /** {key, name, spritesheet} of a world preset or a (possibly edited) built-in. */
  #ringByKey(key) {
    const builtin = BUILTINS.find(b => b.key === key);
    if ( builtin ) {
      const ring = effectiveBuiltin(builtin, getBuiltinEdits());
      return {key, name: ring.label, spritesheet: ring.spritesheet};
    }
    const preset = Object.values(getPresets()).find(p => worldKey(p.id) === key);
    return preset ? {key, name: preset.name || key, spritesheet: preset.spritesheet} : null;
  }

  static async #onUse(_event, target) {
    await this.#useRing(target.dataset.key);
  }

  static async #onApplySelected() {
    const select = this.element.querySelector("select[name=currentRing]");
    if ( select?.value ) await this.#useRing(select.value);
  }

  static async #onUseDefault() {
    const id = coreDefaultRingId();
    if ( id ) await this.#useRing(id);
  }

  /** Point Foundry's core ring setting at a ring, then ask to reload. A preset saved this session is not registered until startup, so it is applied after the next reload. */
  async #useRing(key) {
    if ( !key ) return;
    const ids = registeredIds();
    if ( ids.includes(key) ) {
      if ( game.settings.get(MODULE_ID, "pending") ) await game.settings.set(MODULE_ID, "pending", "");
      if ( currentRingId() !== key ) await game.settings.set("core", "dynamicTokenRing", key);
      await this.render();
      return reloadWorld();
    }
    await game.settings.set(MODULE_ID, "pending", key);
    await this.render();
    return reloadWorld();
  }
}

/** Render the ring as a flat PNG frame and save it beside the module's other world files. */
async function makeTokenizerFrame(ring) {
  const json = await fetchJson(ring.spritesheet);
  if ( !json?.meta?.image ) throw new Error(`No meta.image in ${ring.spritesheet}`);
  const img = await loadImage(`${dirname(ring.spritesheet)}/${json.meta.image}`);
  const canvas = flatRingFrame(img, json, {size: 1024, fallbackBand: FOUNDRY_BAND});
  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
  if ( !blob ) throw new Error("Could not encode the frame.");
  const source = uploadSource();
  const root = `worlds/${game.world.id}/${MODULE_ID}`;
  const dir = `${root}/tokenizer`;
  await ensureDirectory(source, root);
  await ensureDirectory(source, dir);
  const name = `frame-${ring.key.replace(/[^\w-]/g, "_")}-${Date.now().toString(36)}.png`;
  const path = await uploadFile(source, dir, new File([blob], name, {type: "image/png"}));
  return {path, source};
}

/** What scripts/tokenizer.js needs from Foundry. */
function tokenizerIO() {
  return {
    isGM: !!game.user?.isGM,
    active: activeTokenizers(),
    settings: game.settings,
    systemId: game.system?.id,
    systemLabel: game.system?.title ?? game.system?.id ?? "",
    makeFrame: makeTokenizerFrame,
    notify: (level, key, data) => ui.notifications[level](L(key, data)),
    confirm: (name, lines) => foundry.applications.api.DialogV2.confirm({
      window: {title: L("Tokenizer.Use")},
      content: `<p>${esc(L("Tokenizer.Content", {name}))}</p><ul>${lines.map(l => `<li>${esc(L(l.key, l.data))}</li>`).join("")}</ul>`
        + `<p>${esc(L("Tokenizer.UndoNote"))}</p>`,
      rejectClose: false
    })
  };
}

let manager = null;

/** Open the window (GM only). */
export function openManager() {
  if ( !game.user?.isGM ) {
    ui.notifications.warn(L("Notify.GMOnly"));
    return null;
  }
  if ( !manager ) manager = new RingManager();
  manager.render({force: true});
  return manager;
}

/** After a reload, switch the core ring to a preset that was waiting for registration. */
export async function applyPending() {
  if ( !game.user?.isGM ) return;
  const activeGM = game.users?.activeGM;
  if ( activeGM && (activeGM !== game.user) ) return;
  const key = game.settings.get(MODULE_ID, "pending");
  if ( !key ) return;
  await game.settings.set(MODULE_ID, "pending", "");
  if ( !registeredIds().includes(key) ) {
    console.warn(`${MODULE_ID} | pending ring "${key}" is not registered; skipped`);
    return;
  }
  if ( currentRingId() === key ) return;
  await game.settings.set("core", "dynamicTokenRing", key);
  ui.notifications.info(L("Notify.Applied"));
  await reloadWorld();
}
