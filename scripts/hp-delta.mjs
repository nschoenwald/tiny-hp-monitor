// Tiny HP Monitor for Foundry VTT v13
// Multi-system (auto-detect + configurable paths). Tested with dnd5e 5.1+.
// - Watches HP value, Temp HP, Temp Max HP changes (if present in the system).
// - Optional DnD5e Inspiration tracking (world setting; default OFF).
// - Optional DnD5e Death Save tracking (world setting; default OFF; PCs only).
// - Optional currency tracking for DnD5e and PF2E (world setting; default OFF).
// - Optional item tracking (create/delete/quantity/name changes; default OFF).
// - Optional DnD5e spell preparation tracking (prepared/unprepared; default OFF).
// - Posts compact chat entries with colored background:
//   green (HP gain & Death Save success), red (HP loss & Death Save failure), blue (Temp HP), purple (Temp Max HP),
//   orange-gold (Inspiration), dark green (Currency & Item changes), dark blue (Spell preparation).
// - Visibility: NPC => configurable (GM only / GM+all players / GM+owners); Characters => GM + owning users.

const MOD_ID = "tiny-hp-monitor";
const MAX_NAME_CHARS = 25;

// -------------------------------
// Ephemeral per-document stashes (fix for batched item ops)
// -------------------------------
// In batched embedded document operations (e.g., level up, class import, character creation),
// Foundry passes the SAME context/options object to every preUpdate/update call in the batch.
// Stashing "old" values inside `options` causes cross-talk between items.
// We use WeakMaps keyed by the Item document to isolate per-item state safely.
const ITEM_UPDATE_STASH = new WeakMap(); // item => { oldQty?: number, oldName?: string }
const ITEM_DELETE_STASH = new WeakMap(); // item => { displayName, whisper, name, qty, actorId }

// -------------------------------
// Utilities
// -------------------------------

function clipName(name) {
  const chars = Array.from(String(name ?? ""));
  if (chars.length <= MAX_NAME_CHARS) return chars.join("");
  return chars.slice(0, MAX_NAME_CHARS).join("") + "[...]";
}

function getWorldBool(key, def = false) {
  try { return Boolean(game.settings.get(MOD_ID, key)); } catch { return def; }
}

function getWorldPath(key) {
  try {
    const v = game.settings.get(MOD_ID, key);
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s.length ? s : null;
  } catch { return null; }
}

function detectSystemPaths(sampleActor) {
  const sys = (game.system && game.system.id) || "";
  if (sys === "demonlord") {
    return {
      hpPath: "system.characteristics.health.value",
      tempPath: null,
      tempMaxPath: "system.characteristics.health.max",
      damageSystem: true
    };
  }  
  if (sys === "dnd5e") {
    return {
      hpPath: "system.attributes.hp.value",
      tempPath: "system.attributes.hp.temp",
      tempMaxPath: "system.attributes.hp.tempmax",
      damageSystem: false
    };
  }
  if (sys === "pf2e") {
    return {
      hpPath: "system.attributes.hp.value",
      tempPath: "system.attributes.hp.temp",
      tempMaxPath: null,
      damageSystem: false
    };
  }
  if (sys === "shadowdark") {
    return {
      hpPath: "system.hp.value",
      tempPath: null,
      tempMaxPath: null,
      damageSystem: false      
    };
  }

  const candidatesHP = [
    "system.attributes.hp.value",
    "system.hp.value",
    "system.health.value",
    "system.attributes.health.value",
    "system.resources.hp.value",
    "system.vitals.hp.value"
  ];
  const candidatesTemp = [
    "system.attributes.hp.temp",
    "system.hp.temp",
    "system.health.temp"
  ];
  const candidatesTempMax = [
    "system.attributes.hp.tempmax",
    "system.hp.tempmax",
    "system.health.tempmax"
  ];

  const hpPath = candidatesHP.find(p => Number.isFinite(Number(foundry.utils.getProperty(sampleActor ?? {}, p)))) || null;
  const tempPath = candidatesTemp.find(p => Number.isFinite(Number(foundry.utils.getProperty(sampleActor ?? {}, p)))) || null;
  const tempMaxPath = candidatesTempMax.find(p => Number.isFinite(Number(foundry.utils.getProperty(sampleActor ?? {}, p)))) || null;
  const damageSystem = false;

  return { hpPath, tempPath, tempMaxPath, damageSystem };
}

