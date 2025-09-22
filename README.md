# tiny-hp-monitor

Tiny, one‑line HP change notifications for Foundry VTT v13 and DnD5e 5.1.
Color‑coded background, white text with a subtle outline, and minimal vertical height.
Messages whisper to the right people automatically.

## Example output

“PLAYERNAME HP: 9 + 5 → 14” (green background)

“PLAYERNAME Temp HP: 5 − 3 → 2” (blue background)

“PLAYERNAME Temp Max HP: 0 + 5 → 5” (purple background)

## Features

### Watches these DnD5e fields

system.attributes.hp.value (HP)

system.attributes.hp.temp (Temp HP)

system.attributes.hp.tempmax (Temp Max HP)

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
