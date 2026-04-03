# Sphinx-SCA UI — Update Plan

---

## 1. Message Action Buttons (Copy / Regenerate / Like / Dislike)

**Problem:** No action buttons appear below AI responses.

**Plan:**
- Add a small row of buttons below every AI message, visible on hover only.
- Required buttons: Copy text, Regenerate, Like, Dislike.
- Copy button briefly turns green after clicking as confirmation.
- Regenerate button re-sends the last user message to the model.
- Buttons are fully transparent and only appear on message hover.

---

## 2. Input Bar — Mic Button & Hide the `+` Button

**Problem:** The `+` button always shows, and the mic is not placed next to the send button.

**Plan:**
- On a new/empty chat: show the `+` and image buttons as usual.
- After the first message is sent: permanently hide the `+` button.
- The mic button should always sit next to the send button (not next to `+`).
- Bar order left to right: `[image]` — `[text input]` — `[mode selector]` — `[mic]` — `[send]`

---

## 3. Fix Old Conversation Layout Bug

**Problem:** When returning to an old conversation, messages overlap or avatars break.

**Plan:**
- When loading any old conversation, clear the message container first before rendering.
- Re-render every message using the same function used for live conversations.
- Make sure the `chat-active` class is automatically added when loading old chats (so the `+` button hides correctly).
- Auto-scroll to the bottom after loading.

---

## 4. Image Upload Drop Zone (MathGPT Style)

**Problem:** No clear drag & drop area for uploading images or PDFs.

**Plan:**
- Add a rectangular zone with a dashed border directly above the text input.
- Contains an image icon + text: `Drag & drop or click to add images or PDF`
- The word "click" is a styled link in the accent color (e.g. orange).
- On drag-over: border turns orange and background gets a subtle tint.
- After upload: show a small preview thumbnail inside the zone with an `×` remove button.
- Accepted file types: images (jpg, png, webp) and PDF.

---

## 5. On-Screen Calculator

**Problem:** No calculator available in the interface.

**Plan:**
- Add a `Calculator` button in the toolbar.
- Clicking it opens a floating panel in the bottom-left corner.
- The panel has two tabs:
  - **Basic:** Standard calculator (numbers, operators, equals, clear) — same layout as the screenshot.
  - **Graphing:** Embedded GeoGebra Graphing iframe.
- An `×` button to close the panel.
- The panel should be draggable so it doesn't cover the chat.

---

## 6. Tools Menu — Create Graph with GeoGebra

**Problem:** No Tools menu or graph creation feature exists.

**Plan:**
- Add a `🛠 Tools ▾` button in the input bar.
- Clicking it opens a dropdown above with these options:
  - 📈 Create Graph
  - ▶ Create Video
  - 📋 Create Practice Test
  - 📖 Create Study Guide
- Clicking **Create Graph** opens a large centered modal with GeoGebra Graphing embedded as an iframe.
- Modal has a close button; clicking outside it also closes it.
- GeoGebra is free and requires no API key — direct embed only.

---

## 7. Footer Disclaimer

**Problem:** No disclaimer text below the input box.

**Plan:**
- Add a small gray text line directly below the input bar.
- Text: `Sphinx-SCA can make mistakes. Always verify important calculations.`
- Non-selectable, centered alignment.

---

## Priority Summary

| Priority | Update |
|----------|--------|
| 🔴 High | Fix old conversation layout |
| 🔴 High | Image upload drop zone |
| 🟡 Medium | Message action buttons |
| 🟡 Medium | Input bar (mic + hide `+`) |
| 🟢 Low | On-screen calculator |
| 🟢 Low | Tools menu + GeoGebra graph |
| 🟢 Low | Footer disclaimer |