function resolvePaths(actor) {
  const auto = getWorldBool("autoDetectPaths", true);
  if (auto) return detectSystemPaths(actor);
  return {
    hpPath: getWorldPath("hpPath"),
    tempPath: getWorldPath("tempHpPath"),
    tempMaxPath: getWorldPath("tempHpMaxPath"),
    damageSystem: false
  };
}

function getDnd5eInspirationPath() {
  return "system.attributes.inspiration";
}

// DnD5e 5.1+: canonical death save counters on the actor
function getDnd5eDeathPaths() {
  return {
    successPath: "system.attributes.death.success",
    failurePath: "system.attributes.death.failure"
  };
}

function detectCurrencyInfo(actor) {
  const sys = (game.system && game.system.id) || "";
  const manualBase = getWorldPath("currencyBasePath");

  const candidates =
    manualBase ? [manualBase] :
    sys === "dnd5e" ? ["system.currency"] :
    sys === "pf2e" ? [
      "system.currencies",
      "system.currency",
      "system.wealth.treasure.currencies",
      "system.wealth.currency",
      "system.treasure.currency"
    ] :
    [
      "system.currency",
      "system.currencies",
      "system.wealth.currency",
      "system.treasure.currency"
    ];

  let basePath = null;
  let obj = null;
  for (const p of candidates) {
    const o = foundry.utils.getProperty(actor, p);
    if (o && typeof o === "object") { basePath = p; obj = o; break; }
  }
  if (!basePath) return { basePath: null, coins: [] };

  const all = ["pp", "gp", "ep", "sp", "cp"];
  const present = all.filter(k => Object.prototype.hasOwnProperty.call(obj, k));
  return { basePath, coins: present };
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
  if (!path) return false;
  return foundry.utils.hasProperty(update, path);
}

function getDisplayName(actor) {
  let tokenName = actor.name;
  if (actor.isToken && actor.token) {
    tokenName = actor.token.name || tokenName;
  } else {
    const active = actor.getActiveTokens();
    if (active?.length) tokenName = active[0].name || tokenName;
  }
  return clipName(tokenName);
}

