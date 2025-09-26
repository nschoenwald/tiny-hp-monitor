// Tiny HP Monitor for Foundry VTT v13
// Multi-system (auto-detect + configurable paths). Tested with dnd5e 5.1.
// - Watches HP value, Temp HP, Temp Max HP changes (if present in the system).
// - Optional DnD5e Inspiration tracking (world setting; default OFF).
// - Posts a compact one-line chat entry with colored background:
//   green (HP gain), red (HP loss), blue (Temp HP), purple (Temp Max HP), orange-gold (Inspiration).
// - Visibility: NPC => configurable (GM only / GM+all players / GM+owners); Characters => GM + owning users.

const MOD_ID = "tiny-hp-monitor";
const MAX_NAME_CHARS = 25;

// -------------------------------
// Utilities
// -------------------------------

/**
 * Clip a name to MAX_NAME_CHARS and append "[...]"
 * Only adds the suffix if clipping actually occurs.
 * Uses Array.from to avoid cutting inside surrogate pairs.
 */
function clipName(name) {
  const chars = Array.from(String(name ?? ""));
  if (chars.length <= MAX_NAME_CHARS) return chars.join("");
  return chars.slice(0, MAX_NAME_CHARS).join("") + "[...]";
}

/**
 * Get safe boolean world setting.
 */
function getWorldBool(key, def = false) {
  try { return Boolean(game.settings.get(MOD_ID, key)); } catch { return def; }
}

/**
 * Get safe string world setting (empty string => null meaning "unset").
 */
function getWorldPath(key) {
  try {
    const v = game.settings.get(MOD_ID, key);
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s.length ? s : null;
  } catch { return null; }
}

/**
 * Attempt to detect common HP/Temp/TempMax paths by system id first, then by probing.
 * Returns { hpPath, tempPath, tempMaxPath } (any may be null if unsupported).
 */
function detectSystemPaths(sampleActor) {
  const sys = game.system?.id ?? "";
  // Known defaults by system id.
  if (sys === "dnd5e") {
    return {
      hpPath: "system.attributes.hp.value",
      tempPath: "system.attributes.hp.temp",
      tempMaxPath: "system.attributes.hp.tempmax"
    };
  }
  if (sys === "pf2e") {
    // PF2E has temp but no temp max.
    return {
      hpPath: "system.attributes.hp.value",
      tempPath: "system.attributes.hp.temp",
      tempMaxPath: null
    };
  }
  if (sys === "shadowdark") {
    // Shadowdark generally exposes system.hp.value; no temp concepts by default.
    return {
      hpPath: "system.hp.value",
      tempPath: null,
      tempMaxPath: null
    };
  }

  // Heuristic probe for unknown systems.
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

  return { hpPath, tempPath, tempMaxPath };
}

/**
 * Resolve effective paths, honoring "auto-detect" setting and manual overrides.
 */
function resolvePaths(actor) {
  const auto = getWorldBool("autoDetectPaths", true);
  if (auto) {
    return detectSystemPaths(actor);
  }
  // Manual overrides; allow partial overrides. Empty => treat as unsupported.
  return {
    hpPath: getWorldPath("hpPath"),
    tempPath: getWorldPath("tempHpPath"),
    tempMaxPath: getWorldPath("tempHpMaxPath")
  };
}

/**
 * DnD5e Inspiration path.
 */
function getDnd5eInspirationPath() {
  return "system.attributes.inspiration";
}

/**
 * Read a numeric value from actor by dot-path. Missing/null => 0.
 */
function readNumber(actor, path) {
  if (!path) return 0;
  const v = foundry.utils.getProperty(actor, path);
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/**
 * Read raw property.
 */
function readRaw(actor, path) {
  if (!path) return undefined;
  return foundry.utils.getProperty(actor, path);
}

/**
 * Check whether an update object will modify a path.
 */
function willUpdatePath(update, path) {
  if (!path) return false;
  return foundry.utils.hasProperty(update, path);
}

/**
 * Pick a display name favoring the specific token if present, then clip long names.
 */
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

/**
 * Build whisper recipients based on NPC audience setting and ownership.
 */
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
    } else { // "gm-owners"
      recipients = uniq(gmUsers, owners);
    }
  } else {
    // PCs and other non-NPCs: GM + owners
    recipients = uniq(gmUsers, owners);
  }
  if (!recipients?.length) recipients = gmUsers; // safety fallback
  return recipients.map(u => u.id);
}

