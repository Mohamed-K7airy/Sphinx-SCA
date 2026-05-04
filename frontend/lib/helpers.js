// ============================================================
// Utility helpers shared across all frontend modules
// ============================================================

/** Generate a UUID v4. */
export function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/** HH:MM label for the current time. */
export function nowTimeLabel(d = new Date()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Auto-resize a textarea to fit its content (max 180px). */
// ✅ FIX (M-09): Per-element debounce via WeakMap instead of shared global
const _resizeTimeouts = new WeakMap();
export function autoResize(el) {
    if (!el) return;
    const prev = _resizeTimeouts.get(el);
    if (prev) clearTimeout(prev);
    _resizeTimeouts.set(el, setTimeout(() => {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    }, 30));
}

/** Escape a string for safe HTML insertion. */
export function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** Escape a string for use in an HTML attribute value. */
export function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** Scroll the chat panel to the bottom smoothly */
export function scrollToBottom(el, smooth = true) {
    if (!el) return;
    requestAnimationFrame(() => {
        if (smooth) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        } else {
            el.scrollTop = el.scrollHeight;
        }
    });
}

// ─── Shared Application State ─────────────────────────────────
export const appState = {
    currentMode: 'general',
    currentUserId: null,
    currentSessionId: generateUUID(),
    isChatActive: false,
    isStreaming: false,
    graphMode: false,
};

// ─── Req #3: Chat persistence across refreshes ────────────────
// Save the user's currently active session id so a hard refresh
// restores the same chat instead of starting a new one. Each page
// uses its own key so Study Mode and normal chat don't collide.
const SESSION_KEYS = {
    chat: 'sphinx:last_active_session_chat',
    study: 'sphinx:last_active_session_study',
};

export function persistActiveSession(scope, sessionId) {
    const key = SESSION_KEYS[scope];
    if (!key || !sessionId) return;
    try { localStorage.setItem(key, sessionId); } catch (e) { /* private mode */ }
}

export function getPersistedSession(scope) {
    const key = SESSION_KEYS[scope];
    if (!key) return null;
    try { return localStorage.getItem(key) || null; } catch (e) { return null; }
}

export function clearPersistedSession(scope) {
    const key = SESSION_KEYS[scope];
    if (!key) return;
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
}

/** True only when the page actually got reloaded (F5 / Ctrl+R). */
export function isPageReload() {
    try {
        const nav = performance.getEntriesByType('navigation')[0];
        return nav ? nav.type === 'reload' : false;
    } catch (e) { return false; }
}
