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
    pf2e:  { pp: "Platinum", gp: "Gold", sp: "Silver", cp: "Copper" }
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
  game.settings.register(MOD_ID, "npcAudience", {
    name: "NPC Message Audience",
    hint: "Who sees NPC health changes?",
    scope: "world", config: true, type: String,
    choices: { "gm": "GM only", "gm-players": "GM + all players", "gm-owners": "GM + owners (default)" },
    default: "gm-owners"
  });
  game.settings.register(MOD_ID, "autoDetectPaths", { name: "Auto-Detect HP Paths", scope: "world", config: true, type: Boolean, default: true });
  game.settings.register(MOD_ID, "hpPath", { name: "HP Value Path", scope: "world", config: true, type: String, default: "" });
  game.settings.register(MOD_ID, "tempHpPath", { name: "Temp HP Path", scope: "world", config: true, type: String, default: "" });
  game.settings.register(MOD_ID, "tempHpMaxPath", { name: "Temp HP Max Path", scope: "world", config: true, type: String, default: "" });
  game.settings.register(MOD_ID, "trackDnd5eInspiration", { name: "Track Inspiration (DnD5e)", scope: "world", config: true, type: Boolean, default: false });
  game.settings.register(MOD_ID, "trackDnd5eDeathSaves", { name: "Track Death Saves (DnD5e PCs)", scope: "world", config: true, type: Boolean, default: false });
  game.settings.register(MOD_ID, "trackCurrency", { name: "Track Currency", scope: "world", config: true, type: Boolean, default: false });
  game.settings.register(MOD_ID, "currencyBasePath", { name: "Currency Base Path (Adv)", scope: "world", config: true, type: String, default: "" });
  game.settings.register(MOD_ID, "trackItemChanges", { name: "Track Item Changes", scope: "world", config: true, type: Boolean, default: false });
  game.settings.register(MOD_ID, "trackDnd5eSpellPrep", { name: "Track Spell Preparation (DnD5e)", scope: "world", config: true, type: Boolean, default: true });

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

  if (!willHP && !willTHP && !willTHPMax && !willInsp && !currencyPayload && !deathPayload) return;

  // Stash in options for the updateActor hook to pick up
  options[MOD_ID] = {
    oldHP: willHP ? readNumber(actor, hpPath) : undefined,
    oldTHP: willTHP ? readNumber(actor, tempPath) : undefined,
    oldTHPMax: willTHPMax ? readNumber(actor, tempMaxPath) : undefined,
    oldInspiration: willInsp ? Boolean(readRaw(actor, inspPath)) : undefined,
    currency: currencyPayload ? { ...currencyPayload, old: Object.fromEntries(currencyPayload.coins.map(k => [k, readNumber(actor, `${currencyPayload.basePath}.${k}`)])) } : undefined,
    deathSaves: deathPayload
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

  // Set new timer
  pending.timer = setTimeout(() => {
    processActorUpdate(actor, pending);
    ACTOR_DEBOUNCE.delete(uuid);
  }, DEBOUNCE_MS);

  ACTOR_DEBOUNCE.set(uuid, pending);
});