function buildRecipients(actor) {
  const gmUsers = game.users.filter(u => u.isGM);
  const owners = game.users.filter(u => actor.testUserPermission?.(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
  const uniq = (...lists) => [...new Map(lists.flat().map(u => [u.id, u])).values()];
  const mode = game.settings.get(MOD_ID, "npcAudience") ?? "gm-owners";

  let recipients;
  if (actor.type === "npc") {
    if (mode === "gm") {
      recipients = gmUsers;
    } else if (mode === "gm-players") {
      const players = game.users.filter(u => !u.isGM);
      recipients = uniq(gmUsers, players);
    } else {
      recipients = uniq(gmUsers, owners);
    }
  } else {
    recipients = uniq(gmUsers, owners);
  }
  if (!recipients?.length) recipients = gmUsers;
  return recipients.map(u => u.id);
}

function coinLabel(denom, systemId) {
  const labels = {
    dnd5e: { pp: "Platinum", gp: "Gold", ep: "Electrum", sp: "Silver", cp: "Copper" },
    pf2e:  { pp: "Platinum", gp: "Gold",              sp: "Silver", cp: "Copper" }
  };
  const map = systemId === "pf2e" ? labels.pf2e : labels.dnd5e;
  return map[denom] ?? denom.toUpperCase();
}

/**
 * DnD5e 5.1+: determine whether a spell is effectively "prepared".
 * Uses system.method and system.prepared (replacement for deprecated preparation.*).
 * - method "prepared" => uses boolean prepared flag
 * - method "always"   => always prepared
 * - other methods     => treated as not prepared for this feature
 * Fallback: if method is missing but prepared is a boolean, use prepared.
 */
function dnd5eIsSpellPreparedLike(item) {
  const method = String(readRaw(item, "system.method") ?? "");
  const preparedVal = readRaw(item, "system.prepared");
  const prepared = typeof preparedVal === "boolean" ? preparedVal : Boolean(preparedVal);

  if (method === "prepared") return prepared;
  if (method === "always") return true;

  // Conservative fallback: if method missing/unknown but a truthy prepared is present, respect it
  if (!method && typeof preparedVal !== "undefined") return prepared;

  return false;
}

/**
 * Compute the "new" prepared state from the change delta, without reading deprecated fields.
 * - Prefers explicit booleans in change.system.prepared
 * - Falls back to legacy delta keys (change.system.preparation.prepared/mode) without touching the live deprecated getters
 * - If only "method" changed, uses post-update item.system.method/system.prepared
 */
function computePreparedAfter(item, change) {
  const has = (p) => foundry.utils.hasProperty(change, p);
  const get = (p) => foundry.utils.getProperty(change, p);

  // Read method from delta (new first, then legacy), track presence separately from value
  let methodGiven;
  if (has("system.method")) methodGiven = String(get("system.method"));
  else if (has("system.preparation.mode")) methodGiven = String(get("system.preparation.mode"));

  // Read prepared from delta (new first, then legacy), track presence and coerce to boolean
  let preparedGivenPresent = false;
  let preparedGiven = false;
  if (has("system.prepared")) {
    preparedGivenPresent = true;
    preparedGiven = Boolean(get("system.prepared"));
  } else if (has("system.preparation.prepared")) {
    preparedGivenPresent = true;
    preparedGiven = Boolean(get("system.preparation.prepared"));
  }

  // If only prepared was toggled, the sheet typically doesn't include method; assume "prepared"
  if (preparedGivenPresent && methodGiven === undefined) methodGiven = "prepared";

  // If method is present in the delta, decide from delta (falling back to the updated doc only if necessary)
  if (methodGiven !== undefined) {
    if (methodGiven === "always") return true;
    if (methodGiven === "prepared") {
      if (preparedGivenPresent) return preparedGiven;
      const afterPreparedVal = readRaw(item, "system.prepared");
      return typeof afterPreparedVal === "boolean" ? afterPreparedVal : Boolean(afterPreparedVal);
    }
    return false;
  }

  return dnd5eIsSpellPreparedLike(item);
}

// -------------------------------
// Settings
// -------------------------------

Hooks.once("init", () => {
  game.settings.register(MOD_ID, "npcAudience", {
    name: "NPC Message Audience",
    hint: "Who sees NPC health changes?",
    scope: "world",
    config: true,
    type: String,
    choices: {
      "gm": "GM only",
      "gm-players": "GM + all players",
      "gm-owners": "GM + owners (default)"
    },
    default: "gm-owners"
  });

  game.settings.register(MOD_ID, "autoDetectPaths", {
    name: "Auto-Detect HP Paths",
    hint: "When enabled, auto-detect HP / Temp HP paths for this system (dnd5e, pf2e, shadowdark supported) or probe common paths for others.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MOD_ID, "hpPath", {
    name: "HP Value Path",
    hint: "Dot path to current HP (e.g., system.attributes.hp.value). Leave blank if not used or relying on Auto-Detect.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register(MOD_ID, "tempHpPath", {
    name: "Temp HP Path",
    hint: "Dot path to temporary HP (e.g., system.attributes.hp.temp). Leave blank if your system has no Temp HP.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });
  game.settings.register(MOD_ID, "tempHpMaxPath", {
    name: "Temp HP Max Path",
    hint: "Dot path to temporary HP Max (e.g., system.attributes.hp.tempmax). Leave blank if your system has no Temp HP Max.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MOD_ID, "trackDnd5eInspiration", {
    name: "Track Inspiration (DnD5e only)",
    hint: "When enabled, posts a message when a DnD5e actor's Heroic Inspiration toggles.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MOD_ID, "trackDnd5eDeathSaves", {
    name: "Track Death Saves (DnD5e only, PCs)",
    hint: "When enabled, whispers a message to the GM and the owning player when a PC's Death Save success or failure count changes.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MOD_ID, "trackCurrency", {
    name: "Track Currency (DnD5e & PF2E)",
    hint: "When enabled, posts messages for coin changes (pp/gp/ep/sp/cp as available).",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MOD_ID, "currencyBasePath", {
    name: "Currency Base Path (Advanced)",
    hint: "Dot path to the currency object (e.g., dnd5e: system.currency; pf2e: system.currencies). Leave blank to auto-detect.",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MOD_ID, "trackItemChanges", {
    name: "Track Item Changes",
    hint: "When enabled, posts messages when owned items are created, deleted, their quantity changes (system.quantity), or are renamed.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MOD_ID, "trackDnd5eSpellPrep", {
    name: "Track Spell Preparation (DnD5e only)",
    hint: "When enabled, posts a message when a spell becomes prepared/unprepared.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // Use plain concatenation here to avoid any template-literal parsing issues in certain environments
  const sysId = (game.system && game.system.id) || "unknown";
  console.log("[" + MOD_ID + "] Initialized (system=" + sysId + ").");
});

Hooks.once("ready", () => {
  const sampleActor = game.actors?.contents?.[0];
  const paths = resolvePaths(sampleActor);
  console.log("[" + MOD_ID + "] Effective HP/Temp paths:", paths);

  if (getWorldBool("trackCurrency", false) && sampleActor) {
    console.log("[" + MOD_ID + "] Currency detection sample:", detectCurrencyInfo(sampleActor));
  }
});

// -------------------------------
// Stash "before" values for HP/Temp/Inspiration/Currency/Death Saves.
// (Spell-prep does not require stashing.)
// -------------------------------

Hooks.on("preUpdateActor", (actor, update, options, userId) => {
  try {
    const { hpPath, tempPath, tempMaxPath, damageSystem } = resolvePaths(actor);

    const willHP = willUpdatePath(update, hpPath);
    const willTHP = willUpdatePath(update, tempPath);
    const willTHPMax = willUpdatePath(update, tempMaxPath);

    const inspEnabled = ((game.system && game.system.id) === "dnd5e") && getWorldBool("trackDnd5eInspiration", false);
    const inspPath = inspEnabled ? getDnd5eInspirationPath() : null;
    const willInsp = inspPath ? willUpdatePath(update, inspPath) : false;

    const sys = (game.system && game.system.id) || "";
    const currencyEnabled = getWorldBool("trackCurrency", false) && (sys === "dnd5e" || sys === "pf2e");

    let currencyPayload = null;
    if (currencyEnabled) {
      const { basePath, coins } = detectCurrencyInfo(actor);
      if (basePath && coins.length) {
        const baseChanged = willUpdatePath(update, basePath);
        const anyCoinChanged = coins.some(k => willUpdatePath(update, `${basePath}.${k}`));
        if (baseChanged || anyCoinChanged) {
          currencyPayload = { basePath, coins };
        }
      }
    }

    // DnD5e Death Save stash (PCs only)
    let deathPayload = null;
    if (sys === "dnd5e" && getWorldBool("trackDnd5eDeathSaves", false) && actor.type === "character") {
      const { successPath, failurePath } = getDnd5eDeathPaths();
      const willSucc = willUpdatePath(update, successPath);
      const willFail = willUpdatePath(update, failurePath);
      if (willSucc || willFail) {
        deathPayload = {
          oldSucc: readNumber(actor, successPath),
          oldFail: readNumber(actor, failurePath)
        };
      }
    }

    if (!willHP && !willTHP && !willTHPMax && !willInsp && !currencyPayload && !deathPayload) return;

    const oldHP = readNumber(actor, hpPath);
    const oldTHP = readNumber(actor, tempPath);
    const oldTHPMax = readNumber(actor, tempMaxPath);
    const oldInsp = inspPath != null ? Boolean(readRaw(actor, inspPath)) : undefined;

    options = options ?? {};
    options[MOD_ID] = options[MOD_ID] ?? {};
    if (willHP) options[MOD_ID].oldHP = oldHP;
    if (willTHP) options[MOD_ID].oldTHP = oldTHP;
    if (willTHPMax) options[MOD_ID].oldTHPMax = oldTHPMax;
    if (willInsp) options[MOD_ID].oldInspiration = oldInsp;

    if (currencyPayload) {
      const oldCurrency = {};
      for (const k of currencyPayload.coins) {
        oldCurrency[k] = readNumber(actor, `${currencyPayload.basePath}.${k}`);
      }
      options[MOD_ID].currency = {
        basePath: currencyPayload.basePath,
        coins: currencyPayload.coins,
        old: oldCurrency
      };
    }

    if (deathPayload) {
      options[MOD_ID].deathSaves = deathPayload;
    }
  } catch (err) {
    console.error("[" + MOD_ID + "] preUpdateActor error", err);
  }
});

// -------------------------------
// Post compact, color-coded messages after the update applies.
// Only the originator client posts to prevent duplicates.
// -------------------------------

Hooks.on("updateActor", async (actor, update, options, userId) => {
  try {
    if (userId !== game.userId) return;

    const payload = options?.[MOD_ID];
    if (!payload) return;

    const { hpPath, tempPath, tempMaxPath, damageSystem } = resolvePaths(actor);
    const results = [];

    const displayName = getDisplayName(actor);
    const whisper = buildRecipients(actor);

    // HP value changes
    if (typeof payload.oldHP === "number" && hpPath) {
      const newHP = readNumber(actor, hpPath);
      const oldHP = payload.oldHP;
      const delta = newHP - oldHP;
      if (delta !== 0) {
        const sign = delta > 0 ? "+" : "-";
        const mag = Math.abs(delta);
        let cls;
        const line = damageSystem ? `${displayName} Damage: ${oldHP} ${sign} ${mag} → ${newHP}` : `${displayName} HP: ${oldHP} ${sign} ${mag} → ${newHP}`;
        if (damageSystem) cls = delta < 0 ? "hp-gain" : "hp-loss";
        else cls = delta > 0 ? "hp-gain" : "hp-loss";
        results.push({ line, cls, kind: "hp" });
      }
    }

    // Temp HP changes (always blue background)
    if (typeof payload.oldTHP === "number" && tempPath) {
      const newTHP = readNumber(actor, tempPath);
      const oldTHP = payload.oldTHP;
      const deltaT = newTHP - oldTHP;
      if (deltaT !== 0) {
        const signT = deltaT > 0 ? "+" : "-";
        const magT = Math.abs(deltaT);
        const line = `${displayName} Temp: ${oldTHP} ${signT} ${magT} → ${newTHP}`;
        results.push({ line, cls: "hp-temp", kind: "temp" });
      }
    }

    // Temp Max HP changes (purple background)
    if (typeof payload.oldTHPMax === "number" && tempMaxPath) {
      const newTHPMax = readNumber(actor, tempMaxPath);
      const oldTHPMax = payload.oldTHPMax;
      const deltaTM = newTHPMax - oldTHPMax;
      if (deltaTM !== 0) {
        const signTM = deltaTM > 0 ? "+" : "-";
        const magTM = Math.abs(deltaTM);
        const line = `${displayName} Temp Max: ${oldTHPMax} ${signTM} ${magTM} → ${newTHPMax}`;
        results.push({ line, cls: "hp-tempmax", kind: "tempmax" });
      }
    }

    // DnD5e Inspiration changes (orange-gold)
    if (payload.hasOwnProperty("oldInspiration") && (game.system && game.system.id) === "dnd5e" && getWorldBool("trackDnd5eInspiration", false)) {
      const inspPath = getDnd5eInspirationPath();
      const newInsp = Boolean(readRaw(actor, inspPath));
      const oldInsp = Boolean(payload.oldInspiration);
      if (newInsp !== oldInsp) {
        const line = newInsp
          ? `${displayName} gained Heroic Inspiration`
          : `${displayName} spent Heroic Inspiration`;
        results.push({ line, cls: "hp-inspiration", kind: "inspiration" });
      }
    }

    // Currency changes (dark green)
    if (payload.currency && getWorldBool("trackCurrency", false) && ((game.system && game.system.id) === "dnd5e" || (game.system && game.system.id) === "pf2e")) {
      const { basePath, coins, old } = payload.currency;
      for (const k of coins) {
        const oldAmt = Number(old[k] ?? 0);
        const newAmt = readNumber(actor, `${basePath}.${k}`);
        const delta = newAmt - oldAmt;
        if (delta === 0) continue;

        const sign = delta > 0 ? "+" : "-";
        const mag = Math.abs(delta);
        const label = coinLabel(k, (game.system && game.system.id));
        const line = `${displayName} ${label}: ${oldAmt} ${sign} ${mag} → ${newAmt}`;
        results.push({ line, cls: "hp-currency", kind: "currency" });
      }
    }

    // DnD5e Death Saves (PCs only): green on success increment, red on failure increment
    if (payload.deathSaves && (game.system && game.system.id) === "dnd5e" && getWorldBool("trackDnd5eDeathSaves", false) && actor.type === "character") {
      const { successPath, failurePath } = getDnd5eDeathPaths();
      const newSucc = readNumber(actor, successPath);
      const newFail = readNumber(actor, failurePath);
      const oldSucc = Number(payload.deathSaves.oldSucc ?? 0);
      const oldFail = Number(payload.deathSaves.oldFail ?? 0);

      const succInc = newSucc > oldSucc;
      const failInc = newFail > oldFail;

      if (succInc || failInc) {
        const cls = succInc ? "hp-gain" : "hp-loss";
        const line = `${displayName} ${newSucc} Death Save Successes, ${newFail} Fails`;
        results.push({ line, cls, kind: "deathsave" });
      }
    }

    if (!results.length) return;

    for (const r of results) {
      await ChatMessage.create({
        type: CONST.CHAT_MESSAGE_TYPES.OTHER,
        speaker: { alias: "" },
        content: `<div class="hp-delta-line">${r.line}</div>`,
        sound: null,
        whisper,
        flags: { [MOD_ID]: { isHpDelta: true, kind: r.kind, cls: r.cls } }
      });
    }
  } catch (err) {
    console.error("[" + MOD_ID + "] updateActor error", err);
  }
});

// -------------------------------
// Item create/delete/quantity/name tracking + DnD5e spell prep tracking
// (Multi-line enabled for these message types)
// -------------------------------

async function postItemMessage(actor, line) {
  const whisper = buildRecipients(actor);
  await ChatMessage.create({
    type: CONST.CHAT_MESSAGE_TYPES.OTHER,
    speaker: { alias: "" },
    // Multi-line content for items
    content: `<div class="hp-delta-line hp-multiline">${line}</div>`,
    sound: null,
    whisper,
    flags: { [MOD_ID]: { isHpDelta: true, kind: "item", cls: "hp-item" } }
  });
}

Hooks.on("createItem", async (item, options, userId) => {
  try {
    if (userId !== game.userId) return;
    if (!getWorldBool("trackItemChanges", false)) return;
    const actor = item.parent;
    if (!(actor instanceof Actor)) return;

    const qty = readNumber(item, "system.quantity") || 1;
    const displayName = getDisplayName(actor);
    const safeItemName = clipName(item.name);
    const line = `${displayName} Item: ${safeItemName} — 0 + ${qty} → ${qty}`;
    await postItemMessage(actor, line);
  } catch (err) {
    console.error("[" + MOD_ID + "] createItem error", err);
  }
});

Hooks.on("preUpdateItem", (item, change, options, userId) => {
  try {
    const parent = item.parent;
    if (!(parent instanceof Actor)) return;

    const trackItems = getWorldBool("trackItemChanges", false);
    const willQty  = trackItems && willUpdatePath(change, "system.quantity");
    const willName = trackItems && willUpdatePath(change, "name");
    if (!willQty && !willName) return;

    // Stash per-item to avoid batched context cross-talk
    const stash = ITEM_UPDATE_STASH.get(item) ?? {};
    if (willQty)  stash.oldQty  = readNumber(item, "system.quantity") || 0;
    if (willName) stash.oldName = String(item.name ?? "");
    ITEM_UPDATE_STASH.set(item, stash);
  } catch (err) {
    console.error("[" + MOD_ID + "] preUpdateItem error", err);
  }
});

Hooks.on("updateItem", async (item, change, options, userId) => {
  try {
    if (userId !== game.userId) return;
    const actor = item.parent;
    if (!(actor instanceof Actor)) return;

    const stash = ITEM_UPDATE_STASH.get(item) ?? {};
    // Clear immediately to avoid any chance of reuse
    ITEM_UPDATE_STASH.delete(item);

    const displayName = getDisplayName(actor);

    // Quantity delta (items use multi-line style)
    if (getWorldBool("trackItemChanges", false) && Object.prototype.hasOwnProperty.call(stash, "oldQty")) {
      const oldQty = Number(stash.oldQty ?? 0);
      const newQty = readNumber(item, "system.quantity") || 0;
      if (newQty !== oldQty) {
        const sign = (newQty - oldQty) > 0 ? "+" : "-";
        const mag = Math.abs(newQty - oldQty);
        const safeItemName = clipName(item.name);
        const line = `${displayName}'s Item: ${safeItemName} — ${oldQty} ${sign} ${mag} → ${newQty}`;
        await postItemMessage(actor, line);
      }
    }

    // Name change tracking (same styling as quantity)
    if (getWorldBool("trackItemChanges", false) && Object.prototype.hasOwnProperty.call(stash, "oldName")) {
      const oldName = String(stash.oldName ?? "");
      const newName = String(item.name ?? "");
      if (newName !== oldName) {
        const safeOld = clipName(oldName);
        const safeNew = clipName(newName);
        const line = `${displayName}'s Item renamed: ${safeOld} → ${safeNew}`;
        await postItemMessage(actor, line);
      }
    }

    // DnD5e Spell preparation posting (multi-line; robust evaluation)
    if ((game.system && game.system.id) === "dnd5e" && getWorldBool("trackDnd5eSpellPrep", false) && item.type === "spell") {
      const changedPrepared = willUpdatePath(change, "system.prepared") || willUpdatePath(change, "system.preparation.prepared");
      const changedMethod   = willUpdatePath(change, "system.method")   || willUpdatePath(change, "system.preparation.mode");

      if (changedPrepared || changedMethod) {
        const effectivePrepared = computePreparedAfter(item, change);
        const prefix = effectivePrepared ? "prepared" : "unprepared";
        const safeItemName = clipName(item.name);
        const spellLevel = readNumber(item, "system.level");
        const levelTxt = Number.isFinite(spellLevel) ? ` (Lv ${spellLevel})` : "";
        const whisper = buildRecipients(actor);
        await ChatMessage.create({
          type: CONST.CHAT_MESSAGE_TYPES.OTHER,
          speaker: { alias: "" },
          // Multi-line content for spell prep
          content: `<div class="hp-delta-line hp-multiline">${displayName} ${prefix}: ${safeItemName}${levelTxt}</div>`,
          sound: null,
          whisper,
          flags: { [MOD_ID]: { isHpDelta: true, kind: "spellprep", cls: "hp-spellprep" } }
        });
      }
    }
  } catch (err) {
    console.error("[" + MOD_ID + "] updateItem error", err);
  }
});

Hooks.on("preDeleteItem", (item, options, userId) => {
  try {
    if (!getWorldBool("trackItemChanges", false)) return;
    const actor = item.parent;
    if (!(actor instanceof Actor)) return;

    const displayName = getDisplayName(actor);
    const whisper = buildRecipients(actor);
    // Stash per-item delete payload in WeakMap (avoid shared options)
    ITEM_DELETE_STASH.set(item, {
      displayName,
      whisper,
      name: clipName(item.name),
      qty: readNumber(item, "system.quantity") || 0,
      actorId: actor.id
    });
  } catch (err) {
    console.error("[" + MOD_ID + "] preDeleteItem error", err);
  }
});

Hooks.on("deleteItem", async (item, options, userId) => {
  try {
    if (userId !== game.userId) return;
    if (!getWorldBool("trackItemChanges", false)) return;

    // Retrieve and clear stash
    const payload = ITEM_DELETE_STASH.get(item) || options?.[MOD_ID]?.itemDelete;
    ITEM_DELETE_STASH.delete(item);
    if (!payload) return;

    const actor = item.parent instanceof Actor ? item.parent : (payload.actorId ? game.actors?.get(payload.actorId) : null);

    const oldQty = Number(payload.qty ?? 0);
    const sign = "-";
    const mag = oldQty;
    const displayName = payload.displayName ?? (actor ? getDisplayName(actor) : "Actor");
    const line = `${displayName}'s Item: ${payload.name} — ${oldQty} ${sign} ${mag} → 0`;

    const whisper = payload.whisper ?? (actor ? buildRecipients(actor) : []);
    await ChatMessage.create({
      type: CONST.CHAT_MESSAGE_TYPES.OTHER,
      speaker: { alias: "" },
      content: `<div class="hp-delta-line hp-multiline">${line}</div>`,
      sound: null,
      whisper,
      flags: { [MOD_ID]: { isHpDelta: true, kind: "item", cls: "hp-item" } }
    });
  } catch (err) {
    console.error("[" + MOD_ID + "] deleteItem error", err);
  }
});

// -------------------------------
// Render: add classes to hp-delta messages
// -------------------------------

Hooks.on("renderChatMessage", (message, html) => {
  try {
    if (!message.getFlag(MOD_ID, "isHpDelta")) return;
    const li = html?.[0]?.closest?.(".chat-message");
    if (!li) return;
    li.classList.add("hp-delta");
    const cls = message.getFlag(MOD_ID, "cls");
    if (cls) li.classList.add(cls);
  } catch (err) {
    console.error("[" + MOD_ID + "] renderChatMessage error", err);
  }
});