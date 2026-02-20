// Tiny HP Monitor for Foundry VTT
// Multi-system (auto-detect + configurable paths).

const MOD_ID = "tiny-hp-monitor";
const MAX_NAME_CHARS = 25;
const DEBOUNCE_MS = 350;

// -------------------------------
// State & Storage
// -------------------------------
const ITEM_UPDATE_STASH = new WeakMap();
const ITEM_DELETE_STASH = new WeakMap();

// Debounce Maps: Key = Document UUID
const ACTOR_DEBOUNCE = new Map();
const ITEM_DEBOUNCE = new Map();

// -------------------------------
// Utilities
// -------------------------------

function clipName(name) {
  const chars = Array.from(String(name ?? ""));
  if (chars.length <= MAX_NAME_CHARS) return chars.join("");
  return chars.slice(0, MAX_NAME_CHARS).join("") + "…";
}

function getActorLink(actor) {
  const token = actor.token || actor.getActiveTokens()[0];
  const rawName = token?.name || actor.name;
  const label = clipName(rawName);
  return `@UUID[${actor.uuid}]{${label}}`;
}

function getWorldBool(key, def = false) {
  try { return Boolean(game.settings.get(MOD_ID, key)); } catch { return def; }
}

function getWorldPath(key) {
  try {
    const v = game.settings.get(MOD_ID, key);
    return (typeof v === "string" && v.trim().length) ? v.trim() : null;
  } catch { return null; }
}

function detectSystemPaths(sampleActor) {
  const sys = game.system?.id || "";

  if (sys === "dnd5e") {
    return {
      hpPath: "system.attributes.hp.value",
      tempPath: "system.attributes.hp.temp",
      tempMaxPath: "system.attributes.hp.tempmax",
      damageSystem: false
    };
  }
  if (sys === "pf2e") return { hpPath: "system.attributes.hp.value", tempPath: "system.attributes.hp.temp", tempMaxPath: null, damageSystem: false };
  if (sys === "shadowdark") return { hpPath: "system.hp.value", tempPath: null, tempMaxPath: null, damageSystem: false };

  // Heuristic Probe
  const candidatesHP = ["system.attributes.hp.value", "system.hp.value", "system.health.value"];
  const candidatesTemp = ["system.attributes.hp.temp", "system.hp.temp"];
  const candidatesTempMax = ["system.attributes.hp.tempmax", "system.hp.tempmax"];

  const hpPath = candidatesHP.find(p => Number.isFinite(Number(foundry.utils.getProperty(sampleActor ?? {}, p)))) || null;
  const tempPath = candidatesTemp.find(p => Number.isFinite(Number(foundry.utils.getProperty(sampleActor ?? {}, p)))) || null;
  const tempMaxPath = candidatesTempMax.find(p => Number.isFinite(Number(foundry.utils.getProperty(sampleActor ?? {}, p)))) || null;

  return { hpPath, tempPath, tempMaxPath, damageSystem: false };
}

function resolvePaths(actor) {
  if (getWorldBool("autoDetectPaths", true)) return detectSystemPaths(actor);
  return {
    hpPath: getWorldPath("hpPath"),
    tempPath: getWorldPath("tempHpPath"),
    tempMaxPath: getWorldPath("tempHpMaxPath"),
    damageSystem: false
  };
}

function getDnd5eInspirationPath() { return "system.attributes.inspiration"; }
function getDnd5eDeathPaths() { return { successPath: "system.attributes.death.success", failurePath: "system.attributes.death.failure" }; }

function getDnd5eSpellSlotPaths() {
  const levels = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  return levels.map(lvl => ({ level: lvl, path: `system.spells.spell${lvl}.value` }));
}