async function processActorUpdate(actor, data) {
  const { hpPath, tempPath, tempMaxPath, damageSystem } = resolvePaths(actor);
  const link = getActorLink(actor);
  
  // HP
  if (data.oldHP !== undefined && hpPath) {
    const newHP = readNumber(actor, hpPath);
    const delta = newHP - data.oldHP;
    if (delta !== 0) {
      const cls = (damageSystem ? delta < 0 : delta > 0) ? "tiny-monitor-gain" : "tiny-monitor-loss";
      const icon = `<i class="fa-solid fa-heart"></i>`;
      const line = `${icon} ${link} ${damageSystem ? "Damage" : "HP"}: ${data.oldHP} ${delta > 0 ? "+" : "-"} ${Math.abs(delta)} → ${newHP}`;
      await postMonitorMessage(actor, line, cls, "hp");
    }
  }

  // Temp HP
  if (data.oldTHP !== undefined && tempPath) {
    const newTHP = readNumber(actor, tempPath);
    const delta = newTHP - data.oldTHP;
    if (delta !== 0) {
      const icon = `<i class="fa-solid fa-shield-halved"></i>`;
      const line = `${icon} ${link} Temp: ${data.oldTHP} ${delta > 0 ? "+" : "-"} ${Math.abs(delta)} → ${newTHP}`;
      await postMonitorMessage(actor, line, "tiny-monitor-temp", "temp");
    }
  }

  // Temp Max HP
  if (data.oldTHPMax !== undefined && tempMaxPath) {
    const newTHPMax = readNumber(actor, tempMaxPath);
    const delta = newTHPMax - data.oldTHPMax;
    if (delta !== 0) {
      const icon = `<i class="fa-solid fa-circle-plus"></i>`;
      const line = `${icon} ${link} Temp Max: ${data.oldTHPMax} ${delta > 0 ? "+" : "-"} ${Math.abs(delta)} → ${newTHPMax}`;
      await postMonitorMessage(actor, line, "tiny-monitor-tempmax", "tempmax");
    }
  }

  // Inspiration
  if (data.oldInspiration !== undefined && game.system.id === "dnd5e") {
    const newInsp = Boolean(readRaw(actor, getDnd5eInspirationPath()));
    if (newInsp !== data.oldInspiration) {
      const icon = `<i class="fa-solid fa-dice-d20"></i>`;
      const line = `${icon} ${link} ${newInsp ? "gained" : "spent"} Heroic Inspiration`;
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
        const line = `${icon} ${link} ${coinLabel(k, game.system.id)}: ${oldVal} ${delta > 0 ? "+" : "-"} ${Math.abs(delta)} → ${newVal}`;
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
    
    if (newSucc > oldSucc || newFail > oldFail) {
      const icon = `<i class="fa-solid fa-skull"></i>`;
      const line = `${icon} ${link} ${newSucc} Death Save Successes, ${newFail} Fails`;
      await postMonitorMessage(actor, line, newSucc > oldSucc ? "tiny-monitor-gain" : "tiny-monitor-loss", "deathsave");
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
  const link = getActorLink(item.parent);
  const safeItemName = clipName(item.name);
  const icon = `<i class="fa-solid fa-backpack"></i>`;
  const line = qty === 1 
    ? `${icon} ${link} Item added: ${safeItemName}`
    : `${icon} ${link} Item: ${safeItemName} — 0 + ${qty} → ${qty}`;
  
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
      const link = getActorLink(item.parent);
      const icon = `<i class="fa-solid fa-book"></i>`;
      const line = `${icon} ${link} ${prepared ? "prepared" : "unprepared"}: ${clipName(item.name)}${Number.isFinite(level) ? ` (Lv ${level})` : ""}`;
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

  const link = getActorLink(item.parent);
  const icon = `<i class="fa-solid fa-backpack"></i>`;

  // Quantity
  if (data.oldQty !== undefined) {
    const oldQty = data.oldQty;
    const newQty = readNumber(item, "system.quantity") || 0;
    
    if (newQty !== oldQty) {
      const safeItemName = clipName(item.name);
      if (oldQty === 0 && newQty === 1) await postMonitorMessage(item.parent, `${icon} ${link} Item added: ${safeItemName}`, "tiny-monitor-item-inc", "item", true);
      else if (oldQty === 1 && newQty === 0) await postMonitorMessage(item.parent, `${icon} ${link} Item deleted: ${safeItemName}`, "tiny-monitor-item-dec", "item", true);
      else {
        const delta = newQty - oldQty;
        const line = `${icon} ${link}'s Item: ${safeItemName} — ${oldQty} ${delta > 0 ? "+" : "-"} ${Math.abs(delta)} → ${newQty}`;
        await postMonitorMessage(item.parent, line, delta > 0 ? "tiny-monitor-item-inc" : "tiny-monitor-item-dec", "item", true);
      }
    }
  }

  // Rename
  if (data.oldName !== undefined && item.name !== data.oldName) {
    const line = `${icon} ${link}'s Item renamed: ${clipName(data.oldName)} → ${clipName(item.name)}`;
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
    link: getActorLink(item.parent),
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

  const { hasQty, qty, link, whisper, name } = payload;
  const oldQty = Number(qty ?? 0);

  // Suppress deletion message if item tracks quantity but was already 0
  if (hasQty && oldQty === 0) return;

  const treatAsSingleton = !hasQty || oldQty <= 1;
  const icon = `<i class="fa-solid fa-backpack"></i>`;
  
  const line = treatAsSingleton 
      ? `${icon} ${link} Item deleted: ${name}` 
      : `${icon} ${link}'s Item: ${name} — ${oldQty} - ${oldQty} → 0`;

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