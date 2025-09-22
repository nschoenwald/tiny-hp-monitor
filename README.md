# Tiny HP Monitor

Tiny, one‑line HP change notifications for Foundry VTT v13 and DnD5e v5+.
Color‑coded background, white text with a subtle outline, and minimal vertical height.
Messages whisper to the right people automatically.

## Example output

![Example outputs](https://i.postimg.cc/598ydHRK/Greenshot-2025-09-22-13-22-31.png)

TOKEN_NAME HP: 9 + 5 → 14” (green background)

TOKEN_NAME Temp HP: 5 − 3 → 2” (blue background)

TOKEN_NAME Temp Max HP: 0 + 5 → 5” (purple background)

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