function detectCurrencyInfo(actor) {
  const manualBase = getWorldPath("currencyBasePath");
  const sys = game.system.id;
  const candidates = manualBase ? [manualBase] : (sys === "pf2e" ? ["system.currencies", "system.currency"] : ["system.currency"]);

  let basePath = null, obj = null;
  for (const p of candidates) {
    const o = foundry.utils.getProperty(actor, p);
    if (o && typeof o === "object") { basePath = p; obj = o; break; }
  }
  if (!basePath) return { basePath: null, coins: [] };

  const all = ["pp", "gp", "ep", "sp", "cp"];
  const coins = all.filter(k => Object.prototype.hasOwnProperty.call(obj, k));
  return { basePath, coins };
}

function readNumber(doc, path) {
  if (!path) return 0;
  const v = foundry.utils.getProperty(doc, path);
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

function readRaw(doc, path) {
  if (!path) return undefined;
  return foundry.utils.getProperty(doc, path);
}

function willUpdatePath(update, path) {
  return path && foundry.utils.hasProperty(update, path);
}

function buildRecipients(actor) {
  const mode = game.settings.get(MOD_ID, "npcAudience") ?? "gm-owners";
  const gmUsers = game.users.filter(u => u.isGM);
  const owners = game.users.filter(u => actor.testUserPermission?.(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));

  const uniq = (...lists) => [...new Map(lists.flat().map(u => [u.id, u])).values()];

  if (actor.type === "npc") {
    if (mode === "gm") return gmUsers.map(u => u.id);
    if (mode === "gm-players") return uniq(gmUsers, game.users.filter(u => !u.isGM)).map(u => u.id);
  }
  return uniq(gmUsers, owners).map(u => u.id);
}

function coinLabel(denom, systemId) {
  const labels = {
    dnd5e: { pp: "Platinum", gp: "Gold", ep: "Electrum", sp: "Silver", cp: "Copper" },
    pf2e: { pp: "Platinum", gp: "Gold", sp: "Silver", cp: "Copper" }
  };
  return labels[systemId]?.[denom] ?? denom.toUpperCase();
}

/**
 * Helper to post the chat message
 */
async function postMonitorMessage(actor, line, cls, kind, isMultiline = false) {
  const whisper = buildRecipients(actor);
  const cssLine = isMultiline ? "tiny-monitor-line tm-multiline" : "tiny-monitor-line";

  await ChatMessage.create({
    content: `<div class="${cssLine}">${line}</div>`,
    whisper,
    flags: { [MOD_ID]: { isMonitorMsg: true, kind, cls } }
  });
}

function buildMonitorLine(actor, icon, text) {
  return `${icon}<span class="tm-actor">${getActorLink(actor)}</span><span class="tm-text">${text}</span>`;
}

// DnD5e Spell Prep Logic
function dnd5eIsSpellPreparedLike(item) {
  const method = String(readRaw(item, "system.method") ?? "");
  const preparedVal = readRaw(item, "system.prepared");
  const prepared = typeof preparedVal === "boolean" ? preparedVal : Boolean(preparedVal);

  if (method === "prepared") return prepared;
  if (method === "always") return true;
  if (!method && typeof preparedVal !== "undefined") return prepared;
  return false;
}

function computePreparedAfter(item, change) {
  const has = (p) => foundry.utils.hasProperty(change, p);
  const get = (p) => foundry.utils.getProperty(change, p);

  let methodGiven = has("system.method") ? String(get("system.method")) : (has("system.preparation.mode") ? String(get("system.preparation.mode")) : undefined);
  let preparedGiven = has("system.prepared") ? Boolean(get("system.prepared")) : (has("system.preparation.prepared") ? Boolean(get("system.preparation.prepared")) : undefined);

  if (preparedGiven !== undefined && methodGiven === undefined) methodGiven = "prepared";

  if (methodGiven !== undefined) {
    if (methodGiven === "always") return true;
    if (methodGiven === "prepared") {
      return preparedGiven !== undefined ? preparedGiven : Boolean(readRaw(item, "system.prepared"));
    }
    return false;
  }
  return dnd5eIsSpellPreparedLike(item);
}

// -------------------------------
// Settings
// -------------------------------

Hooks.once("init", () => {
  // -------------------------------------------------------------------
  // 1. General Settings
  // -------------------------------------------------------------------

  game.settings.register(MOD_ID, "simpleOutput", {
    name: "Simplified Output",
    hint: "If enabled, logs will only show the adjustment amount (e.g., '+5') instead of the full transition (e.g., '10 + 5 -> 15'). This provides a cleaner, less verbose chat log.",
    scope: "world", config: true, type: Boolean, default: false
  });

  game.settings.register(MOD_ID, "npcAudience", {
    name: "NPC Message Audience",
    hint: "Determines which users receive chat messages for changes to NPC actors. 'GM only' is private, while 'GM + all players' shares all NPC changes publicly.",
    scope: "world", config: true, type: String,
    choices: { "gm": "GM only", "gm-players": "GM + all players", "gm-owners": "GM + owners (default)" },
    default: "gm-owners"
  });

  game.settings.register(MOD_ID, "trackCurrency", {
    name: "Track Currency",
    hint: "If enabled, the module will monitor and log changes to actor currency (Gold, Silver, Platinum, etc.).",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MOD_ID, "trackItemChanges", {
    name: "Track Item Changes",
    hint: "If enabled, the module will monitor and log changes to items, including quantity updates, additions, deletions, and renaming.",
    scope: "world", config: true, type: Boolean, default: true
  });

  // -------------------------------------------------------------------
  // 2. DnD5e Specific Settings
  // -------------------------------------------------------------------

  game.settings.register(MOD_ID, "trackDnd5eInspiration", {
    name: "Track Inspiration (DnD5e)",
    hint: "If enabled, logs when a DnD5e character gains or uses Heroic Inspiration.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MOD_ID, "trackDnd5eDeathSaves", {
    name: "Track Death Saves (DnD5e PCs)",
    hint: "If enabled, logs successes and failures for Death Saving Throws on DnD5e characters.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MOD_ID, "trackDnd5eSpellPrep", {
    name: "Track Spell Preparation (DnD5e)",
    hint: "If enabled, logs when spells are prepared or unprepared on DnD5e characters.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MOD_ID, "trackDnd5eSpellSlots", {
    name: "Track Spell Slots (DnD5e)",
    hint: "If enabled, logs when DnD5e spell slots are expended or regained.",
    scope: "world", config: true, type: Boolean, default: true
  });

  // -------------------------------------------------------------------
  // 3. Advanced / Manual Path Configuration
  // -------------------------------------------------------------------

  game.settings.register(MOD_ID, "autoDetectPaths", {
    name: "Auto-Detect HP Paths",
    hint: "If enabled, the module attempts to automatically determine the correct data paths for HP and other attributes based on the active system. Disable this to manually configure paths below.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MOD_ID, "hpPath", {
    name: "HP Value Path",
    hint: "Manual System Data Path for HP Value (e.g., 'system.attributes.hp.value'). Only used if Auto-Detect HP Paths is disabled or fails.",
    scope: "world", config: true, type: String, default: ""
  });

  game.settings.register(MOD_ID, "tempHpPath", {
    name: "Temp HP Path",
    hint: "Manual System Data Path for Temporary HP (e.g., 'system.attributes.hp.temp'). Only used if Auto-Detect HP Paths is disabled or fails.",
    scope: "world", config: true, type: String, default: ""
  });

  game.settings.register(MOD_ID, "tempHpMaxPath", {
    name: "Temp HP Max Path",
    hint: "Manual System Data Path for Temporary HP Max (e.g., 'system.attributes.hp.tempmax'). Only used if Auto-Detect HP Paths is disabled or fails.",
    scope: "world", config: true, type: String, default: ""
  });

  game.settings.register(MOD_ID, "currencyBasePath", {
    name: "Currency Base Path (Adv)",
    hint: "Manual System Data Path for Currency (e.g., 'system.currency'). Use this to override the default detection if needed.",
    scope: "world", config: true, type: String, default: ""
  });

  console.log(`[${MOD_ID}] Initialized.`);
});

Hooks.once("ready", () => {
  const sample = game.actors?.contents?.[0];
  if (sample) resolvePaths(sample);
});

// -------------------------------
// Actor Updates (Pre-Update Stash)
// -------------------------------

Hooks.on("preUpdateActor", (actor, update, options, userId) => {
  const { hpPath, tempPath, tempMaxPath } = resolvePaths(actor);
  const sys = game.system.id;

  const willHP = willUpdatePath(update, hpPath);
  const willTHP = willUpdatePath(update, tempPath);
  const willTHPMax = willUpdatePath(update, tempMaxPath);

  const inspPath = (sys === "dnd5e" && getWorldBool("trackDnd5eInspiration")) ? getDnd5eInspirationPath() : null;
  const willInsp = inspPath ? willUpdatePath(update, inspPath) : false;

  let currencyPayload = null;
  if (getWorldBool("trackCurrency") && (sys === "dnd5e" || sys === "pf2e")) {
    const { basePath, coins } = detectCurrencyInfo(actor);
    if (basePath && coins.length && (willUpdatePath(update, basePath) || coins.some(k => willUpdatePath(update, `${basePath}.${k}`)))) {
      currencyPayload = { basePath, coins };
    }
  }

  let deathPayload = null;
  if (sys === "dnd5e" && getWorldBool("trackDnd5eDeathSaves") && actor.type === "character") {
    const { successPath, failurePath } = getDnd5eDeathPaths();
    if (willUpdatePath(update, successPath) || willUpdatePath(update, failurePath)) {
      deathPayload = { oldSucc: readNumber(actor, successPath), oldFail: readNumber(actor, failurePath) };
    }
  }

  let spellSlotsPayload = null;
  if (sys === "dnd5e" && getWorldBool("trackDnd5eSpellSlots", true)) {
    const slotPaths = getDnd5eSpellSlotPaths();
    const changedSlots = slotPaths.filter(s => willUpdatePath(update, s.path));
    if (changedSlots.length > 0) {
      spellSlotsPayload = changedSlots.map(s => ({ level: s.level, path: s.path, oldValue: readNumber(actor, s.path) }));
    }
  }

  if (!willHP && !willTHP && !willTHPMax && !willInsp && !currencyPayload && !deathPayload && !spellSlotsPayload) return;

  // Stash in options for the updateActor hook to pick up
  options[MOD_ID] = {
    oldHP: willHP ? readNumber(actor, hpPath) : undefined,
    oldTHP: willTHP ? readNumber(actor, tempPath) : undefined,
    oldTHPMax: willTHPMax ? readNumber(actor, tempMaxPath) : undefined,
    oldInspiration: willInsp ? Boolean(readRaw(actor, inspPath)) : undefined,
    currency: currencyPayload ? { ...currencyPayload, old: Object.fromEntries(currencyPayload.coins.map(k => [k, readNumber(actor, `${currencyPayload.basePath}.${k}`)])) } : undefined,
    deathSaves: deathPayload,
    spellSlots: spellSlotsPayload
  };
});

// -------------------------------
// Actor Updates (Debounced Processing)
// -------------------------------

Hooks.on("updateActor", (actor, update, options, userId) => {
  if (userId !== game.userId || !options?.[MOD_ID]) return;
  const payload = options[MOD_ID];
  const uuid = actor.uuid;

  // Retrieve or create pending debounce state
  const pending = ACTOR_DEBOUNCE.get(uuid) ?? {
    oldHP: undefined,
    oldTHP: undefined,
    oldTHPMax: undefined,
    oldInspiration: undefined,
    currencyOld: {},
    deathSavesOld: undefined,
    spellSlotsOld: {},
    timer: null
  };

  // Clear existing timer (resetting the clock)
  if (pending.timer) clearTimeout(pending.timer);

  // MERGE LOGIC: Keep the *original* old value if we already have one.
  if (pending.oldHP === undefined) pending.oldHP = payload.oldHP;
  if (pending.oldTHP === undefined) pending.oldTHP = payload.oldTHP;
  if (pending.oldTHPMax === undefined) pending.oldTHPMax = payload.oldTHPMax;
  if (pending.oldInspiration === undefined) pending.oldInspiration = payload.oldInspiration;

  if (payload.currency) {
    pending.currencyBase = payload.currency.basePath;
    pending.currencyCoins = payload.currency.coins;
    for (const k of payload.currency.coins) {
      if (pending.currencyOld[k] === undefined && payload.currency.old[k] !== undefined) {
        pending.currencyOld[k] = payload.currency.old[k];
      }
    }
  }

  if (payload.deathSaves && pending.deathSavesOld === undefined) {
    pending.deathSavesOld = payload.deathSaves;
  }

  if (payload.spellSlots) {
    for (const slot of payload.spellSlots) {
      if (pending.spellSlotsOld[slot.level] === undefined) {
        pending.spellSlotsOld[slot.level] = { level: slot.level, path: slot.path, oldValue: slot.oldValue };
      }
    }
  }

  // Set new timer
  pending.timer = setTimeout(() => {
    processActorUpdate(actor, pending);
    ACTOR_DEBOUNCE.delete(uuid);
  }, DEBOUNCE_MS);

  ACTOR_DEBOUNCE.set(uuid, pending);
});

async function processActorUpdate(actor, data) {
  const { hpPath, tempPath, tempMaxPath, damageSystem } = resolvePaths(actor);

  // HP
  if (data.oldHP !== undefined && hpPath) {
    const newHP = readNumber(actor, hpPath);
    const delta = newHP - data.oldHP;
    if (delta !== 0) {
      const cls = (damageSystem ? delta < 0 : delta > 0) ? "tiny-monitor-gain" : "tiny-monitor-loss";
      const icon = `<i class="fa-solid fa-heart"></i>`;
      const sign = delta > 0 ? "+" : "-";
      const abs = Math.abs(delta);
      const isSimple = getWorldBool("simpleOutput");

      const text = isSimple
        ? `${damageSystem ? "Damage" : "HP"}: ${sign} ${abs}`
        : `${damageSystem ? "Damage" : "HP"}: ${data.oldHP} ${sign} ${abs} → ${newHP}`;

      const line = buildMonitorLine(actor, icon, text);
      await postMonitorMessage(actor, line, cls, "hp");
    }
  }

  // Temp HP
  if (data.oldTHP !== undefined && tempPath) {
    const newTHP = readNumber(actor, tempPath);
    const delta = newTHP - data.oldTHP;
    if (delta !== 0) {
      const icon = `<i class="fa-solid fa-shield-halved"></i>`;
      const sign = delta > 0 ? "+" : "-";
      const abs = Math.abs(delta);
      const isSimple = getWorldBool("simpleOutput");

      const text = isSimple
        ? `Temp: ${sign} ${abs}`
        : `Temp: ${data.oldTHP} ${sign} ${abs} → ${newTHP}`;

      const line = buildMonitorLine(actor, icon, text);
      await postMonitorMessage(actor, line, "tiny-monitor-temp", "temp");
    }
  }

  // Temp Max HP
  if (data.oldTHPMax !== undefined && tempMaxPath) {
    const newTHPMax = readNumber(actor, tempMaxPath);
    const delta = newTHPMax - data.oldTHPMax;
    if (delta !== 0) {
      const icon = `<i class="fa-solid fa-circle-plus"></i>`;
      const sign = delta > 0 ? "+" : "-";
      const abs = Math.abs(delta);
      const isSimple = getWorldBool("simpleOutput");

      const text = isSimple
        ? `Temp Max: ${sign} ${abs}`
        : `Temp Max: ${data.oldTHPMax} ${sign} ${abs} → ${newTHPMax}`;

      const line = buildMonitorLine(actor, icon, text);
      await postMonitorMessage(actor, line, "tiny-monitor-tempmax", "tempmax");
    }
  }

  // Inspiration
  if (data.oldInspiration !== undefined && game.system.id === "dnd5e") {
    const newInsp = Boolean(readRaw(actor, getDnd5eInspirationPath()));
    if (newInsp !== data.oldInspiration) {
      const icon = `<i class="fa-solid fa-dice-d20"></i>`;
      const line = buildMonitorLine(actor, icon, `${newInsp ? "gained" : "spent"} Heroic Inspiration`);
      await postMonitorMessage(actor, line, "tiny-monitor-inspiration", "inspiration");
    }
  }

  // Currency
  if (data.currencyBase) {
    for (const k of data.currencyCoins) {
      const oldVal = data.currencyOld[k] ?? 0;
      const newVal = readNumber(actor, `${data.currencyBase}.${k}`);
      const delta = newVal - oldVal;
      if (delta !== 0) {
        const icon = `<i class="fa-solid fa-coins"></i>`;
        const sign = delta > 0 ? "+" : "-";
        const abs = Math.abs(delta);
        const name = coinLabel(k, game.system.id);
        const isSimple = getWorldBool("simpleOutput");

        const text = isSimple
          ? `${name}: ${sign} ${abs}`
          : `${name}: ${oldVal} ${sign} ${abs} → ${newVal}`;

        const line = buildMonitorLine(actor, icon, text);
        const cls = delta > 0 ? "tiny-monitor-currency-gain" : "tiny-monitor-currency-loss";
        await postMonitorMessage(actor, line, cls, "currency");
      }
    }
  }

  // Death Saves
  if (data.deathSavesOld) {
    const { successPath, failurePath } = getDnd5eDeathPaths();
    const newSucc = readNumber(actor, successPath);
    const newFail = readNumber(actor, failurePath);
    const oldSucc = Number(data.deathSavesOld.oldSucc ?? 0);
    const oldFail = Number(data.deathSavesOld.oldFail ?? 0);

    // Track successes separately
    if (newSucc !== oldSucc) {
      const delta = newSucc - oldSucc;
      const icon = `<i class="fa-solid fa-heart-pulse"></i>`;

      if (delta > 0) {
        // Gained success(es)
        const line = buildMonitorLine(actor, icon, `gained ${delta} Death Save ${delta === 1 ? 'Success' : 'Successes'} (${newSucc}/3)`);
        await postMonitorMessage(actor, line, "tiny-monitor-gain", "deathsave");
      } else {
        // Lost success(es) or reset
        const absDelta = Math.abs(delta);
        const line = buildMonitorLine(actor, icon, `lost ${absDelta} Death Save ${absDelta === 1 ? 'Success' : 'Successes'} (${newSucc}/3)`);
        await postMonitorMessage(actor, line, "tiny-monitor-loss", "deathsave");
      }
    }

    // Track failures separately
    if (newFail !== oldFail) {
      const delta = newFail - oldFail;
      const icon = `<i class="fa-solid fa-skull"></i>`;

      if (delta > 0) {
        // Gained failure(s)
        const line = buildMonitorLine(actor, icon, `gained ${delta} Death Save ${delta === 1 ? 'Failure' : 'Failures'} (${newFail}/3)`);
        await postMonitorMessage(actor, line, "tiny-monitor-loss", "deathsave");
      } else {
        // Lost failure(s) or reset (good thing!)
        const absDelta = Math.abs(delta);
        const line = buildMonitorLine(actor, icon, `lost ${absDelta} Death Save ${absDelta === 1 ? 'Failure' : 'Failures'} (${newFail}/3)`);
        await postMonitorMessage(actor, line, "tiny-monitor-gain", "deathsave");
      }
    }
  }

  // Spell Slots
  if (data.spellSlotsOld && Object.keys(data.spellSlotsOld).length > 0) {
    // Sort by level for consistent display
    const sortedLevels = Object.keys(data.spellSlotsOld).sort((a, b) => Number(a) - Number(b));

    for (const level of sortedLevels) {
      const slotData = data.spellSlotsOld[level];
      const newVal = readNumber(actor, slotData.path);
      const oldVal = slotData.oldValue;
      const delta = newVal - oldVal;

      if (delta !== 0) {
        const icon = `<i class="fa-solid fa-hat-wizard"></i>`;
        const action = delta < 0 ? "expended" : "regained";
        const cls = delta < 0 ? "tiny-monitor-spellslot-expend" : "tiny-monitor-spellslot-regain";
        const absDelta = Math.abs(delta);
        const slotWord = absDelta === 1 ? "slot" : "slots";
        const quantityStr = absDelta > 1 ? `${absDelta} ` : "";
        const line = buildMonitorLine(actor, icon, `${action} ${quantityStr}level ${level} ${slotWord}`);
        await postMonitorMessage(actor, line, cls, "spellslot");
      }
    }
  }
}

// -------------------------------
// Item Updates (Debounced)
// -------------------------------

Hooks.on("createItem", async (item, options, userId) => {
  if (userId !== game.userId || !getWorldBool("trackItemChanges")) return;
  if (!(item.parent instanceof Actor)) return;

  const qty = readNumber(item, "system.quantity") || 1;
  const safeItemName = clipName(item.name);
  const icon = `<i class="fa-solid fa-backpack"></i>`;

  const isSimple = getWorldBool("simpleOutput");

  let line;
  if (qty === 1 || isSimple) {
    line = buildMonitorLine(item.parent, icon, `added ${safeItemName}${qty > 1 ? ` (+${qty})` : ""}`);
  } else {
    // Verbose existing behavior for initial quantity > 1
    line = buildMonitorLine(item.parent, icon, `(${safeItemName}): 0 + ${qty} → ${qty}`);
  }

  await postMonitorMessage(item.parent, line, "tiny-monitor-item-inc", "item", true);
});

Hooks.on("preUpdateItem", (item, change, options, userId) => {
  if (!(item.parent instanceof Actor)) return;
  const trackItems = getWorldBool("trackItemChanges");
  const willQty = trackItems && willUpdatePath(change, "system.quantity");
  const willName = trackItems && willUpdatePath(change, "name");

  if (willQty || willName) {
    ITEM_UPDATE_STASH.set(item, {
      oldQty: willQty ? (readNumber(item, "system.quantity") || 0) : undefined,
      oldName: willName ? String(item.name ?? "") : undefined
    });
  }
});

Hooks.on("updateItem", (item, change, options, userId) => {
  if (userId !== game.userId || !(item.parent instanceof Actor)) return;

  // Spell Prep
  if (game.system.id === "dnd5e" && getWorldBool("trackDnd5eSpellPrep", true) && item.type === "spell") {
    if (willUpdatePath(change, "system.prepared") || willUpdatePath(change, "system.preparation.prepared") || willUpdatePath(change, "system.method") || willUpdatePath(change, "system.preparation.mode")) {
      const prepared = computePreparedAfter(item, change);
      const level = readNumber(item, "system.level");
      const icon = `<i class="fa-solid fa-book"></i>`;
      const line = buildMonitorLine(item.parent, icon, `${prepared ? "prepared" : "unprepared"}: ${clipName(item.name)}${Number.isFinite(level) ? ` (Lv ${level})` : ""}`);
      postMonitorMessage(item.parent, line, "tiny-monitor-spellprep", "spellprep", true);
    }
  }

  // Debounce Quantity/Name changes
  const stash = ITEM_UPDATE_STASH.get(item);
  ITEM_UPDATE_STASH.delete(item);

  if (stash) {
    const uuid = item.uuid;
    const pending = ITEM_DEBOUNCE.get(uuid) ?? { oldQty: undefined, oldName: undefined, timer: null };

    if (pending.timer) clearTimeout(pending.timer);

    if (pending.oldQty === undefined) pending.oldQty = stash.oldQty;
    if (pending.oldName === undefined) pending.oldName = stash.oldName;

    pending.timer = setTimeout(() => {
      processItemUpdate(item, pending);
      ITEM_DEBOUNCE.delete(uuid);
    }, DEBOUNCE_MS);

    ITEM_DEBOUNCE.set(uuid, pending);
  }
});

async function processItemUpdate(item, data) {
  if (!item.parent) return;

  const icon = `<i class="fa-solid fa-backpack"></i>`;

  // Quantity
  if (data.oldQty !== undefined) {
    const oldQty = data.oldQty;
    const newQty = readNumber(item, "system.quantity") || 0;

    if (newQty !== oldQty) {
      const safeItemName = clipName(item.name);

      const delta = newQty - oldQty;
      const sign = delta > 0 ? "+" : "-";
      const abs = Math.abs(delta);
      const isSimple = getWorldBool("simpleOutput");

      if (oldQty === 0 && newQty === 1) {
        // Treated as pure addition
        await postMonitorMessage(item.parent, buildMonitorLine(item.parent, icon, `added ${safeItemName}`), "tiny-monitor-item-inc", "item", true);
      }
      else if (oldQty === 1 && newQty === 0) {
        // Treated as pure deletion
        await postMonitorMessage(item.parent, buildMonitorLine(item.parent, icon, `deleted ${safeItemName}`), "tiny-monitor-item-dec", "item", true);
      }
      else {
        // Quantity adjustment
        const text = isSimple
          ? `${sign} ${abs}`
          : `${oldQty} ${sign} ${abs} → ${newQty}`;

        const line = buildMonitorLine(item.parent, icon, `${safeItemName}: ${text}`);
        await postMonitorMessage(item.parent, line, delta > 0 ? "tiny-monitor-item-inc" : "tiny-monitor-item-dec", "item", true);
      }
    }
  }

  // Rename
  if (data.oldName !== undefined && item.name !== data.oldName) {
    const line = buildMonitorLine(item.parent, icon, `Item: ${clipName(data.oldName)} → ${clipName(item.name)}`);
    await postMonitorMessage(item.parent, line, "tiny-monitor-item", "item", true);
  }
}

// -------------------------------
// Delete Item (No Debounce necessary)
// -------------------------------

Hooks.on("preDeleteItem", (item, options, userId) => {
  if (!getWorldBool("trackItemChanges")) return;
  if (!(item.parent instanceof Actor)) return;

  ITEM_DELETE_STASH.set(item, {
    actor: item.parent,
    whisper: buildRecipients(item.parent),
    name: clipName(item.name),
    qty: readNumber(item, "system.quantity"),
    hasQty: foundry.utils.hasProperty(item, "system.quantity")
  });
});

Hooks.on("deleteItem", async (item, options, userId) => {
  if (userId !== game.userId || !getWorldBool("trackItemChanges")) return;
  const payload = ITEM_DELETE_STASH.get(item);
  ITEM_DELETE_STASH.delete(item);
  if (!payload) return;

  const { hasQty, qty, actor, whisper, name } = payload;
  const oldQty = Number(qty ?? 0);

  // Suppress deletion message if item tracks quantity but was already 0
  if (hasQty && oldQty === 0) return;

  const treatAsSingleton = !hasQty || oldQty <= 1;
  const icon = `<i class="fa-solid fa-backpack"></i>`;

  const line = (treatAsSingleton || getWorldBool("simpleOutput"))
    ? buildMonitorLine(actor, icon, `deleted ${name}`)
    : buildMonitorLine(actor, icon, `${name}: ${oldQty} - ${oldQty} → 0`);

  await ChatMessage.create({
    content: `<div class="tiny-monitor-line tm-multiline">${line}</div>`,
    whisper,
    flags: { [MOD_ID]: { isMonitorMsg: true, kind: "item", cls: "tiny-monitor-item-dec" } }
  });
});

Hooks.on("renderChatMessage", (message, html) => {
  if (!message.getFlag(MOD_ID, "isMonitorMsg")) return;
  const li = html[0]?.closest(".chat-message");
  if (li) {
    li.classList.add("tiny-monitor-msg");
    const cls = message.getFlag(MOD_ID, "cls");
    if (cls) li.classList.add(cls);
  }
});
