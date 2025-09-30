# Tiny HP Monitor

Tiny, one‑line HP change notifications for Foundry VTT v13 with support for DnD5e and other systems.
Currently supported systems: DnD5e, PF2E, Shadow of the Demon Lord. Data paths for other systems can be entered manually.
Color‑coded background, white text with a subtle outline, and minimal vertical height.
Messages whisper to the right people automatically.

## Example output

![Example outputs](https://i.postimg.cc/598ydHRK/Greenshot-2025-09-22-13-22-31.png)

## Features

### Watches these DnD5e fields

system.attributes.hp.value (HP)

system.attributes.hp.temp (Temp HP)

system.attributes.hp.tempmax (Temp Max HP)

### Minimal vertical space per message

Single compact line with arrow “→” and spaced signs: “10 − 5 → 5”, “7 + 3 → 10”.

Theme‑resilient CSS: minimal height, white text, soft text shadow for readability.

### Background colors

Green = HP gain

Red = HP loss

Blue = Temp HP change

Purple = Temp Max HP change

### Visibility

NPCs: whispered to GMs only

Player Characters: whispered to GMs and actor owners

## Additional (optional) Features

![Optional features](https://i.postimg.cc/25J3S4VG/image.png)

(Heroic) Inspiration Tracking for DnD5e

Currency Tracking (Platinum / Gold / Electrum / Silver / Copper) for DnD5e and PF2E and experimental support for other systems.

Item changes tracking (quantity & renaming)
