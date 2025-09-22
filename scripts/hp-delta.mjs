// HP Delta Reporter for Foundry VTT v13, system dnd5e 5.1
// - Watches HP value, Temp HP, and Temp Max HP changes.
// - Posts a compact one-line chat entry.
// - Background color indicates the type/sign: green (HP gain), red (HP loss), blue (Temp HP), purple (Temp Max HP).
// - Visibility: NPC -> GM only; Character -> GM + owning player(s).

const MOD_ID = "tiny-hp-monitor";

Hooks.once("init", () => {
  console.log(`[${MOD_ID}] Initialized`);
});

// Helper: format a signed delta with spaces, e.g., "+ 10" or "- 5"
function formatDelta(delta) {
  const sign = delta >= 0 ? "+" : "-";
  return `${sign} ${Math.abs(delta)}`;
}

// Record old values prior to update so we can compute deltas after.
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

// After the update applies, compute deltas and whisper appropriately.
// Only the originating client posts to avoid duplicates.
Hooks.on("updateActor", async (actor, update, options, userId) => {
  try {
    if (game.system.id !== "dnd5e") return;
    if (userId !== game.userId) return;

    const payload = options?.[MOD_ID];
    if (!payload) return;

    const hp = actor.system?.attributes?.hp ?? {};
    const results = [];

    // Resolve display name (prefer token)
    let tokenName = actor.name;
    if (actor.isToken && actor.token) {
      tokenName = actor.token.name || tokenName;
    } else {
      const active = actor.getActiveTokens();
      if (active?.length) tokenName = active[0].name || tokenName;
    }

    // Determine whisper recipients: NPC -> GMs; Character -> GMs + owners
    const gmUsers = game.users.filter(u => u.isGM);
    let recipients;
    if (actor.type === "npc") {
      recipients = gmUsers;
    } else {
      const owners = game.users.filter(u => actor.testUserPermission?.(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
      const uniq = new Map();
      [...gmUsers, ...owners].forEach(u => uniq.set(u.id, u));
      recipients = [...uniq.values()];
    }
    let whisper = recipients.map(u => u.id);
    if (!whisper.length) whisper = [game.userId];

    // HP change
    if (typeof payload.oldHP === "number") {
      const newHP = Number(hp.value ?? 0);
      const oldHP = payload.oldHP;
      const delta = newHP - oldHP;
      if (delta !== 0) {
        const line = `${tokenName} HP: ${oldHP} ${formatDelta(delta)} → ${newHP}`;
        const cls = delta > 0 ? "hp-gain" : "hp-loss";
        results.push({ line, cls, kind: "hp" });
      }
    }

    // Temp HP change
    if (typeof payload.oldTHP === "number") {
      const newTHP = Number(hp.temp ?? 0);
      const oldTHP = payload.oldTHP;
      const deltaT = newTHP - oldTHP;
      if (deltaT !== 0) {
        const line = `${tokenName} Temp HP: ${oldTHP} ${formatDelta(deltaT)} → ${newTHP}`;
        results.push({ line, cls: "hp-temp", kind: "temp" });
      }
    }

    // Temp Max HP change
    if (typeof payload.oldTHPMax === "number") {
      const newTHPMax = Number(hp.tempmax ?? 0);
      const oldTHPMax = payload.oldTHPMax;
      const deltaTM = newTHPMax - oldTHPMax;
      if (deltaTM !== 0) {
        const line = `${tokenName} Temp Max HP: ${oldTHPMax} ${formatDelta(deltaTM)} → ${newTHPMax}`;
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

// Tag our messages on render so CSS can minimize and color the background.
Hooks.on("renderChatMessage", (message, html) => {
  try {
    if (!message.getFlag(MOD_ID, "isHpDelta")) return;
    const cls = message.getFlag(MOD_ID, "cls");
    html.addClass("hp-delta");
    if (cls) html.addClass(cls);
    html.find(".message-content").addClass("hp-delta-content");
  } catch (err) {
    console.error(`[${MOD_ID}] renderChatMessage error`, err);
  }
});