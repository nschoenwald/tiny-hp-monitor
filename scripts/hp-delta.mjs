// Tiny HP Monitor for Foundry VTT v13, dnd5e 5.1
// - Watches HP value, Temp HP, and Temp Max HP changes.
// - Posts a compact one-line chat entry with colored background:
//   green (HP gain), red (HP loss), blue (Temp HP), purple (Temp Max HP).
// - Visibility: NPC => configurable (GM only / GM+all players / GM+owners); Characters => GM + owning users.

const MOD_ID = "tiny-hp-monitor";
const MAX_NAME_CHARS = 30;

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

  console.log(`[${MOD_ID}] Initialized`);
});

// Stash "before" values so we can compute accurate deltas after clamping/house rules.
Hooks.on("preUpdateActor", (actor, update, options, userId) => {
  try {
    if (game.system.id !== "dnd5e") return;

    const hpPath = "system.attributes.hp.value";
    const thpPath = "system.attributes.hp.temp";
    const thpMaxPath = "system.attributes.hp.tempmax";

    const willHP = foundry.utils.hasProperty(update, hpPath);
    const willTHP = foundry.utils.hasProperty(update, thpPath);
    const willTHPMax = foundry.utils.hasProperty(update, thpMaxPath);
    if (!willHP && !willTHP && !willTHPMax) return;

    const hp = actor.system?.attributes?.hp ?? {};
    const oldHP = Number(hp.value ?? 0);
    const oldTHP = Number(hp.temp ?? 0);
    const oldTHPMax = Number(hp.tempmax ?? 0);

    options ??= {};
    options[MOD_ID] ??= {};
    if (willHP) options[MOD_ID].oldHP = oldHP;
    if (willTHP) options[MOD_ID].oldTHP = oldTHP;
    if (willTHPMax) options[MOD_ID].oldTHPMax = oldTHPMax;
  } catch (err) {
    console.error(`[${MOD_ID}] preUpdateActor error`, err);
  }
});

// Post compact, color-coded messages after the update applies.
// Only the originator client posts to prevent duplicates.
Hooks.on("updateActor", async (actor, update, options, userId) => {
  try {
    if (game.system.id !== "dnd5e") return;
    if (userId !== game.userId) return;

    const payload = options?.[MOD_ID];
    if (!payload) return;

    const hp = actor.system?.attributes?.hp ?? {};
    const results = [];

    // Pick a display name favoring the specific token if present, then clip long names.
    let tokenName = actor.name;
    if (actor.isToken && actor.token) {
      tokenName = actor.token.name || tokenName;
    } else {
      const active = actor.getActiveTokens();
      if (active?.length) tokenName = active[0].name || tokenName;
    }
    const displayName = clipName(tokenName);

    // Build recipients with audience tweaking
    const gmUsers = game.users.filter(u => u.isGM);
    const owners = game.users.filter(u => actor.testUserPermission?.(u, "OWNER"));

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
    const whisper = recipients.map(u => u.id);

    // HP value changes
    if (typeof payload.oldHP === "number") {
      const newHP = Number(hp.value ?? 0);
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
    if (typeof payload.oldTHP === "number") {
      const newTHP = Number(hp.temp ?? 0);
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
    if (typeof payload.oldTHPMax === "number") {
      const newTHPMax = Number(hp.tempmax ?? 0);
      const oldTHPMax = payload.oldTHPMax;
      const deltaTM = newTHPMax - oldTHPMax;
      if (deltaTM !== 0) {
        const signTM = deltaTM > 0 ? "+" : "-";
        const magTM = Math.abs(deltaTM);
        const line = `${displayName} Temp Max: ${oldTHPMax} ${signTM} ${magTM} → ${newTHPMax}`;
        results.push({ line, cls: "hp-tempmax", kind: "tempmax" });
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

// Mark and color messages at render time.
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