// -------------------------------
// Settings
// -------------------------------

Hooks.once("init", () => {
  // Audience control (unchanged behavior)
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

  // Auto-detect toggle: when enabled, paths are detected from the active system.
  game.settings.register(MOD_ID, "autoDetectPaths", {
    name: "Auto-Detect HP Paths",
    hint: "When enabled, auto-detect HP / Temp HP paths for this system (dnd5e, pf2e, shadowdark supported) or probe common paths for others.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Manual override paths (leave blank to disable that field or rely on auto-detect).
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

  // Optional DnD5e Inspiration tracking
  game.settings.register(MOD_ID, "trackDnd5eInspiration", {
    name: "Track Inspiration (DnD5e only)",
    hint: "When enabled, posts a message when a DnD5e actor's Inspiration toggles. Uses an orange-gold chat color.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  console.log(`[${MOD_ID}] Initialized (system=${game.system?.id}).`);
});

Hooks.once("ready", () => {
  // Log effective paths once (using the first owned actor as sample for detection).
  const sampleActor = game.actors?.contents?.[0];
  const paths = resolvePaths(sampleActor);
  console.log(`[${MOD_ID}] Effective paths:`, paths);
});

// -------------------------------
/* Stash "before" values so we can compute accurate deltas after clamping/house rules. */
// -------------------------------

Hooks.on("preUpdateActor", (actor, update, options, userId) => {
  try {
    const { hpPath, tempPath, tempMaxPath } = resolvePaths(actor);

    const willHP = willUpdatePath(update, hpPath);
    const willTHP = willUpdatePath(update, tempPath);
    const willTHPMax = willUpdatePath(update, tempMaxPath);

    // Inspiration (DnD5e only, and only if setting enabled)
    const inspEnabled = (game.system?.id === "dnd5e") && getWorldBool("trackDnd5eInspiration", false);
    const inspPath = inspEnabled ? getDnd5eInspirationPath() : null;
    const willInsp = inspPath ? willUpdatePath(update, inspPath) : false;

    if (!willHP && !willTHP && !willTHPMax && !willInsp) return;

    const oldHP = readNumber(actor, hpPath);
    const oldTHP = readNumber(actor, tempPath);
    const oldTHPMax = readNumber(actor, tempMaxPath);
    const oldInsp = inspPath != null ? Boolean(readRaw(actor, inspPath)) : undefined;

    options ??= {};
    options[MOD_ID] ??= {};
    if (willHP) options[MOD_ID].oldHP = oldHP;
    if (willTHP) options[MOD_ID].oldTHP = oldTHP;
    if (willTHPMax) options[MOD_ID].oldTHPMax = oldTHPMax;
    if (willInsp) options[MOD_ID].oldInspiration = oldInsp;
  } catch (err) {
    console.error(`[${MOD_ID}] preUpdateActor error`, err);
  }
});

// -------------------------------
// Post compact, color-coded messages after the update applies.
// Only the originator client posts to prevent duplicates.
// -------------------------------

Hooks.on("updateActor", async (actor, update, options, userId) => {
  try {
    if (userId !== game.userId) return; // single poster

    const payload = options?.[MOD_ID];
    if (!payload) return;

    const { hpPath, tempPath, tempMaxPath } = resolvePaths(actor);
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
        const line = `${displayName} HP: ${oldHP} ${sign} ${mag} → ${newHP}`;
        const cls = delta > 0 ? "hp-gain" : "hp-loss";
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
    if (payload.hasOwnProperty("oldInspiration") && game.system?.id === "dnd5e" && getWorldBool("trackDnd5eInspiration", false)) {
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

    if (!results.length) return;

    for (const r of results) {
      await ChatMessage.create({
        type: CONST.CHAT_MESSAGE_TYPES.OTHER,
        speaker: { alias: "" }, // header hidden via CSS
        content: `<div class="hp-delta-line">${r.line}</div>`,
        sound: null,
        whisper,
        flags: { [MOD_ID]: { isHpDelta: true, kind: r.kind, cls: r.cls } }
      });
    }
  } catch (err) {
    console.error(`[${MOD_ID}] updateActor error`, err);
  }
});

// -------------------------------
// Mark and color messages at render time.
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
    console.error(`[${MOD_ID}] renderChatMessage error`, err);
  }
});