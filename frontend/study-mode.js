// ============================================================
// Study Mode — MATHX  (FIXED v6)
// ============================================================
// FIX 1: extractContent() — maps all backend response keys to text
// FIX 2: البطء — حذف الـ pre-solve من أول رسالة، classify بيحصل
//         locally (بدون API call)، الـ correct_answer بتتجيب
//         lazy (بعد ما المستخدم يكتب إجابة)
// FIX 3: الـ hint/solve buttons بتظهر "Session updated" لأن
//         data.display_markdown كان undefined → استخدم extractContent
// ============================================================

import { supabase } from './supabaseClient.js';
import { initMarkdown, formatMessage } from './lib/markdown.js';
import { initCalculator, initMathToolbar, initGraph } from './lib/ui.js';
import { persistActiveSession, getPersistedSession, clearPersistedSession, isPageReload } from './lib/helpers.js';
import {
    openSingleQuiz, openPracticeTest, openBranchDiffMenu,
    openQuizPanel, closeQuizPanel,
    studyAnalytics, mountSessionAnalytics,
} from './lib/quiz.js';

// ✅ FIX (M-01, M-02): Define utility functions that were used but never imported
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function getCurrentChatContext() {
    // Get last AI message text from chat
    const aiMessages = document.querySelectorAll('.ai-message, .assistant-message, [data-role="assistant"]');
    const lastAI = aiMessages[aiMessages.length - 1];
    const lastText = lastAI ? (lastAI.innerText || lastAI.textContent || '').slice(0, 800) : '';
    
    // Get last user message
    const userMessages = document.querySelectorAll('.user-message, [data-role="user"]');
    const lastUser = userMessages[userMessages.length - 1];
    const lastUserText = lastUser ? (lastUser.innerText || lastUser.textContent || '').slice(0, 300) : '';
    
    return {
        context: lastText,
        user_question: lastUserText,
        topic: window.currentMathTopic || 'General Math',
        unit: window.currentMathUnit || ''
    };
}
window.getCurrentChatContext = getCurrentChatContext;

// ── Reply Context Parser ─────────────────────────────────────
// Splits a stored "[User is replying to ...]\n\nMSG" string into
// the quoted snippet + the user's actual message so the bubble
// can render a Telegram-style quote block above the text.
const REPLY_PREFIX_RE = /^\[User is replying to this specific part of your previous response: "([\s\S]*?)"\]\n\n([\s\S]*)$/;
function parseReplyText(text) {
    if (!text) return { quoted: null, message: text || '' };
    const match = String(text).match(REPLY_PREFIX_RE);
    if (match) return { quoted: match[1], message: match[2] };
    return { quoted: null, message: text };
}

// ── Req 6: Chat Title Generation ──────────────────────────────
function generateChatTitle(firstMsg, isStudy = true) {
    if (!firstMsg) return isStudy ? 'Study Session' : 'New Chat';
    const content = (firstMsg.content || '').trim();
    const hasImage = !!(firstMsg.image_url);
    const isImageOnly = !content || content === '📷 Image Message' || content === 'Solve this math problem from the image.';
    if (isStudy) {
        if (hasImage) return 'Study: Image Problem';
        if (isMathContent(content)) return 'Study: Math Problem';
        return 'Study Session';
    }
    if (hasImage && isImageOnly) return 'Image Analysis';
    if (hasImage) return 'Image: ' + truncateTitle(content, 30);
    if (isMathContent(content)) return 'Math: ' + truncateTitle(content, 30);
    return truncateTitle(content, 40) || 'General Chat';
}

function isMathContent(text) {
    if (!text) return false;
    const mathPatterns = /[∫∑√π∞±≠≈≥≤÷×∂∇θ∆αβγδε]|(\d+\s*[\+\-\*\/\^=]\s*\d)|solve|equation|integral|derivative|factor|simplif|calcul|limit|matrix|vector|polynomial|trigonometr|logarithm|sin\s*\(|cos\s*\(|tan\s*\(|log\s*\(|ln\s*\(/i;
    return mathPatterns.test(text);
}

function truncateTitle(text, maxLen) {
    if (!text) return '';
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    return clean.substring(0, maxLen).replace(/\s+\S*$/, '') + '…';
}

// ── Search Sources Renderer ──────────────────────────────────
function renderSearchSources(msgDiv, data) {
    if (!msgDiv || !data || !data.sources || data.sources.length === 0) return;
    const isYT = data.mode === 'YOUTUBE_SEARCH';
    const iconName = isYT ? 'smart_display' : 'public';
    let html = '<div class="search-sources-container" style="margin-top:16px;border-top:1px solid var(--border-color, #333);padding-top:12px;">';
    html += `<div style="font-size:12px;color:var(--text-secondary, #888);margin-bottom:10px;display:flex;align-items:center;gap:5px;"><span class="material-symbols-outlined" style="font-size:16px;">${iconName}</span>Sources</div>`;
    html += '<div style="display:flex;flex-wrap:wrap;gap:8px;">';
    data.sources.forEach(src => {
        let domain = '';
        try { domain = new URL(src.url).hostname.replace('www.', ''); } catch (e) { }
        html += `<a href="${src.url}" target="_blank" rel="noopener" style="display:flex;flex-direction:column;padding:8px 12px;background:var(--bg-secondary, #1a1a2e);border:1px solid var(--border-color, #333);border-radius:8px;text-decoration:none;max-width:200px;transition:all 0.2s;cursor:pointer;" onmouseover="this.style.borderColor='var(--primary, #e94560)';this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='var(--border-color, #333)';this.style.transform=''"><span style="font-size:13px;color:var(--text-primary, #eee);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${src.title}</span><span style="font-size:11px;color:var(--text-secondary, #888);">${domain}</span></a>`;
    });
    html += '</div></div>';
    const contentDiv = msgDiv.querySelector('.message-content');
    if (contentDiv) {
        const existing = contentDiv.querySelector('.search-sources-container');
        if (existing) existing.outerHTML = html;
        else {
            const textBody = contentDiv.querySelector('.text-body');
            if (textBody) textBody.insertAdjacentHTML('afterend', html);
            else contentDiv.innerHTML += html;
        }
    }
}
window.renderSearchSources = renderSearchSources;

// ── State ─────────────────────────────────────────────────────
const state = {
    timerMode: 'work',
    workDuration: 25 * 60,
    breakDuration: 5 * 60,
    timeRemaining: 25 * 60,
    isRunning: false,
    isFreeTimer: false,
    freeTimerElapsed: 0,
    timerInterval: null,
    sessionsCompleted: 0,
    totalDuration: 25 * 60,

    currentMode: 'study',
    isStreaming: false,
    isChatActive: false,
    currentSessionId: null,
    currentUserId: null,

    uploadedImageUrl: null,
    isUploading: false,

    // Study Agent Session
    activeStudySessionId: null,
    studyCorrectAnswer: null,
    studyOriginalQuestion: null,
    studyBranch: "algebra",
    studyHintsUsed: 0,
    studyDifficulty: "medium",
    studyProblemsSolved: 0,
    studyStreak: 0,
    graphMode: false
};

const $ = (id) => document.getElementById(id);

// ══════════════════════════════════════════════════════════════
// UNIVERSAL CONTENT EXTRACTOR
// Backend returns different keys per endpoint — map them all here.
//
// ROOT FIX: agent_message is now FIRST in the priority list.
// The v7 agent loop always produces agent_message as its final
// text response. All previous fixes were missing this key, which
// caused the "Session updated." fallback to appear whenever the
// LLM wrote a final response (the most common case).
// ══════════════════════════════════════════════════════════════
function extractContent(data) {
    if (!data || typeof data !== 'object') return '';

    // Priority order:
    // 1. agent_message  — v7 agent final text response (THE fix)
    // 2. display_markdown — fast paths (chat, explain, help)
    // 3. specific tool result fields — fallback if agent_message absent
    return (
        data.agent_message ||   // v7 agent loop final response ← ROOT FIX
        data.display_markdown ||   // fast paths (chat, explain, help)
        data.concept_explanation ||   // /study/start → explain tool
        data.socratic_question ||   // /study/start → socratic tool
        data.solve_output ||   // /study/solve
        data.hint_text ||   // /study/hint
        data.mistake_feedback ||   // /study/check (wrong answer)
        data.practice_problem ||   // /study/next, /study/next_harder
        data.session_summary ||   // /study/summary
        data.message ||   // generic fallback
        ''
    );
}

// Combine multiple fields when a response has more than one meaningful piece.
// agent_message already contains the combined final response from the agent,
// so we check it first and skip the multi-field join if it exists.
function extractStartContent(data) {
    // If the agent wrote a final message, use it directly — it already
    // combines concept explanation + socratic question in one response.
    if (data.agent_message) return data.agent_message;

    const parts = [];
    if (data.concept_explanation) parts.push(data.concept_explanation);
    if (data.socratic_question) parts.push(data.socratic_question);
    if (data.solve_output) parts.push(data.solve_output);
    return parts.join('\n\n') || extractContent(data);
}

function extractCheckContent(data) {
    // If the agent wrote a final message, use it directly — it already
    // combines feedback + socratic question / practice problem.
    if (data.agent_message) return data.agent_message;

    const parts = [];
    if (data.mistake_feedback) parts.push(data.mistake_feedback);
    if (data.socratic_question) parts.push(data.socratic_question);
    if (data.practice_problem) parts.push(data.practice_problem);
    return parts.join('\n\n') || extractContent(data);
}

//khairy update from 113 to 133 and 175 to 184
//(اضافة خاصية محادثات مود المذاكرة + خاصية الملاحظات والتاسكات )

// ── Study Session Registry ────────────────────────────────────
// We record every Study Mode session_id in localStorage so that
// any page (index, dashboard) can detect "this is a study session"
// and redirect to study-mode.html instead of loading in-place.

function tagSessionAsStudy(sessionId) {
    if (!sessionId) return;
    try {
        const map = JSON.parse(localStorage.getItem('study_sessions') || '{}');
        map[sessionId] = 'study';
        localStorage.setItem('study_sessions', JSON.stringify(map));
    } catch (e) { /* localStorage unavailable */ }
}

function isStudySession(sessionId) {
    if (!sessionId) return false;
    try {
        const map = JSON.parse(localStorage.getItem('study_sessions') || '{}');
        return map[sessionId] === 'study';
    } catch (e) { return false; }
}

// ── Auth & History ───────────────────────────────────────────

async function initAuthAndHistory() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        state.currentUserId = session.user.id;
        fetchHistory(session.user.id);
        // Analytics: hydrate lifetime totals (Solved / Accuracy / Hints /
        // Weak topics) from Supabase so the widget shows the student's
        // real numbers right after the page loads.
        try { studyAnalytics.setUser(session.user.id); } catch (_) {}
    }
    supabase.auth.onAuthStateChange(async (event, session) => {
        if (session) {
            state.currentUserId = session.user.id;
            fetchHistory(session.user.id);
            // Re-hydrate the analytics widget when the user signs in / token
            // refreshes. Idempotent — setUser bails if the userId hasn't
            // changed and the cloud row was already fetched.
            try { studyAnalytics.setUser(session.user.id); } catch (_) {}
        } else {
            state.currentUserId = null;
            // Analytics: wipe the per-user history so the next sign-in starts clean.
            try { studyAnalytics.setUser(null); } catch (_) {}
            const historyList = $('sidebar-history-list');
            if (historyList) historyList.innerHTML = '<li class="history-item" style="padding:10px; color:var(--text-muted);">Log in to see history</li>';
        }
    });

    const themeBtn = $('theme-toggle-btn');
    if (themeBtn) {
        themeBtn.addEventListener('click', () => {
            const isDark = document.documentElement.classList.toggle('dark-theme');
            document.body.classList.toggle('dark-theme', isDark);
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            const icon = themeBtn.querySelector('.theme-icon');
            if (icon) icon.textContent = isDark ? 'light_mode' : 'dark_mode';
        });
        const icon = themeBtn.querySelector('.theme-icon');
        if (icon) icon.textContent = document.documentElement.classList.contains('dark-theme') ? 'light_mode' : 'dark_mode';
    }

    $('sidebar-toggle-btn')?.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
            $('main-sidebar')?.classList.remove('mobile-open');
            $('sidebar-overlay')?.classList.remove('active');
        } else {
            $('main-sidebar')?.classList.toggle('collapsed');
        }
    });
    $('mobile-left-menu-btn')?.addEventListener('click', () => {
        const sidebar = $('main-sidebar');
        sidebar?.classList.add('mobile-open');
        sidebar?.classList.remove('collapsed');   // ← show hub pills & full sidebar content
        $('sidebar-overlay')?.classList.add('active');
    });
    const rightSidebar = $('study-right-sidebar');
    const setRightPanelOpen = (open) => {
        if (!rightSidebar) return;
        rightSidebar.classList.toggle('collapsed', !open);
        rightSidebar.setAttribute('aria-hidden', open ? 'false' : 'true');
    };
    const toggleRightPanel = () => setRightPanelOpen(rightSidebar?.classList.contains('collapsed') ?? true);
    $('toggle-right-panel')?.addEventListener('click', toggleRightPanel);
    $('close-right-panel')?.addEventListener('click', () => setRightPanelOpen(false));
    $('open-right-panel')?.addEventListener('click', () => setRightPanelOpen(true));
    // Req #7: compact header timer also toggles the study tools panel
    $('compact-timer')?.addEventListener('click', toggleRightPanel);
    $('sidebar-overlay')?.addEventListener('click', () => {
        $('main-sidebar')?.classList.remove('mobile-open');
        $('main-sidebar')?.classList.add('collapsed');
        $('sidebar-overlay')?.classList.remove('active');
    });

    // Close context menus on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.history-item')) {
            document.querySelectorAll('.history-options-menu.active').forEach(m => m.classList.remove('active'));
            document.querySelectorAll('.history-options-btn.active').forEach(b => b.classList.remove('active'));
        }
    });

    // ── URL param session restore ─────────────────────────────
    // If the page was opened with ?session=<id> (e.g. redirected from
    // a history link on index.html or dashboard.html), auto-load it.
    const urlParams = new URLSearchParams(window.location.search);
    const sessionParam = urlParams.get('session');
    if (sessionParam) {
        // Wait for auth to settle then load
        setTimeout(() => loadSession(sessionParam), 200);
    } else if (isPageReload()) {
        // Req #3: restore the user's last active Study Mode chat on refresh.
        const savedSession = getPersistedSession('study');
        if (savedSession && isStudySession(savedSession)) {
            setTimeout(() => loadSession(savedSession, { revertOnEmpty: true }), 200);
        }
    }
}

async function fetchHistory(userId) {
    const historyList = $('sidebar-history-list');
    if (!historyList) return;
    try {
        const { data: messages, error } = await supabase
            .from('messages').select('*').eq('user_id', userId)
            .order('created_at', { ascending: false }).limit(200);
        if (error) throw error;

        historyList.innerHTML = '';
        const seenSessions = new Set();
        const topSessions = [];
        const sessionFirstMsg = {};  // Req 6: track first (oldest) user msg

        // messages are newest-first; iterate backwards to find oldest user msg per session
        if (messages && messages.length > 0) {
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (!msg.session_id || msg.sender !== 'user') continue;
                if (!sessionFirstMsg[msg.session_id]) {
                    sessionFirstMsg[msg.session_id] = msg;
                }
            }
        }

        messages?.forEach(msg => {
            if (msg.session_id && !seenSessions.has(msg.session_id) && msg.sender === 'user') {
                seenSessions.add(msg.session_id);
                topSessions.push(msg);
            }
        });

        if (topSessions.length === 0) {
            historyList.innerHTML = '<li style="padding:10px; color:var(--text-muted); font-size:12px;">No recent chats</li>';
            return;
        }

        // Read chat session metadata for rename/pin/archive
        let sessionMeta = {};
        try { sessionMeta = JSON.parse(localStorage.getItem('chat_session_meta') || '{}'); } catch (e) { }

        // Filter out archived
        let displaySessions = topSessions.filter(s => {
            const meta = sessionMeta[s.session_id] || {};
            return !meta.archived;
        });

        // Sort pinned to top
        displaySessions.sort((a, b) => {
            const aPinned = sessionMeta[a.session_id]?.pinned ? 1 : 0;
            const bPinned = sessionMeta[b.session_id]?.pinned ? 1 : 0;
            return bPinned - aPinned;
        });

        const finalSessions = displaySessions.slice(0, 10);

        if (finalSessions.length === 0) {
            historyList.innerHTML = '<li style="padding:10px; color:var(--text-muted); font-size:12px;">No recent chats</li>';
            return;
        }

        finalSessions.forEach(session => {
            const sessionId = session.session_id;
            const meta = sessionMeta[sessionId] || {};

            // Req 6: Generate title from topic/category, not last message
            let autoTitle;
            if (meta.name) {
                autoTitle = meta.name;  // user-renamed — keep as-is
            } else {
                const firstMsg = sessionFirstMsg[sessionId] || session;
                autoTitle = generateChatTitle(firstMsg, true);
            }
            const displayName = autoTitle;

            const li = document.createElement('li');
            li.className = 'history-item';

            li.innerHTML = `<a href="#" class="history-link" data-id="${sessionId}"><span class="material-symbols-outlined" style="font-size:14px;flex-shrink:0;">${meta.pinned ? 'push_pin' : 'school'}</span><span class="history-text"></span></a>`;
            li.querySelector('.history-link').addEventListener('click', (e) => { e.preventDefault(); loadSession(sessionId); });
            li.querySelector('.history-text').textContent = displayName;

            // Add 3-dots Context Menu
            const optsBtn = document.createElement('button');
            optsBtn.className = 'history-options-btn';
            optsBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">more_horiz</span>';

            const optsMenu = document.createElement('div');
            optsMenu.className = 'history-options-menu';
            optsMenu.innerHTML = `
                <button data-action="share"><span class="material-symbols-outlined">share</span> Share</button>
                <button data-action="rename"><span class="material-symbols-outlined">edit</span> Rename</button>
                <button data-action="pin"><span class="material-symbols-outlined">push_pin</span> ${meta.pinned ? 'Unpin chat' : 'Pin chat'}</button>
                <button data-action="archive"><span class="material-symbols-outlined">archive</span> Archive</button>
                <button data-action="delete" class="delete-btn"><span class="material-symbols-outlined">delete</span> Delete</button>
            `;

            optsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.history-options-menu.active').forEach(m => {
                    if (m !== optsMenu) m.classList.remove('active');
                });
                document.querySelectorAll('.history-options-btn.active').forEach(b => {
                    if (b !== optsBtn) b.classList.remove('active');
                });
                optsMenu.classList.toggle('active');
                optsBtn.classList.toggle('active');
            });

            optsMenu.addEventListener('click', async (e) => {
                e.stopPropagation();
                const actionBtn = e.target.closest('button[data-action]');
                if (!actionBtn) return;

                const action = actionBtn.dataset.action;
                optsMenu.classList.remove('active');
                optsBtn.classList.remove('active');

                let currentMeta = {};
                try { currentMeta = JSON.parse(localStorage.getItem('chat_session_meta') || '{}'); } catch (err) { }
                if (!currentMeta[sessionId]) currentMeta[sessionId] = {};

                if (action === 'share') {
                    const url = new URL(window.location.origin + window.location.pathname);
                    url.searchParams.set('session', sessionId);
                    if (typeof window.showShareModal === 'function') {
                        window.showShareModal(url.toString());
                    }
                } else if (action === 'rename') {
                    const newName = (typeof window.showPromptModal === 'function')
                        ? await window.showPromptModal('Enter new chat name:', displayName)
                        : prompt('Enter new chat name:', displayName);
                    if (newName && newName.trim()) {
                        currentMeta[sessionId].name = newName.trim();
                        localStorage.setItem('chat_session_meta', JSON.stringify(currentMeta));
                        fetchHistory(userId);
                    }
                } else if (action === 'pin') {
                    currentMeta[sessionId].pinned = !currentMeta[sessionId].pinned;
                    localStorage.setItem('chat_session_meta', JSON.stringify(currentMeta));
                    fetchHistory(userId);
                } else if (action === 'archive') {
                    currentMeta[sessionId].archived = true;
                    localStorage.setItem('chat_session_meta', JSON.stringify(currentMeta));
                    fetchHistory(userId);
                } else if (action === 'delete') {
                    const confirmed = (typeof window.showConfirmModal === 'function')
                        ? await window.showConfirmModal('Are you sure you want to delete this chat session?')
                        : confirm('Are you sure you want to delete this chat session?');
                    if (confirmed) {
                        await supabase.from('messages').delete().eq('session_id', sessionId);
                        delete currentMeta[sessionId];
                        localStorage.setItem('chat_session_meta', JSON.stringify(currentMeta));
                        fetchHistory(userId);
                        if (state.currentSessionId === sessionId) {
                            state.currentSessionId = null;
                            state.isChatActive = false;
                            // Req #3: don't restore a deleted chat on next refresh.
                            clearPersistedSession('study');
                            const chatContainer = $('chat-messages');
                            if (chatContainer) chatContainer.innerHTML = '';
                            const studyHero = $('study-hero');
                            const studyChat = $('study-chat-active');
                            if (studyHero) studyHero.style.display = 'flex';
                            if (studyChat) studyChat.style.display = 'none';
                        }
                    }
                }
            });

            li.appendChild(optsBtn);
            li.appendChild(optsMenu);
            historyList.appendChild(li);
        });
    } catch (err) { console.error('History fetch error:', err); }
}

async function loadSession(sessionId, opts = {}) {
    state.currentSessionId = sessionId;
    state.isChatActive = true;
    // Analytics: hydrate the right-sidebar widget with THIS chat's stats so
    // switching history items no longer leaves stale "Solved / Accuracy /
    // Time" numbers from the previous chat. The store persists per-session
    // snapshots in localStorage, so brand-new chats just start clean.
    try { studyAnalytics.loadSession(sessionId); } catch (_) {}
    // Req #3: persist so a hard refresh restores the same Study Mode chat.
    persistActiveSession('study', sessionId);
    // Tag this as a study session in the registry
    tagSessionAsStudy(sessionId);
    $('study-hero').style.display = 'none';
    $('study-chat-active').style.display = 'flex';
    try {
        const { data: messages, error } = await supabase
            .from('messages').select('*').eq('session_id', sessionId)
            .order('created_at', { ascending: true });
        if (error) throw error;

        // Req #4: Share Chat — fall back to backend /shared_chat for users
        // who don't own this session (RLS would otherwise hide it).
        let resolvedMessages = messages;
        if ((!messages || messages.length === 0) && opts.allowShared !== false) {
            try {
                const API_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL)
                    ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '')
                    : (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');
                const res = await fetch(`${API_URL}/shared_chat/${encodeURIComponent(sessionId)}`);
                if (res.ok) {
                    const body = await res.json();
                    if (Array.isArray(body.messages) && body.messages.length > 0) {
                        resolvedMessages = body.messages;
                    }
                }
            } catch (sharedErr) {
                console.warn('[Share] /shared_chat fallback failed:', sharedErr);
            }
        }

        // Req #3: if a restored saved session has no messages (deleted from
        // another tab, or stale localStorage), drop back to the hero instead
        // of showing an empty chat view.
        if (opts.revertOnEmpty && (!resolvedMessages || resolvedMessages.length === 0)) {
            state.currentSessionId = null;
            state.isChatActive = false;
            clearPersistedSession('study');
            $('study-hero').style.display = 'flex';
            $('study-chat-active').style.display = 'none';
            return;
        }

        const chatContainer = $('chat-messages');
        chatContainer.innerHTML = '';
        (resolvedMessages || []).forEach(msg => addMessage(msg.content, msg.sender, msg.image_url));
    } catch (err) { console.error('Load session error:', err); }
}

async function saveMessageToSupabase(content, sender, imageUrl = null) {
    if (!state.currentUserId || !content) return;
    try {
        const payload = { user_id: state.currentUserId, session_id: state.currentSessionId, content, sender };
        if (imageUrl) payload.image_url = imageUrl;
        await supabase.from('messages').insert([payload]);
        fetchHistory(state.currentUserId);
    } catch (err) { console.error('Save message error:', err); }
}

// ── Image Upload ──────────────────────────────────────────────

function initImageUpload() {
    ['hero', 'chat'].forEach(type => {
        const dropZone = $(`${type}-drop-zone`);
        const input = $(`${type}-drop-zone-input`);
        dropZone?.addEventListener('click', () => input.click());
        input?.addEventListener('change', (e) => { const file = e.target.files[0]; if (file) handleFileUpload(file, type); });
        dropZone?.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone?.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file) handleFileUpload(file, type);
        });
        $(`${type}-remove-preview-btn`)?.addEventListener('click', () => {
            state.uploadedImageUrl = null;
            const wrapper = $(`${type}-image-preview-wrapper`);
            if (wrapper) {
                wrapper.style.display = 'none';
                wrapper.classList.remove('is-loading', 'is-ready');
            }
            $(`${type}-drop-zone`).style.display = 'block';
            if (input) input.value = '';
        });
    });
}

let uploadTimeout;

async function handleFileUpload(file, type) {
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
        if (typeof window.showAlertModal === 'function') {
            window.showAlertModal('Invalid File', 'Please upload an image or PDF file.');
        } else {
            alert('Please upload an image or PDF file.');
        }
        return;
    }

    if (uploadTimeout) clearTimeout(uploadTimeout);
    state.isUploading = true;
    const previewWrapper = $(`${type}-image-preview-wrapper`);
    const previewImg = $(`${type}-image-preview-thumbnail`);
    const dropZone = $(`${type}-drop-zone`);

    if (previewWrapper) {
        previewWrapper.style.display = 'flex';
        previewWrapper.classList.add('is-loading');
        previewWrapper.classList.remove('is-ready');
    }

    // Show image immediately if possible
    if (previewImg) {
        if (file.type === 'application/pdf') {
            previewImg.src = 'logo.png';
        } else {
            previewImg.src = URL.createObjectURL(file);
        }
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        // We still use the base64 result for state.uploadedImageUrl as expected by the backend logic
        state.uploadedImageUrl = e.target.result;

        // Small simulated delay for modern UX feel (so spinner is visible)
        uploadTimeout = setTimeout(() => {
            if (previewWrapper) {
                previewWrapper.classList.remove('is-loading');
                previewWrapper.classList.add('is-ready');
            }
            state.isUploading = false;
            uploadTimeout = null;
        }, 800);
    };

    reader.readAsDataURL(file);
}

// ── Chat & Mode Logic ─────────────────────────────────────────

function initChat() {
    const heroTabs = document.querySelectorAll('.gpt-tab');
    heroTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            heroTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            state.currentMode = tab.dataset.mode;
            syncModeUI(state.currentMode);
        });
    });

    ['hero', 'chat'].forEach(type => {
        const sendBtn = $(`${type}-send-btn`);
        const input = $(`${type}-search-input`);
        sendBtn?.addEventListener('click', () => handleSend(type));
        input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(type); } });
        input?.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; });
    });

    initModeDropdowns();
    bindStudyChatActions();
    initCalculator();
    initMathToolbar();
    initGraph();

    document.querySelectorAll('.topic-card').forEach(card => {
        card.addEventListener('click', () => {
            const topic = card.dataset.topic;
            const prompt = card.dataset.prompt;
            state.studyBranch = topic;
            state.currentMode = 'study';
            syncModeUI('study');
            const heroInput = $('hero-search-input');
            if (heroInput) heroInput.value = prompt;
            handleSend('hero');
        });
    });

    document.querySelectorAll('.quick-action-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const action = pill.dataset.action;
            state.currentMode = 'study';
            syncModeUI('study');
            const heroInput = $('hero-search-input');
            if (action === 'problem' && heroInput) heroInput.focus();
            else if (action === 'explain' && heroInput) heroInput.focus();
            else if (action === 'quiz-single') {
                // Single MCQ shows the simple branch picker (openBranchDiffMenu
                // hides the difficulty step for kind='single' since it doesn't
                // shape a 1-question pull) so the student explicitly chooses
                // the subject instead of always getting an algebra question.
                openBranchDiffMenu({
                    trigger: pill,
                    kind:    'single',
                    onStart: ({ branch, difficulty }) => {
                        transitionToChat();
                        state.studyBranch = branch;
                        state.studyDifficulty = difficulty;
                        studyAnalytics.startSession(state.currentSessionId, branch);
                        const draftText = (heroInput && heroInput.value ? heroInput.value : '').trim();
                        const sourceQuestion = state.studyOriginalQuestion || draftText || '';
                        openSingleQuizForCurrentQuestion({
                            branch,
                            difficulty,
                            sourceQuestion,
                        });
                    },
                });
            }
            else if (action === 'quiz-test') {
                // Practice Test opens the full setup drawer (Topic chips +
                // Difficulty cards + Number-of-questions stepper + Time
                // Limit toggle) defined in study-mode.html (#qp-drawer /
                // #qp-screen-setup). Wired to window.openPracticeDrawer.
                if (typeof window.openPracticeDrawer === 'function') {
                    window.openPracticeDrawer();
                }
            }
        });
    });

    const heroMathToggle = $('hero-math-keyboard-toggle');
    const mathToolbar = $('math-toolbar');
    if (heroMathToggle && mathToolbar) {
        heroMathToggle.addEventListener('click', () => {
            const isVisible = mathToolbar.classList.toggle('visible');
            heroMathToggle.classList.toggle('active', isVisible);
            const chatMathToggle = $('chat-math-keyboard-toggle');
            if (chatMathToggle) chatMathToggle.classList.toggle('active', isVisible);
        });
    }

    // ── Graph Mode (inline — MathGPT-style) ──────────────────────
    let graphBubbleCounter = 0;

    // Define toggleGraphMode for study-mode
    window.toggleGraphMode = function () {
        state.graphMode = !state.graphMode;

        const heroBadge = $('hero-graph-mode-badge');
        const chatBadge = $('chat-graph-mode-badge');
        const heroBtn = $('hero-tool-create-graph');
        const chatBtn = $('chat-tool-create-graph');
        const heroInput = $('hero-search-input');
        const chatInput = $('chat-search-input');

        if (state.graphMode) {
            if (heroBadge) heroBadge.style.display = 'flex';
            if (chatBadge) chatBadge.style.display = 'flex';
            if (heroBtn) heroBtn.classList.add('active');
            if (chatBtn) chatBtn.classList.add('active');
            if (heroInput) {
                heroInput.placeholder = 'Enter equation: e.g. sin(x), x^2 + 3x - 2, cos(x)*exp(-x/5)';
                heroInput.classList.add('graph-mode-input');
            }
            if (chatInput) {
                chatInput.placeholder = 'Enter equation: e.g. sin(x), x^2 + 3x - 2, cos(x)*exp(-x/5)';
                chatInput.classList.add('graph-mode-input');
            }
            // Focus active input
            if (state.isChatActive && chatInput) chatInput.focus();
            else if (heroInput) heroInput.focus();
        } else {
            if (heroBadge) heroBadge.style.display = 'none';
            if (chatBadge) chatBadge.style.display = 'none';
            if (heroBtn) heroBtn.classList.remove('active');
            if (chatBtn) chatBtn.classList.remove('active');
            if (heroInput) {
                heroInput.placeholder = 'Type your question here…';
                heroInput.classList.remove('graph-mode-input');
            }
            if (chatInput) {
                chatInput.placeholder = 'Ask MATHX…';
                chatInput.classList.remove('graph-mode-input');
            }
        }
    };

    // Legacy compat
    window.toggleGraphBar = window.toggleGraphMode;

    // Wire Create Graph buttons
    const heroGraphBtn = $('hero-tool-create-graph');
    if (heroGraphBtn) heroGraphBtn.addEventListener('click', () => window.toggleGraphMode());
    const chatGraphBtn = $('chat-tool-create-graph');
    if (chatGraphBtn) chatGraphBtn.addEventListener('click', () => window.toggleGraphMode());

    // Plot function into study mode chat
    window.plotFnToChat = function (expr) {
        if (!expr || !expr.trim()) return;
        expr = expr.trim();

        transitionToChat();
        maybeGenerateChatTitle(state.currentSessionId, `Plot ${expr}`, false);

        const chatMessages = $('chat-messages');

        // User message
        const userDiv = document.createElement('div');
        userDiv.classList.add('message', 'user-message');
        userDiv.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: flex-end; width: 100%;">
                <div class="message-content" style="max-width: 100%;">
                    <div class="text-body"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px;color:var(--primary);">show_chart</span>Plot: ${escapeHtml(expr)}</div>
                </div>
            </div>
            <div class="message-avatar">
                <img src="user.png" alt="User">
            </div>`;
        chatMessages.appendChild(userDiv);
        saveMessageToSupabase(`📈 Plotting: ${expr}`, 'user');

        // AI message with graph
        const bubbleId = `ggb-study-${++graphBubbleCounter}`;
        const aiDiv = document.createElement('div');
        aiDiv.classList.add('message', 'ai-message');
        aiDiv.innerHTML = `
            <div class="message-avatar"><img src="logo.png" alt="AI"></div>
            <div class="message-content" style="max-width:640px; width:100%;">
                <div class="ai-name">MATHX</div>
                <div class="graph-equation-label">
                    <span class="material-symbols-outlined" style="font-size:18px;">show_chart</span>
                    <span>f(x) = ${escapeHtml(expr)}</span>
                </div>
                <div class="graph-container-wrapper">
                    <div class="graph-loading" id="${bubbleId}-loading">
                        <div class="graph-loading-spinner"></div>
                        <span>Loading graph...</span>
                    </div>
                    <div id="${bubbleId}" style="width:100%; height:420px;"></div>
                </div>
                <div class="message-actions">
                    <button class="action-btn" data-action="copy" title="Copy equation">
                        <span class="material-symbols-outlined">content_copy</span>
                    </button>
                </div>
            </div>`;
        chatMessages.appendChild(aiDiv);
        saveMessageToSupabase(`📈 f(x) = ${expr}`, 'ai');

        const scrollWrapper = $('study-chat-messages-wrapper');
        if (scrollWrapper) scrollWrapper.scrollTop = scrollWrapper.scrollHeight;

        // Load GeoGebra
        setTimeout(() => {
            const container = document.getElementById(bubbleId);
            const loadingEl = document.getElementById(bubbleId + '-loading');
            if (!container) return;

            const appletParams = {
                appName: 'graphing',
                width: container.offsetWidth || 560,
                height: 420,
                showToolBar: false,
                showAlgebraInput: true,
                showMenuBar: false,
                enableRightClick: false,
                scaleContainerClass: 'graph-container-wrapper',
                appletOnLoad: (api) => {
                    api.evalCommand('f(x) = ' + expr);
                    if (loadingEl) loadingEl.style.display = 'none';
                },
            };

            if (typeof GGBApplet !== 'undefined') {
                new GGBApplet(appletParams, true).inject(bubbleId);
            } else {
                const script = document.createElement('script');
                script.src = 'https://www.geogebra.org/apps/deployggb.js';
                script.onload = () => new GGBApplet(appletParams, true).inject(bubbleId);
                script.onerror = () => {
                    if (loadingEl) loadingEl.style.display = 'none';
                    container.innerHTML = `
                        <div style="padding:30px;text-align:center;color:var(--text-muted);">
                            <span class="material-symbols-outlined" style="font-size:48px;display:block;margin-bottom:12px;opacity:0.5;">error_outline</span>
                            <p>Failed to load graphing engine.</p>
                            <p style="font-size:12px;margin-top:8px;">Please check your internet connection.</p>
                        </div>`;
                };
                document.head.appendChild(script);
            }
        }, 300);
    };
}

function bindStudyChatActions() {
    const chatMessages = $('chat-messages');
    chatMessages?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const msgEl = btn.closest('.message');
        const msgContent = msgEl?.querySelector('.message-content');

        if (action === 'copy') {
            const text = msgContent?.querySelector('.text-body')?.textContent;
            if (text) navigator.clipboard.writeText(text).catch(() => { });
        } else if (action === 'copy-user') {
            const text = msgContent?.querySelector('.text-body')?.textContent;
            if (text) navigator.clipboard.writeText(text).catch(() => { });
        } else if (action === 'regenerate') {
            const ci = $('chat-search-input');
            if (ci && state.studyOriginalQuestion) {
                let prev = msgEl.previousElementSibling;
                let carriedReplyQuote = null;
                if (prev && prev.classList.contains('user-message')) {
                    carriedReplyQuote = prev.dataset?.replyQuote || null;
                    let next = prev.nextElementSibling;
                    while (next) { const toRemove = next; next = next.nextElementSibling; toRemove.remove(); }
                    prev.remove();
                } else {
                    let next = msgEl.nextElementSibling;
                    while (next) { const toRemove = next; next = next.nextElementSibling; toRemove.remove(); }
                    if (msgEl.parentNode) msgEl.remove();
                }

                ci.value = state.studyOriginalQuestion;
                if (carriedReplyQuote) window.replyContext = carriedReplyQuote;
                handleSend('chat');
            }
        } else if (action === 'like') {
            btn.classList.toggle('liked');
            const isLiked = btn.classList.contains('liked');
            const icon = btn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = isLiked ? 'thumb_up' : 'thumb_up_off_alt';

            // Handle saving/removing the solution
            const textToSave = msgContent?.querySelector('.text-body')?.textContent || '';
            let savedSolutions = [];
            try { savedSolutions = JSON.parse(localStorage.getItem('study_saved_solutions') || '[]'); } catch (e) { }

            if (isLiked && textToSave) {
                // Check if already saved to avoid duplicates
                if (!savedSolutions.some(s => s.content === textToSave)) {
                    savedSolutions.push({
                        id: Date.now().toString(),
                        content: textToSave,
                        date: new Date().toISOString()
                    });
                }
            } else if (!isLiked && textToSave) {
                savedSolutions = savedSolutions.filter(s => s.content !== textToSave);
            }
            localStorage.setItem('study_saved_solutions', JSON.stringify(savedSolutions));

            const dislikeBtn = btn.parentElement?.querySelector('[data-action="dislike"]');
            if (dislikeBtn?.classList.contains('disliked')) {
                dislikeBtn.classList.remove('disliked');
                const di = dislikeBtn.querySelector('.material-symbols-outlined');
                if (di) di.textContent = 'thumb_down_off_alt';
            }
        } else if (action === 'dislike') {
            btn.classList.toggle('disliked');
            const icon = btn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = btn.classList.contains('disliked') ? 'thumb_down' : 'thumb_down_off_alt';
            const likeBtn = btn.parentElement?.querySelector('[data-action="like"]');
            if (likeBtn?.classList.contains('liked')) {
                likeBtn.classList.remove('liked');
                const li = likeBtn.querySelector('.material-symbols-outlined');
                if (li) li.textContent = 'thumb_up_off_alt';
            }
        } else if (action === 'edit-user') {
            const textBody = msgContent?.querySelector('.text-body');
            const actionsInline = msgEl?.querySelector('.message-actions-inline');
            if (!textBody) return;
            const originalText = textBody.textContent;
            const editContainer = document.createElement('div');
            editContainer.className = 'user-edit-container';
            editContainer.innerHTML = `
                <textarea class="user-edit-box" style="width:100%;min-width:250px;min-height:80px;background:var(--bg-primary);border:1px solid var(--border-color);color:var(--text-primary);border-radius:8px;padding:12px;font-family:inherit;font-size:14px;outline:none;resize:vertical;margin-bottom:8px;">${originalText}</textarea>
                <div style="display:flex;gap:8px;justify-content:flex-end;">
                    <button class="edit-cancel-btn" type="button" style="padding:6px 12px;background:transparent;border:1px solid var(--border-color);color:var(--text-secondary);border-radius:6px;cursor:pointer;">Cancel</button>
                    <button class="edit-save-btn" type="button" style="padding:6px 14px;background:var(--primary);color:#fff;border:none;border-radius:6px;font-weight:500;cursor:pointer;">Save & Submit</button>
                </div>`;
            textBody.style.display = 'none';
            if (actionsInline) actionsInline.style.display = 'none';
            textBody.parentNode.insertBefore(editContainer, textBody);
            const textarea = editContainer.querySelector('textarea');
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            editContainer.querySelector('.edit-cancel-btn').addEventListener('click', () => {
                editContainer.remove(); textBody.style.display = '';
                if (actionsInline) actionsInline.style.display = 'flex';
            });
            editContainer.querySelector('.edit-save-btn').addEventListener('click', () => {
                const newText = textarea.value.trim();
                if (!newText) return;
                textBody.textContent = newText;
                editContainer.remove();
                textBody.style.display = '';
                if (actionsInline) actionsInline.style.display = 'flex';
                const ci = $('chat-search-input');
                if (ci) ci.value = newText;
                // Preserve reply quote on edit so the rerun keeps the context
                const carriedReplyQuote = msgEl?.dataset?.replyQuote || null;
                let next = msgEl.nextElementSibling;
                while (next) { const toRemove = next; next = next.nextElementSibling; toRemove.remove(); }
                msgEl.remove();
                if (carriedReplyQuote) window.replyContext = carriedReplyQuote;
                handleSend('chat');
            });
        } else if (action === 'resend-user') {
            const text = msgContent?.querySelector('.text-body')?.textContent;
            if (text) {
                // Preserve reply quote on resend
                const carriedReplyQuote = msgEl?.dataset?.replyQuote || null;
                let next = msgEl.nextElementSibling;
                while (next) { const toRemove = next; next = next.nextElementSibling; toRemove.remove(); }
                msgEl.remove();

                const ci = $('chat-search-input');
                if (ci) ci.value = text;
                if (carriedReplyQuote) window.replyContext = carriedReplyQuote;
                handleSend('chat');
            }
        }
    });
}

function buildQuizContextHintFor(branch, sourceQuestion) {
    const hintParts = [];
    hintParts.push(capitalizeFirst(branch || 'algebra'));
    if (sourceQuestion) {
        const q = String(sourceQuestion).replace(/\s+/g, ' ').trim();
        if (q.length > 0) hintParts.push(q.length > 80 ? q.slice(0, 77) + '…' : q);
    }
    return hintParts.join(' · ');
}

function buildQuizContextHint() {
    return buildQuizContextHintFor(
        state.studyBranch || 'algebra',
        state.studyOriginalQuestion ? String(state.studyOriginalQuestion).trim() : '',
    );
}

function openSingleQuizForCurrentQuestion(options = {}) {
    const branch = options.branch || state.studyBranch || 'algebra';
    const difficulty = options.difficulty || state.studyDifficulty || 'medium';
    const sourceQuestion = options.sourceQuestion != null
        ? String(options.sourceQuestion || '').trim()
        : (state.studyOriginalQuestion ? String(state.studyOriginalQuestion).trim() : '');
    openQuizPanel({
        branch,
        difficulty,
        count: 1,
        contextHint: buildQuizContextHintFor(branch, sourceQuestion),
        sourceQuestion,
        adaptive: false,
    });
}

function initModeDropdowns() {
    ['hero', 'chat'].forEach(type => {
        const btn = $(`${type}-mode-btn`) || $(`${type}-mode-dropdown-btn`);
        const menu = $(`${type}-mode-dropdown-menu`);
        btn?.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('active'); });
        menu?.querySelectorAll('.mode-option').forEach(opt => {
            opt.addEventListener('click', () => { state.currentMode = opt.dataset.mode; syncModeUI(state.currentMode); menu.classList.remove('active'); });
        });
    });
    document.addEventListener('click', () => document.querySelectorAll('.mode-dropdown-menu').forEach(m => m.classList.remove('active')));
}

function syncModeUI(mode) {
    document.querySelectorAll('.gpt-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
    ['hero', 'chat'].forEach(type => {
        const btn = $(`${type}-mode-btn`) || $(`${type}-mode-dropdown-btn`);
        if (!btn) return;
        const text = btn.querySelector('.dropdown-text');
        const icon = btn.querySelector('.dropdown-icon');
        const label = mode === 'think' ? 'Deep Think' : (mode === 'steps' ? 'Steps' : (mode === 'study' ? 'Study Agent' : 'General'));
        const iconName = mode === 'think' ? 'psychology' : (mode === 'steps' ? 'format_list_numbered' : (mode === 'study' ? 'school' : 'auto_awesome'));
        if (text) text.textContent = label;
        if (icon) icon.textContent = iconName;
        $(`${type}-mode-dropdown-menu`)?.querySelectorAll('.mode-option').forEach(opt => opt.classList.toggle('active', opt.dataset.mode === mode));
    });
}

function transitionToChat() {
    if (!state.isChatActive) {
        state.isChatActive = true;
        const studyHero = $('study-hero');
        const studyChat = $('study-chat-active');
        if (studyHero) studyHero.style.display = 'none';
        if (studyChat) studyChat.style.display = 'flex';
    }
    if (!state.currentSessionId) {
        state.currentSessionId = generateUUID();
        // Tag the new session as a Study Mode session so other pages
        // (index.html, dashboard.html) can redirect to study-mode.html
        tagSessionAsStudy(state.currentSessionId);
        // Analytics: hop the right-sidebar widget to this brand-new session
        // so its numbers (Solved / Accuracy / Time) don't inherit from the
        // previous chat that was on screen. studyAnalytics.startSession is
        // still called later when the user actually starts a study run.
        try { studyAnalytics.loadSession(state.currentSessionId); } catch (_) {}
    }
    // Req #3: remember this session so a hard refresh restores the same chat.
    persistActiveSession('study', state.currentSessionId);
}

// Req #6: Generate a topic-based chat title on first message of a session.
// Fire-and-forget: saves into chat_session_meta so the sidebar picks it up.
// Falls back to a non-empty label when the first message is image-only.
async function maybeGenerateChatTitle(sessionId, firstText, hasImage) {
    if (!sessionId) return;
    let meta = {};
    try { meta = JSON.parse(localStorage.getItem('chat_session_meta') || '{}'); } catch (e) {}
    if (meta[sessionId]?.name) return;  // already titled

    const textForTitle = (firstText || '').trim() || (hasImage ? 'Math problem from an image' : '');
    if (!textForTitle) return;

    try {
        const API_URL = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL
            ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '')
            : (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');
        const res = await fetch(`${API_URL}/generate_title`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: textForTitle }),
        });
        if (!res.ok) throw new Error('Title endpoint returned ' + res.status);
        const data = await res.json();
        const title = (data.title || '').trim();
        if (!title) return;

        let currentMeta = {};
        try { currentMeta = JSON.parse(localStorage.getItem('chat_session_meta') || '{}'); } catch (e) {}
        currentMeta[sessionId] = { ...(currentMeta[sessionId] || {}), name: title };
        localStorage.setItem('chat_session_meta', JSON.stringify(currentMeta));
        // Refresh sidebar so the new title appears immediately
        if (state.currentUserId) fetchHistory(state.currentUserId);
    } catch (err) {
        // Quietly fall back — sidebar will use meta.name || first message content.
        console.warn('[Title] generate_title failed:', err);
    }
}

// ══════════════════════════════════════════════════════════════
// MAIN SEND
// ══════════════════════════════════════════════════════════════

async function handleSend(type) {
    if (state.isStreaming) return;
    const input = $(`${type}-search-input`);
    const text = input?.value?.trim() || '';  // ✅ FIX (W-09): null-safe access
    const imageUrl = state.uploadedImageUrl;

    // ── Graph Mode Intercept ──
    if (state.graphMode && text) {
        input.value = '';
        input.style.height = 'auto';
        if (typeof window.plotFnToChat === 'function') {
            window.plotFnToChat(text);
        }
        // Auto-exit graph mode
        if (typeof window.toggleGraphMode === 'function') {
            window.toggleGraphMode();
        }
        return;
    }

    if (!text && !imageUrl) return;

    // ── Reply Context (Req: Reply to Message) ─────────────────
    // Capture and clear immediately so the bar disappears as soon as
    // the user hits Send. The contextualized text is forwarded to
    // every backend endpoint via apiText below.
    const replyCtx = window.replyContext || null;
    if (replyCtx && typeof window.clearReplyContext === 'function') {
        window.clearReplyContext();
    } else if (replyCtx) {
        window.replyContext = null;
    }
    const apiText = replyCtx
        ? `[User is replying to this specific part of your previous response: "${replyCtx}"]\n\n${text}`
        : text;

    // ── Guest usage limits (Req #1) ────────────────────────────
    // Non-authenticated users: 2 messages total, 5 image uploads/day.
    if (!state.currentUserId) {
        const msgCount = parseInt(localStorage.getItem('guest_msg_count') || '0');
        if (msgCount >= 2) {
            if (typeof window.showAlertModal === 'function') {
                window.showAlertModal('Authentication required', 'Please log in or create an account');
            } else {
                alert('Please log in or create an account');
            }
            return;
        }
        if (imageUrl) {
            const today = new Date().toISOString().split('T')[0];
            let guestImgData = {};
            try { guestImgData = JSON.parse(localStorage.getItem('guest_img_uploads') || '{}'); } catch (e) { }
            const imgCount = guestImgData[today] || 0;
            if (imgCount >= 5) {
                if (typeof window.showAlertModal === 'function') {
                    window.showAlertModal('Limit Reached', 'You have reached the daily image upload limit');
                } else {
                    alert('You have reached the daily image upload limit');
                }
                return;
            }
            guestImgData[today] = imgCount + 1;
            localStorage.setItem('guest_img_uploads', JSON.stringify(guestImgData));
        }
        localStorage.setItem('guest_msg_count', String(msgCount + 1));
    }

    if (state.currentMode === 'study') return handleStudySend(text, imageUrl, type, apiText);

    transitionToChat();
    maybeGenerateChatTitle(state.currentSessionId, text, !!imageUrl);
    input.value = '';
    input.style.height = 'auto';
    const previewWrapper = $(`${type}-image-preview-wrapper`);
    if (previewWrapper) {
        previewWrapper.style.display = 'none';
        previewWrapper.classList.remove('is-loading', 'is-ready');
    }
    state.uploadedImageUrl = null;
    const dropZoneInput = $(`${type}-drop-zone-input`);
    if (dropZoneInput) dropZoneInput.value = '';

    // Save the prefixed text so the chat persists the reply quote
    // across reloads (the bubble parses it back when rendering).
    const messageForBubble = replyCtx
        ? `[User is replying to this specific part of your previous response: "${replyCtx}"]\n\n${text || ''}`
        : text;
    addMessage(messageForBubble, 'user', imageUrl);
    saveMessageToSupabase(messageForBubble || '📷 Image Message', 'user', imageUrl);

    const aiMsgDiv = addMessage('', 'ai');
    const aiTextDiv = aiMsgDiv.querySelector('.text-body');
    aiTextDiv.innerHTML = `
        <div class="stream-skeleton" data-role="skeleton">
            <div class="skeleton skeleton-line" style="width:70%"></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line" style="width:45%"></div>
        </div>`;

    state.isStreaming = true;
    let fullResponse = '';
    let gotFirstToken = false;

    try {
        const API_URL = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '') : (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');
        const response = await fetch(`${API_URL}/solve_stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: apiText || 'Solve this math problem from the image.', image_data: imageUrl, mode: state.currentMode, session_id: state.currentSessionId, user_id: state.currentUserId, history: [] })
        });

        // ✅ FIX (H-03): Check response status before reading body
        if (!response.ok) throw new Error(`Server Error: ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sourcesObj = null;
        let buffer = '';  // ✅ FIX (H-10): SSE buffer for cross-chunk parsing

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, idx).trimEnd();
                buffer = buffer.slice(idx + 1);
                if (!line.startsWith('data:')) continue;
                const dataStr = line.replace(/^data:\s*/, '').trim();
                if (!dataStr || dataStr === '[DONE]') continue;
                try {
                    const data = JSON.parse(dataStr);
                    if (data.content) {
                        if (data.content.includes('__SEARCH_SOURCES__')) {
                            const match = data.content.match(/```json\n__SEARCH_SOURCES__\n([\s\S]*?)\n```/);
                            if (match) sourcesObj = JSON.parse(match[1]);
                            continue;
                        }
                        if (!gotFirstToken) { gotFirstToken = true; aiTextDiv.querySelector('[data-role="skeleton"]')?.remove(); }
                        fullResponse += data.content;
                        if (fullResponse.includes('<!-- SEARCH_DONE -->')) {
                            fullResponse = fullResponse.replace('is-active', '').replace('Searching ', 'Searched ').replace(/<!-- SEARCH_DONE -->\n*/g, '');
                        }
                        let bufferedResponse = fullResponse;
                        if ((bufferedResponse.match(/\$\$/g) || []).length % 2 !== 0) bufferedResponse += '$$';
                        if ((bufferedResponse.match(/\\\[/g) || []).length > (bufferedResponse.match(/\\\]/g) || []).length) bufferedResponse += '\\]';
                        if ((bufferedResponse.match(/```/g) || []).length % 2 !== 0) bufferedResponse += '\n```';
                        aiTextDiv.innerHTML = formatMessage(bufferedResponse) + '<span class="typing-cursor" aria-hidden="true"></span>';
                        const wrapper = $('study-chat-messages-wrapper');
                        if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
                    }
                } catch (e) { /* partial JSON, ignore */ }
            }
        }
        if (fullResponse) saveMessageToSupabase(fullResponse, 'ai');
    } catch (err) {
        console.error('[Study stream] Error:', err);
        aiTextDiv.innerHTML = '<span style="color:var(--primary);">Error connecting to server. Please try again.</span>';
    } finally {
        state.isStreaming = false;
        aiTextDiv.innerHTML = formatMessage(fullResponse);
        if (typeof sourcesObj !== 'undefined' && sourcesObj && sourcesObj.sources) {
            if (window.renderSearchSources) window.renderSearchSources(aiMsgDiv, sourcesObj);
        }
    }
}

// ══════════════════════════════════════════════════════════════
// STUDY SEND — FIXED
// ══════════════════════════════════════════════════════════════

async function handleStudySend(text, imageUrl, type, apiTextOverride) {
    const input = $(`${type}-search-input`);
    input.value = '';
    input.style.height = 'auto';
    const previewWrapper = $(`${type}-image-preview-wrapper`);
    if (previewWrapper) previewWrapper.style.display = 'none';
    const dropZone = $(`${type}-drop-zone`);
    if (dropZone) dropZone.style.display = 'block';
    state.uploadedImageUrl = null;
    const dropZoneInput = $(`${type}-drop-zone-input`);
    if (dropZoneInput) dropZoneInput.value = '';

    transitionToChat();
    maybeGenerateChatTitle(state.currentSessionId, text, !!imageUrl);

    // ── Reply Context (Req: Reply to Message) ─────────────────
    // apiText is the contextualized question to forward to backends.
    // The bubble shows a quote block + the user's typed text.
    const apiText = apiTextOverride || text;
    const replyPrefixMatch = (apiText !== text)
        ? apiText.match(/^\[User is replying to this specific part of your previous response: "([\s\S]*?)"\]\n\n/)
        : null;
    const replyQuoted = replyPrefixMatch ? replyPrefixMatch[1] : null;
    const wrapWithReply = (q) => replyQuoted
        ? `[User is replying to this specific part of your previous response: "${replyQuoted}"]\n\n${q}`
        : q;

    // Build the bubble/storage text so the quote block renders and
    // persists in Supabase across reloads.
    const userTextForBubble = replyQuoted
        ? wrapWithReply(text || '')
        : (text || '📷 Image Message');
    const userTextForStorage = replyQuoted
        ? wrapWithReply(text || '')
        : (text || '📷 Image Message');
    addMessage(userTextForBubble, 'user', imageUrl);
    saveMessageToSupabase(userTextForStorage, 'user', imageUrl);

    const aiMsgDiv = addMessage('', 'ai');
    const aiTextDiv = aiMsgDiv.querySelector('.text-body');
    showSkeleton(aiTextDiv);

    state.isStreaming = true;
    const API_URL = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '') : (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');

    try {
        // ── FIX 2: Classify LOCALLY — no API call needed ──────────
        // The backend classify endpoint is slow (LLM call).
        // We use the same fast regex logic here in JS.
        const intent = classifyIntentLocal(text, imageUrl);

        // ── FAST PATHS ────────────────────────────────────────────
        if (intent === 'search') {
            const res = await fetch(`${API_URL}/solve_stream`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: apiText, mode: 'general', user_id: state.currentUserId })
            });
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let fullResponse = '';
            let gotFirstToken = false;
            let sourcesObj = null;
            let sseBuffer = '';  // ✅ FIX (H-10): SSE buffer for search stream

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                sseBuffer += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = sseBuffer.indexOf('\n')) !== -1) {
                    const line = sseBuffer.slice(0, idx).trimEnd();
                    sseBuffer = sseBuffer.slice(idx + 1);
                    if (!line.startsWith('data:')) continue;
                    const dataStr = line.replace(/^data:\s*/, '').trim();
                    if (!dataStr || dataStr === '[DONE]') continue;
                    try {
                        const data = JSON.parse(dataStr);
                        if (data.content) {
                            if (data.content.includes('__SEARCH_SOURCES__')) {
                                const match = data.content.match(/```json\n__SEARCH_SOURCES__\n([\s\S]*?)\n```/);
                                if (match) sourcesObj = JSON.parse(match[1]);
                                continue;
                            }
                            if (!gotFirstToken) { gotFirstToken = true; aiTextDiv.querySelector('[data-role="skeleton"]')?.remove(); }
                            fullResponse += data.content;
                            if (fullResponse.includes('<!-- SEARCH_DONE -->')) {
                                fullResponse = fullResponse.replace('is-active', '').replace('Searching ', 'Searched ').replace(/<!-- SEARCH_DONE -->\n*/g, '');
                            }
                            let bufferedResponse = fullResponse;
                            if ((bufferedResponse.match(/\$\$/g) || []).length % 2 !== 0) bufferedResponse += '$$';
                            if ((bufferedResponse.match(/\\\[/g) || []).length > (bufferedResponse.match(/\\\]/g) || []).length) bufferedResponse += '\\]';
                            if ((bufferedResponse.match(/```/g) || []).length % 2 !== 0) bufferedResponse += '\n```';
                            aiTextDiv.innerHTML = formatMessage(bufferedResponse) + '<span class="typing-cursor" aria-hidden="true"></span>';
                            const wrapper = $('study-chat-messages-wrapper');
                            if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
                        }
                    } catch (e) { /* partial JSON */ }
                }
            }

            aiTextDiv.innerHTML = formatMessage(fullResponse);
            if (sourcesObj && sourcesObj.sources && sourcesObj.sources.length > 0) {
                renderSearchSources(aiMsgDiv, sourcesObj);
            }
            saveMessageToSupabase(fullResponse, 'ai');
            state.isStreaming = false;
            return;
        }

        if (intent === 'casual') {
            const res = await fetch(`${API_URL}/study/chat`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: apiText, user_id: state.currentUserId, image_data: imageUrl })
            });
            const data = await res.json();
            const content = extractContent(data);
            aiTextDiv.innerHTML = formatMessage(content);
            // Issue #6: an identity question or greeting mid-session should NOT
            // strip the session controls. Re-append Hint/Solve/End so the
            // student can keep working after the aside.
            if (state.activeStudySessionId) appendStudyActions(aiMsgDiv, 'active');
            saveMessageToSupabase(content, 'ai');
            state.isStreaming = false;
            return;
        }

        // ✅ FIX (M-03): Handle explain/help both with and without active sessions
        if (intent === 'explain') {
            const res = await fetch(`${API_URL}/study/explain`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: apiText, branch: state.studyBranch, user_id: state.currentUserId, image_data: imageUrl })
            });
            const data = await res.json();
            const content = extractContent(data);
            aiTextDiv.innerHTML = formatMessage(content);
            // If we're in an active session, keep showing action buttons
            if (state.activeStudySessionId) appendStudyActions(aiMsgDiv, 'active');
            saveMessageToSupabase(content, 'ai');
            state.isStreaming = false;
            return;
        }

        if (intent === 'help') {
            // For help in an active session, still use studyOriginalQuestion
            // but if there's a reply context, prepend it so the LLM has the snippet.
            const helpQuestion = state.activeStudySessionId ? (state.studyOriginalQuestion || text) : text;
            const res = await fetch(`${API_URL}/study/help`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: wrapWithReply(helpQuestion), branch: state.studyBranch, user_id: state.currentUserId, image_data: imageUrl })
            });
            const data = await res.json();
            const content = extractContent(data);
            aiTextDiv.innerHTML = formatMessage(content);
            // If we're in an active session, keep showing action buttons
            if (state.activeStudySessionId) appendStudyActions(aiMsgDiv, 'active');
            saveMessageToSupabase(content, 'ai');
            state.isStreaming = false;
            return;
        }

        // ── GIVE UP / SHOW ANSWER ─────────────────────────────────
        if (intent === 'giveup' && state.activeStudySessionId) {
            const res = await fetch(`${API_URL}/study/solve`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ session_id: state.activeStudySessionId, question: state.studyOriginalQuestion, branch: state.studyBranch, user_id: state.currentUserId })
            });
            const data = await res.json();
            const content = extractContent(data);
            aiTextDiv.innerHTML = formatMessage(content);
            appendStudyActions(aiMsgDiv, 'solved');
            saveMessageToSupabase(content, 'ai');
            state.isStreaming = false;
            return;
        }

        // ── NEW SESSION ───────────────────────────────────────────
        if (!state.activeStudySessionId) {
            state.studyOriginalQuestion = text || 'Solve this math problem from the image.';
            // ✅ FIX (M-04): Auto-detect math branch from user input instead of always defaulting to 'algebra'
            state.studyBranch = detectBranchLocal(text) || state.studyBranch || 'algebra';
            state.studyHintsUsed = 0;
            state.studyCorrectAnswer = '';   // will be fetched lazily

            // FIX 2: REMOVED /solve pre-call — was causing ~3-4s extra delay
            // Correct answer is now fetched lazily when student submits first attempt

            const startRes = await fetch(`${API_URL}/study/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: apiText, branch: state.studyBranch, user_id: state.currentUserId, image_data: imageUrl })
            });

            // ✅ FIX (H-03): Validate response before proceeding
            if (!startRes.ok) {
                throw new Error(`Study start failed: ${startRes.status}`);
            }
            const startData = await startRes.json();
            if (!startData.session_id) {
                throw new Error('Study start returned no session_id');
            }

            state.activeStudySessionId = startData.session_id;
            state.studyDifficulty = startData.difficulty || 'medium';

            // Analytics: start a fresh session, set the branch, and reflect
            // the agent's first phase so the sidebar lights up immediately.
            studyAnalytics.startSession(startData.session_id, state.studyBranch);
            if (startData.next_phase) studyAnalytics.setPhase(startData.next_phase);

            // ✅ FIX: If the backend generated a specific math problem (the user
            // typed something like "give me a problem"), update studyOriginalQuestion
            // with the actual generated problem so hint/solve work correctly.
            if (startData.session_question && startData.session_question !== text) {
                state.studyOriginalQuestion = startData.session_question;
            }

            // FIX 1: Use extractStartContent to combine concept + socratic
            const content = extractStartContent(startData);
            aiTextDiv.innerHTML = formatMessage(content || 'Ready! Take a look at the problem. 🎯');

            const wasAutoSolved = !!(startData.solve_output) || startData.next_phase === 'practice' || state.studyDifficulty === 'easy';
            appendStudyActions(aiMsgDiv, wasAutoSolved ? 'solved' : 'active');
            saveMessageToSupabase(content, 'ai');

        } else {
            // ── STUDENT ANSWER CHECK ──────────────────────────────
            // Lazy fetch correct answer if we don't have it yet
            if (!state.studyCorrectAnswer) {
                try {
                    const solveRes = await fetch(`${API_URL}/solve`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ question: state.studyOriginalQuestion, mode: 'general', user_id: state.currentUserId })
                    });
                    const solveData = await solveRes.json();
                    state.studyCorrectAnswer = typeof solveData.final_answer === 'object'
                        ? JSON.stringify(solveData.final_answer)
                        : (solveData.final_answer || '');
                } catch (e) {
                    console.warn('[Study] Could not fetch correct answer lazily:', e);
                }
            }

            const checkRes = await fetch(`${API_URL}/study/check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: state.activeStudySessionId,
                    question: state.studyOriginalQuestion,
                    branch: state.studyBranch,
                    student_answer: apiText,
                    correct_answer: state.studyCorrectAnswer,
                    user_id: state.currentUserId
                })
            });
            const checkData = await checkRes.json();

            // FIX 1: extractCheckContent combines feedback + socratic question
            const content = extractCheckContent(checkData);
            aiTextDiv.innerHTML = formatMessage(content || 'Let me think about that... 💭');

            // Analytics: record the attempt against the active branch, plus
            // any phase transition the backend just performed.
            studyAnalytics.recordAttempt({
                branch:  state.studyBranch,
                correct: !!checkData.is_correct,
            });
            if (checkData.next_phase) studyAnalytics.setPhase(checkData.next_phase);

            if (checkData.is_correct || checkData.next_phase === 'practice' || checkData.next_phase === 'summary') {
                state.studyProblemsSolved++;
                state.studyStreak++;
                appendStudyActions(aiMsgDiv, 'solved');
            } else {
                appendStudyActions(aiMsgDiv, 'active');
            }
            saveMessageToSupabase(content, 'ai');
        }

    } catch (err) {
        console.error('[Study] Error:', err);
        aiTextDiv.innerHTML = '<span style="color:var(--primary);">Error connecting to study server. Please try again.</span>';
    } finally {
        state.isStreaming = false;
        const wrapper = $('study-chat-messages-wrapper');
        if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
    }
}

// ══════════════════════════════════════════════════════════════
// LOCAL INTENT CLASSIFIER
// Replaces the /study/classify API call — runs instantly, no latency.
// Mirrors study_llm.py classify_intent().
//
// Issue #1 + #6 (vague study requests should ALWAYS start a session):
//   • Default for ambiguous text → 'study' (was 'casual'), so the user
//     gets a session + Hint/Solve/End buttons from the first message.
//   • 'casual' is now reserved for true greetings, thanks/bye, and
//     identity questions ("who are you") ONLY — nothing math-adjacent.
// ══════════════════════════════════════════════════════════════

// Identity-question pattern kept in sync with study_llm._IDENTITY_PATTERNS so
// "who are you" gets the deterministic canonical reply and never starts a session.
const IDENTITY_RE = /\b(who\s*(?:are|r)\s*(?:you|u)|what\s*are\s*you|what(?:'?s|s|\s+is)\s+your\s+name|what\s+do\s+you\s+(?:do|call\s+yourself)|introduce\s+yourself|tell\s+me\s+about\s+(?:you|yourself)|who\s+is\s+this|who\s+made\s+you|who\s+built\s+you)\b|من\s*ان(?:ت|تَ)|من\s*أنت|من\s+هذا|(?:ايه|إيه|ما|ما\s+هو)\s+اسمك|اسمك\s+(?:ايه|إيه|ما)|عرّ?فني\s+بنفسك|(?:اخبرني|أخبرني)\s+عن\s+نفسك/i;

function classifyIntentLocal(text, imageUrl = null) {
    // If an image was uploaded, it's almost definitely a study/math problem
    if (imageUrl) return 'study';

    const raw = (text || '').trim();
    const t   = raw.toLowerCase();

    // ── 0. IDENTITY — always casual, never starts a session
    if (IDENTITY_RE.test(raw)) return 'casual';

    // ── 1. PURE GREETINGS / FAREWELLS / THANKS — casual
    // Match ONLY when the entire message is a greeting (with optional emoji/punct).
    if (/^(hi|hello|hey|yo|sup|hola|مرحبا|اهلا|أهلاً|السلام|ازيك|صباح\s+الخير|مساء\s+الخير|شكرا|شكراً|thanks|thank\s+you|thx|ty|bye|goodbye|see\s+ya|كيفك|عامل\s+ايه|إزيك)[\s!?.,❤️👋🙏😊]*$/i.test(t)) {
        return 'casual';
    }

    // ── 2. MATH OPERATORS / EXPRESSIONS → study
    if (/[\d]+\s*[+\-*/^=×÷]\s*[\d]/.test(t)) return 'study';
    if (/[a-zA-Z]\s*[+\-*/^=]/.test(t)) return 'study';
    if (/\\frac|\\sqrt|\\int|\\sum/.test(t)) return 'study';
    if (/\d+x|\d+y|\d+z/.test(t)) return 'study';

    // ── 3. EXPLICIT GIVE-UP
    if (/i\s+give\s+up|(?:show|tell|give)\s+(?:me\s+)?(?:the\s+)?(?:solution|answer)|just\s+(?:give|tell)\s+me\s+the\s+answer|استسلم|وريني\s+الحل|ورني\s+الحل|حل\s+لي|حلها/.test(t)) return 'giveup';

    // ── 4. SEARCH (videos / news) — distinct from study
    if (/^(?:search|find\s+me|show\s+me)\s+(?:a\s+)?(?:video|tutorial|youtube)|find\s+me\s+videos|ابحث\s+(?:عن|لي)\s+فيديو|أخبار|news\s+about|who\s+is\s+(?:elon|trump|the\s+president)|what.?s\s+happening\s+in\s+the\s+world/i.test(t)) return 'search';

    // ── 5. EXPLAIN — only when it's clearly conceptual, NOT a problem
    // "what is a derivative" → explain. "what is 2+2" → study (caught above).
    // We require an explicit concept word AND no problem-y operators.
    if (/^(what\s+is|what\s+are|define|definition\s+of|اشرح|وضح|فهمني|ايه\s+هو|يعني\s+ايه|تعريف)\b/i.test(t) &&
        !/solve|calculate|evaluate|simplify|factor|compute|find\s+(?:the|x|y|value)/.test(t)) {
        return 'explain';
    }

    // ── 6. EXPLICIT HELP — student is confused about a SPECIFIC thing
    // We require an emotional/help marker (confused / stuck / lost / مش فاهم).
    // Generic "help me with algebra" is intentionally NOT help — it's a vague
    // study request that should start a session.
    if (/i('?m| am)\s+(?:confused|stuck|lost|so\s+lost)|don.?t\s+understand|i\s+don.?t\s+get\s+(?:this|it)|please\s+help|مش\s+فاهم|مش\s+عارف|لا\s+أفهم|لا\s+افهم/i.test(t)) {
        return 'help';
    }

    // ── 7. MATH WORDS / VERBS / TOPICS → study
    if (/solve|حل|factor|simplify|differentiate|integrate|calculate|evaluate|compute|limit|derive|prove|احسب|بسّط|اشتق|تكامل|عامل|حدد|how\s+many|how\s+much|total|sum|difference|average|كم\s+عدد|ما\s+مجموع|calculus|algebra|geometry|trigonometr|statistics|probability|math|maths|mathematics|equation|derivative|integral|practice|problem|exercise|question|study|learn|تفاضل|جبر|هندسة|رياضيات|مسألة|تمرين|مذاكرة|دراسة/.test(t)) return 'study';

    // ── 8. DEFAULT — anything else is treated as a (vague) study request so
    //     the user gets a session + Hint/Solve/End buttons. This is the
    //     opposite of the previous "default to casual" behaviour and is the
    //     core of Issue #1.
    return 'study';
}

// ══════════════════════════════════════════════════════════════
// ✅ FIX (M-04): LOCAL BRANCH DETECTOR
// Auto-detects math branch from user input so the backend gets
// accurate context instead of always defaulting to 'algebra'.
// ══════════════════════════════════════════════════════════════
function detectBranchLocal(text) {
    const t = text.toLowerCase();

    // Calculus keywords
    if (/derivative|integral|integrate|differentiate|d\/dx|limit|lim|∫|∂|dy\/dx|تفاضل|تكامل|اشتق|calculus/.test(t)) return 'calculus';

    // Trigonometry keywords
    if (/sin|cos|tan|sec|csc|cot|trigonometry|trig|مثلث/.test(t)) return 'trigonometry';

    // Geometry keywords
    if (/triangle|circle|area|perimeter|volume|angle|polygon|radius|diameter|geometry|هندسة|مساحة|محيط/.test(t)) return 'geometry';

    // Statistics keywords
    if (/mean|median|mode|standard deviation|probability|variance|statistics|احتمال|إحصاء|متوسط/.test(t)) return 'statistics';

    // Linear Algebra keywords
    if (/matrix|matrices|determinant|eigenvalue|eigenvector|vector space|linear algebra|مصفوف/.test(t)) return 'linear_algebra';

    // Default: return null (caller will use existing branch or fallback to 'algebra')
    return null;
}

// ══════════════════════════════════════════════════════════════
// STUDY ACTION BUTTONS
// ══════════════════════════════════════════════════════════════

function appendStudyActions(aiMsgDiv, mode = 'active') {
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'study-actions';
    const API_URL = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '') : (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');

    if (mode === 'active') {
        // ── HINT BUTTON ──
        if (state.studyHintsUsed < 3) {
            const hintBtn = document.createElement('button');
            hintBtn.className = 'study-action-btn hint-btn';
            const remaining = 3 - state.studyHintsUsed;
            hintBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px">lightbulb</span> Hint (${remaining} left)`;
            hintBtn.addEventListener('click', async () => {
                if (state.isStreaming) return;
                state.isStreaming = true;
                hintBtn.disabled = true;
                hintBtn.style.opacity = '0.5';
                const hintMsgDiv = addMessage('', 'ai');
                const hintTextDiv = hintMsgDiv.querySelector('.text-body');
                showSkeleton(hintTextDiv);
                try {
                    const res = await fetch(`${API_URL}/study/hint`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session_id: state.activeStudySessionId, question: state.studyOriginalQuestion, branch: state.studyBranch, user_id: state.currentUserId })
                    });
                    const data = await res.json();
                    // FIX 1: use extractContent
                    const content = extractContent(data);
                    // ✅ FIX (C-05): Simple reliable hint counter — increment locally, sync from server if available
                    if (typeof data.hints_remaining === 'number') {
                        state.studyHintsUsed = 3 - data.hints_remaining;
                    } else {
                        state.studyHintsUsed = Math.min(state.studyHintsUsed + 1, 3);
                    }
                    // Analytics: mirror the hint count into the sidebar.
                    studyAnalytics.recordHintUsed();
                    hintTextDiv.innerHTML = formatMessage(content || '💡 Think about the next step...');
                    appendStudyActions(hintMsgDiv, state.studyHintsUsed >= 3 ? 'hints-done' : 'active');
                    saveMessageToSupabase(content, 'ai');
                } catch (e) {
                    hintTextDiv.innerHTML = 'Error getting hint.';
                } finally {
                    state.isStreaming = false;
                    $('study-chat-messages-wrapper')?.scrollTo({ top: 999999, behavior: 'smooth' });
                }
            });
            actionsDiv.appendChild(hintBtn);
        }

        // ── SOLVE BUTTON ──
        const solveBtn = document.createElement('button');
        solveBtn.className = 'study-action-btn solve-btn';
        solveBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px">bolt</span> Solve`;
        solveBtn.addEventListener('click', async () => {
            if (state.isStreaming) return;
            state.isStreaming = true;
            solveBtn.disabled = true;
            solveBtn.style.opacity = '0.5';
            const solveMsgDiv = addMessage('', 'ai');
            const solveTextDiv = solveMsgDiv.querySelector('.text-body');
            showSkeleton(solveTextDiv);
            try {
                const res = await fetch(`${API_URL}/study/solve`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: state.activeStudySessionId, question: state.studyOriginalQuestion, branch: state.studyBranch, user_id: state.currentUserId })
                });
                const data = await res.json();
                // FIX 1: use extractContent
                const content = extractContent(data);
                solveTextDiv.innerHTML = formatMessage(content || 'Could not generate solution.');
                appendStudyActions(solveMsgDiv, 'solved');
                saveMessageToSupabase(content, 'ai');
            } catch (e) {
                solveTextDiv.innerHTML = 'Error solving.';
            } finally {
                state.isStreaming = false;
                $('study-chat-messages-wrapper')?.scrollTo({ top: 999999, behavior: 'smooth' });
            }
        });
        actionsDiv.appendChild(solveBtn);

        // ── QUIZ MODE BUTTON ──
        // Inherits the active study branch + difficulty automatically. Opens
        // the right-sidebar Quiz Session Panel — does NOT navigate away.
        actionsDiv.appendChild(makeQuizModeBtn());
        // Single-question MCQ tied to the current study question.
        actionsDiv.appendChild(makeSingleQuizModeBtn());

        // ── END SESSION ──
        actionsDiv.appendChild(makeEndBtn());

    } else if (mode === 'solved') {
        // ── NEXT PROBLEM ──
        const nextBtn = document.createElement('button');
        nextBtn.className = 'study-action-btn next-btn';
        nextBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px">arrow_forward</span> Next Problem`;
        nextBtn.addEventListener('click', () => handleNextProblem(nextBtn, 'next', API_URL));
        actionsDiv.appendChild(nextBtn);

        // ── TRY HARDER ──
        const harderBtn = document.createElement('button');
        harderBtn.className = 'study-action-btn harder-btn';
        harderBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px;color:#f59e0b;">fitness_center</span> Try Harder`;
        harderBtn.addEventListener('click', () => handleNextProblem(harderBtn, 'next_harder', API_URL));
        actionsDiv.appendChild(harderBtn);

        if (state.studyStreak > 1) {
            const streakBadge = document.createElement('span');
            streakBadge.className = 'streak-badge';
            streakBadge.innerHTML = `🔥 ${state.studyStreak} streak`;
            actionsDiv.appendChild(streakBadge);
        }

        // ── QUIZ MODE BUTTON ──  (also offered after a solve)
        actionsDiv.appendChild(makeQuizModeBtn());
        actionsDiv.appendChild(makeSingleQuizModeBtn());

        actionsDiv.appendChild(makeEndBtn());

    } else if (mode === 'hints-done') {
        // No more hints — just Solve and End
        const solveBtn = document.createElement('button');
        solveBtn.className = 'study-action-btn solve-btn';
        solveBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px">bolt</span> Solve`;
        solveBtn.addEventListener('click', async () => {
            if (state.isStreaming) return;
            state.isStreaming = true;
            solveBtn.disabled = true;
            const solveMsgDiv = addMessage('', 'ai');
            const solveTextDiv = solveMsgDiv.querySelector('.text-body');
            showSkeleton(solveTextDiv);
            try {
                const res = await fetch(`${API_URL}/study/solve`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ session_id: state.activeStudySessionId, question: state.studyOriginalQuestion, branch: state.studyBranch, user_id: state.currentUserId })
                });
                const data = await res.json();
                const content = extractContent(data);
                solveTextDiv.innerHTML = formatMessage(content);
                appendStudyActions(solveMsgDiv, 'solved');
                saveMessageToSupabase(content, 'ai');
            } catch (e) { solveTextDiv.innerHTML = 'Error solving.'; }
            finally { state.isStreaming = false; }
        });
        actionsDiv.appendChild(solveBtn);
        actionsDiv.appendChild(makeEndBtn());
    }

    aiMsgDiv.querySelector('.message-content').appendChild(actionsDiv);
}

// Helper: shared "Next / Harder" handler (avoids duplicate code)
async function handleNextProblem(btn, endpoint, API_URL) {
    if (state.isStreaming) return;
    state.isStreaming = true;
    btn.disabled = true;
    btn.style.opacity = '0.5';
    const nextMsgDiv = addMessage('', 'ai');
    const nextTextDiv = nextMsgDiv.querySelector('.text-body');
    showSkeleton(nextTextDiv);
    try {
        const res = await fetch(`${API_URL}/study/${endpoint}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: state.activeStudySessionId, question: state.studyOriginalQuestion, branch: state.studyBranch, user_id: state.currentUserId })
        });
        const data = await res.json();
        // FIX 1: use extractContent
        const content = extractContent(data);
        nextTextDiv.innerHTML = formatMessage(content || 'Could not generate problem.');
        saveMessageToSupabase(content, 'ai');

        // ✅ FIX (C-04): Extract clean problem text, stripping motivational lines and markdown formatting
        // ✅ FIX (H-07): Always reset hints + correct answer on next problem, even if practice_problem field is missing
        if (data.practice_problem || data.agent_message) {
            const rawProblem = data.practice_problem || data.agent_message;
            // Strip common motivational suffixes and emojis that the LLM adds
            state.studyOriginalQuestion = rawProblem
                .replace(/\n*[🔥🎯💪✨⚡🚀].+$/gm, '')  // Remove emoji-prefixed motivational lines
                .replace(/\*\*$/gm, '')                      // Remove trailing bold markers
                .trim();
            state.studyCorrectAnswer = '';   // reset for lazy fetch
        }
        state.studyHintsUsed = 0;  // Always reset hints for new problem
        appendStudyActions(nextMsgDiv, 'active');
    } catch (e) {
        nextTextDiv.innerHTML = 'Error getting next problem.';
    } finally {
        state.isStreaming = false;
        $('study-chat-messages-wrapper')?.scrollTo({ top: 999999, behavior: 'smooth' });
    }
}

function makeQuizModeBtn() {
    // "Quiz Mode" pill — sibling of Hint / Solve / Explain. Opens the full
    // Practice Test setup drawer (Topic + Difficulty + Number of Questions +
    // Time Limit) so the in-chat flow matches the hero "Create Practice
    // Test" pill exactly. The drawer is wired to window.openPracticeDrawer.
    const btn = document.createElement('button');
    btn.className = 'study-action-btn quiz-mode-btn';
    btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px">quiz</span> Quiz Mode`;
    btn.addEventListener('click', () => {
        if (typeof window.openPracticeDrawer !== 'function') return;
        // Pre-fill the topic chip when the active study session has an
        // identifiable branch so the student doesn't have to re-pick. The
        // drawer's topic chips are: Calculus / Algebra / Geometry /
        // Statistics / Linear Algebra — anything else (e.g. trigonometry)
        // falls through to the drawer's default selection.
        const sourceQuestion = state.studyOriginalQuestion
            ? String(state.studyOriginalQuestion).trim()
            : '';
        const arg = { sourceQuestion };
        const branchToTopic = {
            algebra:        'Algebra',
            calculus:       'Calculus',
            geometry:       'Geometry',
            statistics:     'Statistics',
            linear_algebra: 'Linear Algebra',
        };
        const mapped = branchToTopic[state.studyBranch];
        if (mapped) arg.topic = mapped;
        window.openPracticeDrawer(arg);
    });
    return btn;
}

function makeSingleQuizModeBtn() {
    // One MCQ only — show the simple branch picker so the student picks
    // the subject (the active study session's branch is pre-selected so
    // they can just hit Start). Mirrors the hero "Create Practice
    // Question" pill UX exactly.
    const btn = document.createElement('button');
    btn.className = 'study-action-btn quiz-single-mode-btn';
    btn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px">looks_one</span> Single MCQ`;
    btn.addEventListener('click', () => {
        openBranchDiffMenu({
            trigger: btn,
            kind:    'single',
            onStart: ({ branch, difficulty }) => {
                state.studyBranch = branch;
                state.studyDifficulty = difficulty;
                const sourceQuestion = state.studyOriginalQuestion
                    ? String(state.studyOriginalQuestion).trim()
                    : '';
                openSingleQuizForCurrentQuestion({
                    branch,
                    difficulty,
                    sourceQuestion,
                });
            },
        });
    });
    return btn;
}

function capitalizeFirst(s) {
    if (!s) return '';
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function makeEndBtn() {
    const endBtn = document.createElement('button');
    endBtn.className = 'study-action-btn end-btn';
    endBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px">stop_circle</span> End Session`;
    endBtn.addEventListener('click', () => handleEndSession());
    return endBtn;
}

// Exposed on window so the Session Analytics widget (rendered by lib/quiz.js
// inside the right sidebar) can trigger the same end-session flow as the
// inline action-bar button. Same pattern as window.openPracticeDrawer.
window.handleEndSession = () => handleEndSession();

async function handleEndSession() {
    if (state.isStreaming) return;
    // If there's no active study chat yet (user is still on the hero or just
    // loaded the page), bail out gracefully instead of pinging /study/summary
    // with a null session id — that just returns a generic error message.
    if (!state.isChatActive && !state.activeStudySessionId) return;

    // Stop the Focus Timer in the right sidebar (the sidebar pill + the
    // expanded flip-clock view both reflect state.isRunning, so a single
    // pauseTimer() halts both surfaces). Also freeze the Session Analytics
    // "Time" counter so it doesn't keep ticking after the user wrapped up.
    try { pauseTimer(); } catch (_) {}
    try { studyAnalytics.endSession(); } catch (_) {}

    state.isStreaming = true;
    const summaryMsgDiv = addMessage('', 'ai');
    const summaryTextDiv = summaryMsgDiv.querySelector('.text-body');
    showSkeleton(summaryTextDiv);
    try {
        const API_URL = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '') : (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');
        const res = await fetch(`${API_URL}/study/summary`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: state.activeStudySessionId, question: state.studyOriginalQuestion, branch: state.studyBranch, user_id: state.currentUserId })
        });
        const data = await res.json();
        // FIX 1: use extractContent
        let content = extractContent(data);
        if (state.studyProblemsSolved > 0) {
            content += `\n\n**Session Stats:** ${state.studyProblemsSolved} problem(s) solved | Best streak: ${state.studyStreak}`;
        }
        summaryTextDiv.innerHTML = formatMessage(content);
        saveMessageToSupabase(content, 'ai');
        state.activeStudySessionId = null;
        state.studyHintsUsed = 0;
        state.studyProblemsSolved = 0;
        state.studyStreak = 0;
        state.studyCorrectAnswer = '';
        state.studyOriginalQuestion = null;
    } catch (e) {
        summaryTextDiv.innerHTML = 'Error generating summary.';
    } finally {
        state.isStreaming = false;
        $('study-chat-messages-wrapper')?.scrollTo({ top: 999999, behavior: 'smooth' });
    }
}

// ══════════════════════════════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════════════════════════════

function showSkeleton(el) {
    el.innerHTML = `
        <div class="stream-skeleton" data-role="skeleton">
            <div class="skeleton skeleton-line" style="width:70%"></div>
            <div class="skeleton skeleton-line"></div>
            <div class="skeleton skeleton-line" style="width:45%"></div>
        </div>`;
}

function addMessage(text, sender, imageUrl = null) {
    const chatContainer = $('chat-messages');
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}-message`;
    if (imageUrl) msgDiv.classList.add('has-image');

    if (sender === 'ai') {
        msgDiv.innerHTML = `
            <div class="message-avatar"><img src="logo.png"></div>
            <div class="message-content">
                <div class="ai-name">MATHX</div>
                <div class="text-body">${formatMessage(text)}</div>
                <div class="message-actions">
                    <button class="action-btn" data-action="copy" title="Copy"><span class="material-symbols-outlined">content_copy</span></button>
                    <button class="action-btn" data-action="regenerate" title="Regenerate"><span class="material-symbols-outlined">refresh</span></button>
                    <button class="action-btn" data-action="like" title="Like"><span class="material-symbols-outlined">thumb_up_off_alt</span></button>
                    <button class="action-btn" data-action="dislike" title="Dislike"><span class="material-symbols-outlined">thumb_down_off_alt</span></button>
                </div>
            </div>`;
    } else {
        // Detect a reply prefix so we can render the quoted snippet as
        // a separate quote block above the user's text. The prefix is
        // kept on data-reply-quote so it survives history rebuilds.
        const { quoted, message: displayText } = parseReplyText(text);
        if (quoted) msgDiv.dataset.replyQuote = quoted;
        const quoteHtml = quoted
            ? `<div class="message-reply-quote">
                    <span class="reply-quote-label">↩ Replying to</span>
                    <div class="reply-quote-text">${escapeHtml(quoted)}</div>
               </div>`
            : '';
        msgDiv.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:flex-end;width:100%;">
                <div class="message-content" style="max-width:100%;">
                    ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" class="message-image" data-action="zoom-media" alt="Uploaded image">` : ''}
                    ${quoteHtml}
                    ${displayText && displayText !== '📷 Image Message' ? `<div class="text-body">${escapeHtml(displayText)}</div>` : ''}
                </div>
                <div class="message-actions-inline" style="display:flex;gap:4px;align-items:center;margin-top:6px;margin-right:4px;">
                    <span class="message-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    <button class="action-btn" data-action="resend-user" title="Resend"><span class="material-symbols-outlined">refresh</span></button>
                    <button class="action-btn" data-action="edit-user" title="Edit"><span class="material-symbols-outlined">edit</span></button>
                    <button class="action-btn" data-action="copy-user" title="Copy"><span class="material-symbols-outlined">content_copy</span></button>
                </div>
            </div>
            <div class="message-avatar"><img src="user.png"></div>`;
    }

    chatContainer.appendChild(msgDiv);
    const wrapper = $('study-chat-messages-wrapper');
    if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
    return msgDiv;
}

// ── Tools, Notes, Timer — unchanged ──────────────────────────

function initModals() {
    $('welcome-start-btn')?.addEventListener('click', () => $('study-welcome-overlay').classList.remove('active'));
}

function initToolsAndSymbols() {
    const mathSymbolSets = {
        popular: ['π', '∞', '√', '∫', 'Σ', '±', '≠', '≈', '≥', '≤', '÷', '×', 'log', 'ln', 'x²', 'x³', 'xⁿ'],
        trig: ['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'θ', 'φ', 'α', 'β'],
        calculus: ['∫', '∬', '∮', 'd/dx', '∂', 'lim', '→', 'Δ', '∇', 'dy/dx'],
        comparison: ['=', '≠', '≈', '≡', '>', '<', '≥', '≤', '≫', '≪'],
        sets: ['∈', '∉', '⊂', '⊃', '⊆', '⊇', '∩', '∪', '∅', 'ℝ', 'ℤ', 'ℕ'],
        arrows: ['→', '←', '↔', '⇒', '⇐', '⇔', '↑', '↓', '⟹', '⟸'],
        greek: ['α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'σ', 'τ', 'φ', 'ω', 'Ω', 'Δ'],
    };
    const toolbar = $('math-toolbar');
    const grid = $('math-symbols-grid');
    $('hero-math-keyboard-toggle')?.addEventListener('click', () => toolbar.classList.toggle('active'));
    $('chat-math-keyboard-toggle')?.addEventListener('click', () => toolbar.classList.toggle('active'));
    $('math-toolbar-close')?.addEventListener('click', () => toolbar.classList.remove('active'));
    const renderSymbols = (category) => {
        const symbols = mathSymbolSets[category] || mathSymbolSets.popular;
        grid.innerHTML = symbols.map(s => `<button class="math-sym-btn">${s}</button>`).join('');
        grid.querySelectorAll('.math-sym-btn').forEach(btn => {
            btn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const activeType = state.isChatActive ? 'chat' : 'hero';
                const input = $(`${activeType}-search-input`);
                if (!input) return;
                const start = input.selectionStart;
                const end = input.selectionEnd;
                const symbol = btn.textContent;
                input.value = input.value.substring(0, start) + symbol + input.value.substring(end);
                input.focus();
                const pos = start + symbol.length;
                input.setSelectionRange(pos, pos);
                input.dispatchEvent(new Event('input'));
            });
        });
    };
    renderSymbols('popular');
    document.querySelectorAll('.math-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.math-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderSymbols(tab.dataset.tab);
        });
    });
}

function initStudyTools() {
    // Timer
    const playBtn = $('timer-play-btn');
    const resetBtn = $('timer-reset-btn');
    const skipBtn = $('timer-skip-btn');

    const togglePlayPause = () => state.isRunning ? pauseTimer() : startTimer();

    playBtn?.addEventListener('click', togglePlayPause);

    // Compact pill mirror — same handler, so the play/pause icon stays in sync
    // regardless of which view the user clicked from.
    $('timer-pill-play')?.addEventListener('click', togglePlayPause);

    // Expand / collapse the Focus Timer in place. Default is collapsed so the
    // sidebar leads with Session Analytics; the chevron rotates 180° when open.
    const timerCard   = $('timer-card');
    const timerToggle = $('timer-toggle');
    timerToggle?.addEventListener('click', () => {
        if (!timerCard) return;
        const collapsed = timerCard.classList.toggle('collapsed');
        timerToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        timerToggle.title = collapsed ? 'Expand timer' : 'Collapse timer';
        timerToggle.setAttribute('aria-label', collapsed ? 'Expand timer' : 'Collapse timer');
    });

    resetBtn?.addEventListener('click', () => {
        clearInterval(state.timerInterval);
        state.isRunning = false;
        state.timeRemaining = state.workDuration;
        state.freeTimerElapsed = 0;
        _setPlayIcons('play_arrow');
        updateTimerUI();
    });

    // ✅ FIX (H-01): Timer skip now works even when paused — directly completes the session
    skipBtn?.addEventListener('click', () => {
        if (state.isFreeTimer) {
            state.freeTimerElapsed = 0;
        } else {
            clearInterval(state.timerInterval);
            state.isRunning = false;
            state.timeRemaining = 0;
            _setPlayIcons('play_arrow');
            if (typeof window.showAlertModal === 'function') {
                window.showAlertModal('Timer Finished', 'Session skipped! Take a break.');
            }
        }
        updateTimerUI();
    });

    const timerPlanButtons = document.querySelectorAll('.timer-plan-btn');
    timerPlanButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            timerPlanButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const workMins = parseInt(btn.dataset.work || '0');
            const breakMins = parseInt(btn.dataset.break || '0');

            clearInterval(state.timerInterval);
            state.isRunning = false;
            _setPlayIcons('play_arrow');

            if (workMins === 0 && breakMins === 0) {
                state.isFreeTimer = true;
                state.freeTimerElapsed = 0;
            } else {
                state.isFreeTimer = false;
                state.workDuration = workMins * 60;
                state.breakDuration = breakMins * 60;
                state.timeRemaining = state.workDuration;
                state.timerMode = 'work';
            }
            updateTimerUI();
        });
    });

    updateTimerUI();
}

function _setPlayIcons(name) {
    // Keep the full-view play icon and the compact-pill icon in lockstep
    // so the user sees the same state regardless of which one is visible.
    setTimerButtonIcon($('play-icon'), name);
    setTimerButtonIcon($('timer-pill-play-icon'), name);
}

function setTimerButtonIcon(icon, name) {
    if (!icon) return;
    if (icon.tagName?.toLowerCase() === 'svg') {
        icon.innerHTML = name === 'pause'
            ? '<path d="M7 5h4v14H7z"></path><path d="M13 5h4v14h-4z"></path>'
            : '<path d="M8 5v14l11-7z"></path>';
        return;
    }
    icon.textContent = name;
}

function startTimer() {
    state.isRunning = true;
    _setPlayIcons('pause');
    state.timerInterval = setInterval(() => {
        if (state.isFreeTimer) { state.freeTimerElapsed++; updateTimerUI(); }
        else {
            if (state.timeRemaining > 0) { state.timeRemaining--; updateTimerUI(); }
            else {
                clearInterval(state.timerInterval);
                state.isRunning = false;
                _setPlayIcons('play_arrow');
                if (typeof window.showAlertModal === 'function') {
                    window.showAlertModal('Timer Finished', 'Time is up! Take a break.');
                } else {
                    alert('Timer Finished!');
                }
            }
        }
    }, 1000);
}

function pauseTimer() {
    state.isRunning = false;
    _setPlayIcons('play_arrow');
    clearInterval(state.timerInterval);
}

function updateTimerUI() {
    let displayTime = state.isFreeTimer ? state.freeTimerElapsed : state.timeRemaining;
    $('timer-label').textContent = state.isFreeTimer ? 'Elapsed' : 'Focus';
    const mins = Math.floor(Math.max(0, displayTime) / 60);
    const secs = Math.max(0, displayTime) % 60;
    const formatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    const timerTimeEl = $('timer-time');
    if (timerTimeEl) timerTimeEl.textContent = formatted;
    // Mirror into the compact pill (shown when the sidebar timer is collapsed)
    const pillTime = $('timer-pill-time');
    if (pillTime) pillTime.textContent = formatted;
    // Legacy compact-timer-time slot (top bar) — keep if some build still uses it.
    const compact = $('compact-timer-time');
    if (compact) compact.textContent = formatted;
    
    // Update flip clock digits
    const mStr = String(mins).padStart(2, '0');
    const sStr = String(secs).padStart(2, '0');
    updateFlipDigit('min-tens', mStr[0]);
    updateFlipDigit('min-ones', mStr[1]);
    updateFlipDigit('sec-tens', sStr[0]);
    updateFlipDigit('sec-ones', sStr[1]);
}

function updateFlipDigit(unit, nextValue) {
    updateFlipCard(document.querySelector(`[data-flip-unit="${unit}"]`), nextValue);
}

function setFlipFaceValue(face, value) {
    if (!face) return;
    const valueEl = face.querySelector('.flip-card-value');
    if (valueEl) valueEl.textContent = value;
    else face.textContent = value;
}

function setFlipCardStaticValue(card, value) {
    if (!card) return;
    setFlipFaceValue(card.querySelector('.flip-card-top'), value);
    setFlipFaceValue(card.querySelector('.flip-card-bottom'), value);
}

function createFlipFlap(position, value) {
    const flap = document.createElement('div');
    flap.className = `flip-flap flip-flap-${position}`;
    const valueEl = document.createElement('span');
    valueEl.className = 'flip-card-value';
    valueEl.textContent = value;
    flap.appendChild(valueEl);
    return flap;
}

function updateFlipCard(card, nextValue) {
    if (!card) return;
    const currentValue = card.dataset.value || card.querySelector('.flip-card-value')?.textContent || nextValue;
    if (currentValue === nextValue) {
        card.dataset.value = nextValue;
        setFlipCardStaticValue(card, nextValue);
        return;
    }

    card.querySelectorAll('.flip-flap').forEach(node => node.remove());
    card.dataset.value = nextValue;

    const topFace = card.querySelector('.flip-card-top');
    const bottomFace = card.querySelector('.flip-card-bottom');
    setFlipFaceValue(topFace, nextValue);
    setFlipFaceValue(bottomFace, currentValue);

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        setFlipCardStaticValue(card, nextValue);
        return;
    }

    const topFlap = createFlipFlap('top', currentValue);
    const bottomFlap = createFlipFlap('bottom', nextValue);
    card.appendChild(topFlap);
    card.appendChild(bottomFlap);

    bottomFlap.addEventListener('animationend', () => {
        setFlipCardStaticValue(card, nextValue);
        topFlap.remove();
        bottomFlap.remove();
    }, { once: true });
}

// ============================================================
// Reply to Message Feature (Study Mode)
// ============================================================
// Mirrors the implementation in app.js so the experience is
// identical across the main chat and Study Mode. State is kept
// on `window.replyContext` so both pages share the same source
// of truth (separate page loads, but consistent behavior).
// ============================================================

window.replyContext = window.replyContext || null;

function ensureReplyPopupSM() {
    let popup = document.getElementById('reply-popup');
    if (popup) return popup;
    popup = document.createElement('div');
    popup.id = 'reply-popup';
    popup.setAttribute('role', 'button');
    popup.innerHTML = '<span class="reply-icon">↩</span><span>Reply</span>';
    popup.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : '';
        if (text) {
            window.setReplyContext(text);
            try { sel.removeAllRanges(); } catch (err) { /* noop */ }
        }
        hideReplyPopupSM();
    });
    document.body.appendChild(popup);
    return popup;
}

function showReplyPopupSM(rect) {
    const popup = ensureReplyPopupSM();
    popup.style.display = 'inline-flex';
    const top = rect.top + window.scrollY - popup.offsetHeight - 8;
    const left = rect.left + window.scrollX + (rect.width / 2) - (popup.offsetWidth / 2);
    popup.style.top = Math.max(window.scrollY + 4, top) + 'px';
    popup.style.left = Math.max(8, left) + 'px';
}

function hideReplyPopupSM() {
    const popup = document.getElementById('reply-popup');
    if (popup) popup.style.display = 'none';
}

function renderReplyBarsSM() {
    document.querySelectorAll('.reply-preview-bar').forEach(b => b.remove());
    if (!window.replyContext) return;

    const raw = window.replyContext;
    const trimmed = raw.length > 80 ? raw.substring(0, 80) + '...' : raw;

    document.querySelectorAll('.input-content').forEach(content => {
        const bar = document.createElement('div');
        bar.className = 'reply-preview-bar';
        const safeText = trimmed
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        bar.innerHTML = `
            <span class="material-symbols-outlined" style="font-size:14px;color:#f97316;">reply</span>
            <span class="reply-text">Replying to: "${safeText}"</span>
            <button class="reply-cancel" type="button" title="Cancel reply">×</button>
        `;
        bar.querySelector('.reply-cancel').addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.clearReplyContext();
        });
        const textarea = content.querySelector('.search-input');
        if (textarea) {
            content.insertBefore(bar, textarea);
        } else {
            content.insertBefore(bar, content.firstChild);
        }
    });
}

window.setReplyContext = function (text) {
    if (!text || !text.trim()) return;
    window.replyContext = text.trim();
    hideReplyPopupSM();
    renderReplyBarsSM();
    // Focus the active input so the user can start typing
    const chatInput = $('chat-search-input');
    const heroInput = $('hero-search-input');
    const target = (chatInput && chatInput.offsetParent) ? chatInput : heroInput;
    if (target) target.focus();
};

window.clearReplyContext = function () {
    window.replyContext = null;
    document.querySelectorAll('.reply-preview-bar').forEach(b => b.remove());
};

function attachReplyBtnToMessageSM(msgEl) {
    if (!msgEl.classList || !msgEl.classList.contains('ai-message')) return;
    
    // Check if it already has a reply button in the actions
    if (msgEl.querySelector('.message-actions .message-reply-inline-btn')) return;

    const actions = msgEl.querySelector('.message-actions');
    if (!actions) return;

    const btn = document.createElement('button');
    btn.className = 'action-btn message-reply-inline-btn';
    btn.type = 'button';
    btn.title = 'Reply';
    btn.innerHTML = '<span class="material-symbols-outlined">reply</span>';
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const textBody = msgEl.querySelector('.text-body');
        const textVal = (textBody?.innerText || textBody?.textContent || '').trim();
        if (textVal) window.setReplyContext(textVal);
    });
    actions.appendChild(btn);
}

function initReplyFeature() {
    ensureReplyPopupSM();

    document.querySelectorAll('.ai-message').forEach(attachReplyBtnToMessageSM);

    const chatMessages = $('chat-messages');
    if (chatMessages) {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mut) => {
                mut.addedNodes.forEach((node) => {
                    if (node.nodeType !== 1) return;
                    if (node.classList && node.classList.contains('ai-message')) {
                        attachReplyBtnToMessageSM(node);
                    }
                    if (node.querySelectorAll) {
                        node.querySelectorAll('.ai-message').forEach(attachReplyBtnToMessageSM);
                    }
                });
            });
        });
        observer.observe(chatMessages, { childList: true, subtree: true });
    }

    document.addEventListener('mouseup', (e) => {
        if (e.target.closest && (e.target.closest('#reply-popup') || e.target.closest('.reply-preview-bar'))) return;

        setTimeout(() => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
                hideReplyPopupSM();
                return;
            }
            const text = sel.toString().trim();
            if (!text) {
                hideReplyPopupSM();
                return;
            }
            const range = sel.getRangeAt(0);
            const ancestor = range.commonAncestorContainer;
            const node = ancestor.nodeType === 1 ? ancestor : ancestor.parentElement;
            if (!node || !node.closest('.message, .scm-message')) {
                hideReplyPopupSM();
                return;
            }
            const rect = range.getBoundingClientRect();
            if (rect && (rect.width || rect.height)) {
                showReplyPopupSM(rect);
            }
        }, 10);
    });

    document.addEventListener('selectionchange', () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) hideReplyPopupSM();
    });

    document.addEventListener('mousedown', (e) => {
        if (e.target.closest && e.target.closest('#reply-popup')) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) hideReplyPopupSM();
    });
}

// ── Bootstrap ─────────────────────────────────────────────────

function bootstrapApp() {
    initMarkdown();
    initAuthAndHistory();
    initImageUpload();
    initChat();
    initStudyTools();
    initModals();
    initToolsAndSymbols();
    initReplyFeature();

    // Mount the Session Analytics widget into its sidebar slot. The component
    // owns its own pub/sub + 1-second time-since-start tick, so this single
    // call is enough to keep it live for the page lifetime.
    const analyticsSlot = document.getElementById('session-analytics-card');
    if (analyticsSlot) mountSessionAnalytics(analyticsSlot);

    // Auto-collapse right sidebar on mobile
    if (window.innerWidth <= 1200) {
        document.getElementById('study-right-sidebar')?.classList.add('collapsed');
    }

    // Show Study Mode Welcome Modal only when the user is genuinely starting a
    // new chat — i.e. fresh navigation to study-mode.html with no ?session=...
    // Skip it on page refresh or back/forward, so reloading doesn't re-trigger it.
    const urlParamsObj = new URLSearchParams(window.location.search);
    const studyOverlay = document.getElementById('study-welcome-overlay');
    const navEntry = performance.getEntriesByType('navigation')[0];
    const navType = navEntry ? navEntry.type : 'navigate';
    const isReloadOrBack = navType === 'reload' || navType === 'back_forward';
    const isFreshChat = !urlParamsObj.get('session') && !isReloadOrBack;
    if (isFreshChat && studyOverlay) {
        studyOverlay.classList.add('active');
    }

    // Fresh "New chat" navigation — wipe the visible analytics so the user
    // doesn't see the previous chat's Solved / Accuracy / Time bleeding in
    // before they've sent the first message. The cross-session
    // weakBranches memory is preserved by the analytics store itself.
    if (isFreshChat) {
        try { studyAnalytics.resetActiveView(); } catch (_) {}
    }


    // ✅ FIX (M-01): Set mode synchronously to avoid visual flash from 'General' → 'Study Agent'
    if (!state.isChatActive) { state.currentMode = 'study'; syncModeUI('study'); }

}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
    bootstrapApp();
}

if (typeof window.showShareModal === 'undefined') {
    window.showShareModal = function (url) {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0'; overlay.style.left = '0'; overlay.style.right = '0'; overlay.style.bottom = '0';
        overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        overlay.style.backdropFilter = 'blur(4px)';
        overlay.style.zIndex = '9999';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';

        const modal = document.createElement('div');
        modal.style.backgroundColor = 'var(--bg-elevated)';
        modal.style.border = '1px solid var(--border-color)';
        modal.style.borderRadius = 'var(--radius-lg)';
        modal.style.padding = 'var(--space-4)';
        modal.style.width = '90%';
        modal.style.maxWidth = '450px';
        modal.style.boxShadow = 'var(--shadow-xl)';
        modal.style.position = 'relative';

        modal.innerHTML = `
        <button class="close-share" style="position:absolute; top:12px; right:12px; background:transparent; border:none; color:var(--text-secondary); cursor:pointer;">
            <span class="material-symbols-outlined">close</span>
        </button>
        <h3 style="margin:0 0 16px 0; font-size:18px; color:var(--text-primary); font-weight:600;">Shareable public link</h3>
        <div style="display:flex; align-items:center; background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:var(--radius-full); padding:4px 4px 4px 16px; margin-bottom:16px;">
            <div style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-secondary); font-size:14px; user-select:all;">
                ${url}
            </div>
            <button class="copy-share-btn" style="background:var(--primary); color:#fff; border:none; padding:8px 16px; border-radius:var(--radius-full); font-weight:500; font-size:14px; cursor:pointer; display:flex; align-items:center; gap:6px; transition:all 0.2s;">
                <span class="material-symbols-outlined" style="font-size:18px;">content_copy</span> Copy link
            </button>
        </div>
        <div style="display:flex; gap:8px; color:var(--text-muted); font-size:12px; line-height:1.4;">
            <span class="material-symbols-outlined" style="font-size:16px; flex-shrink:0;">info</span>
            <p style="margin:0;">Public links can be reshared. Share responsibly, delete anytime. If sharing with third-parties, their policies apply.</p>
        </div>
    `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        overlay.querySelector('.close-share').addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) document.body.removeChild(overlay);
        });

        const copyBtn = overlay.querySelector('.copy-share-btn');
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(url).then(() => {
                copyBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">check</span> Copied!';
                copyBtn.style.backgroundColor = '#10b981';
                setTimeout(() => {
                    copyBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;">content_copy</span> Copy link';
                    copyBtn.style.backgroundColor = 'var(--primary)';
                }, 2000);
            });
        });
    };
}

if (typeof window.showConfirmModal === 'undefined') {
    window.showConfirmModal = function (message) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.position = 'fixed';
            overlay.style.top = '0'; overlay.style.left = '0'; overlay.style.right = '0'; overlay.style.bottom = '0';
            overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
            overlay.style.backdropFilter = 'blur(4px)';
            overlay.style.zIndex = '9999';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';

            const modal = document.createElement('div');
            modal.style.backgroundColor = 'var(--bg-elevated)';
            modal.style.border = '1px solid var(--border-color)';
            modal.style.borderRadius = 'var(--radius-lg)';
            modal.style.padding = 'var(--space-4)';
            modal.style.width = '90%';
            modal.style.maxWidth = '400px';
            modal.style.boxShadow = 'var(--shadow-xl)';
            modal.style.position = 'relative';

            modal.innerHTML = `
            <h3 style="margin:0 0 12px 0; font-size:18px; color:var(--text-primary); font-weight:600;">Confirm Action</h3>
            <p style="margin:0 0 20px 0; color:var(--text-secondary); font-size:14px; line-height:1.5;">${message}</p>
            <div style="display:flex; justify-content:flex-end; gap:12px;">
                <button class="cancel-btn" style="background:transparent; border:1px solid var(--border-color); color:var(--text-primary); padding:8px 16px; border-radius:var(--radius-md); font-size:14px; cursor:pointer;">Cancel</button>
                <button class="confirm-btn" style="background:#ef4444; color:#fff; border:none; padding:8px 16px; border-radius:var(--radius-md); font-size:14px; cursor:pointer; min-width:80px;">Delete</button>
            </div>
        `;

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            const close = (result) => {
                if (overlay.parentNode) document.body.removeChild(overlay);
                resolve(result);
            };

            overlay.querySelector('.cancel-btn').addEventListener('click', () => close(false));
            overlay.querySelector('.confirm-btn').addEventListener('click', () => close(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
        });
    };
}

if (typeof window.showPromptModal === 'undefined') {
    window.showPromptModal = function (title, defaultValue) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.position = 'fixed';
            overlay.style.top = '0'; overlay.style.left = '0'; overlay.style.right = '0'; overlay.style.bottom = '0';
            overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
            overlay.style.backdropFilter = 'blur(4px)';
            overlay.style.zIndex = '9999';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';

            const modal = document.createElement('div');
            modal.style.backgroundColor = 'var(--bg-elevated)';
            modal.style.border = '1px solid var(--border-color)';
            modal.style.borderRadius = 'var(--radius-lg)';
            modal.style.padding = 'var(--space-4)';
            modal.style.width = '90%';
            modal.style.maxWidth = '400px';
            modal.style.boxShadow = 'var(--shadow-xl)';
            modal.style.position = 'relative';

            modal.innerHTML = `
            <h3 style="margin:0 0 16px 0; font-size:18px; color:var(--text-primary); font-weight:600;">${title}</h3>
            <input type="text" class="prompt-input" value="${defaultValue || ''}" style="width:100%; box-sizing:border-box; background:var(--bg-secondary); border:1px solid var(--border-color); color:var(--text-primary); padding:10px 14px; border-radius:var(--radius-md); font-size:14px; margin-bottom:20px; outline:none;" />
            <div style="display:flex; justify-content:flex-end; gap:12px;">
                <button class="cancel-btn" style="background:transparent; border:1px solid var(--border-color); color:var(--text-primary); padding:8px 16px; border-radius:var(--radius-md); font-size:14px; cursor:pointer;">Cancel</button>
                <button class="confirm-btn" style="background:var(--primary); color:#fff; border:none; padding:8px 16px; border-radius:var(--radius-md); font-size:14px; cursor:pointer; min-width:80px;">Save</button>
            </div>
        `;

            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            const input = overlay.querySelector('.prompt-input');
            input.focus();
            input.select();

            const close = (result) => {
                if (overlay.parentNode) document.body.removeChild(overlay);
                resolve(result);
            };

            overlay.querySelector('.cancel-btn').addEventListener('click', () => close(null));
            overlay.querySelector('.confirm-btn').addEventListener('click', () => close(input.value));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') close(input.value);
                if (e.key === 'Escape') close(null);
            });
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
        });
    };
}

window.showAlertModal = function (title, message) {
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0'; overlay.style.left = '0'; overlay.style.right = '0'; overlay.style.bottom = '0';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    overlay.style.backdropFilter = 'blur(4px)';
    overlay.style.zIndex = '9999';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    const modal = document.createElement('div');
    modal.style.backgroundColor = 'var(--bg-elevated)';
    modal.style.border = '1px solid var(--border-color)';
    modal.style.borderRadius = 'var(--radius-lg)';
    modal.style.padding = 'var(--space-5)';
    modal.style.width = '90%';
    modal.style.maxWidth = '400px';
    modal.style.boxShadow = 'var(--shadow-xl)';
    modal.style.position = 'relative';
    modal.style.textAlign = 'center';

    modal.innerHTML = `
        <div style="margin-bottom:16px;">
            <span class="material-symbols-outlined" style="font-size:48px; color:var(--primary); opacity:0.8;">info</span>
        </div>
        <h3 style="margin:0 0 12px 0; font-size:18px; color:var(--text-primary); font-weight:600;">${title}</h3>
        <p style="margin:0 0 24px 0; color:var(--text-secondary); font-size:14px; line-height:1.5;">${message}</p>
        <button class="close-alert-btn" style="background:var(--primary); color:#fff; border:none; padding:10px 24px; border-radius:var(--radius-md); font-size:14px; font-weight:600; cursor:pointer; width:100%; transition:all 0.2s;">OK</button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.querySelector('.close-alert-btn').addEventListener('click', () => {
        if (overlay.parentNode) document.body.removeChild(overlay);
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay && overlay.parentNode) document.body.removeChild(overlay);
    });
};

// ============================================================
// QUIZ PANEL DRAWER LOGIC — 4-screen flow:
//   Setup → Generating → Quiz → Results
//
// Public surface (do not rename without updating math-hub.js):
//   window.openPracticeDrawer(arg1, arg2)  // (topicLabel, unitName) | {object}
//   window.openQuizPanel                   // alias of the above
//   window.closePracticeDrawer()
// ============================================================

const QP_TOPICS = ['Calculus', 'Algebra', 'Geometry', 'Statistics', 'Linear Algebra'];

const qpState = {
    screen:           'setup',
    topic:            'Calculus',
    unit:             'General Practice',
    difficulty:       'medium',
    numQuestions:     5,
    timeLimit:        false,
    timeMinutes:      10,

    questions:        [],
    currentIndex:     0,
    answers:          [],   // selectedIdx | null per question
    locked:           false,
    answered:         false,

    elapsedSeconds:   0,
    remainingSeconds: 0,
    timerInterval:    null,

    genAbort:         null,
    score:            0,
    streak:           0,
};

const qpEl = {
    overlay:       document.getElementById('qp-overlay'),
    drawer:        document.getElementById('qp-drawer'),
    closeBtn:      document.getElementById('qp-close-btn'),
    title:         document.getElementById('qp-title'),

    body:          document.getElementById('qp-body'),
    screenSetup:   document.getElementById('qp-screen-setup'),
    screenGen:     document.getElementById('qp-screen-generating'),
    screenQuiz:    document.getElementById('qp-screen-quiz'),
    screenResult:  document.getElementById('qp-screen-results'),

    topicChips:    document.getElementById('qp-topic-chips'),
    diffGrid:      document.getElementById('qp-diff-grid'),
    stepDownBtn:   document.getElementById('qp-step-down'),
    stepUpBtn:     document.getElementById('qp-step-up'),
    stepValueEl:   document.getElementById('qp-step-value'),
    timeToggle:    document.getElementById('qp-time-toggle'),
    timePills:     document.getElementById('qp-time-pills'),
    generateBtn:   document.getElementById('qp-generate-btn'),

    genInner:      document.getElementById('qp-gen-inner'),
    cancelGenBtn:  document.getElementById('qp-cancel-gen-btn'),

    qIndexEl:      document.getElementById('qp-q-index'),
    qTotalEl:      document.getElementById('qp-q-total'),
    quizTimer:     document.getElementById('qp-quiz-timer'),
    timerText:     document.getElementById('qp-timer'),
    quitBtn:       document.getElementById('qp-quit-btn'),
    progressBar:   document.getElementById('qp-progress-bar'),
    qNumEl:        document.getElementById('qp-q-num'),
    questionText:  document.getElementById('qp-question-text'),
    optionsGrid:   document.getElementById('qp-options-grid'),
    stepBtn:       document.getElementById('qp-step-btn'),
    stepBtnText:   document.getElementById('qp-step-btn-text'),
    stepsPanel:    document.getElementById('qp-steps-panel'),
    nextBtn:       document.getElementById('qp-next-btn'),
    nextBtnText:   document.getElementById('qp-next-btn-text'),

    resultsTitle:  document.getElementById('qp-results-title'),
    ringFill:      document.getElementById('qp-ring-fill'),
    ringPct:       document.getElementById('qp-ring-pct'),
    ringScore:     document.getElementById('qp-ring-score'),
    perfBadge:     document.getElementById('qp-perf-badge'),
    resScore:      document.getElementById('qp-res-score'),
    resAcc:        document.getElementById('qp-res-acc'),
    resTime:       document.getElementById('qp-res-time'),
    reviewCount:   document.getElementById('qp-review-count'),
    reviewList:    document.getElementById('qp-review-list'),
    tryAgainBtn:   document.getElementById('qp-btn-try-again'),
    newQuizBtn:    document.getElementById('qp-btn-new-quiz'),
    mistakesBtn:   document.getElementById('qp-btn-mistakes'),
};

// ── Math + helpers ────────────────────────────────────────
function qpRenderMath(text) {
    if (!text) return '';
    let html = String(text);
    const renderStr = (str, isDisplay) => {
        try {
            if (typeof katex !== 'undefined') {
                return katex.renderToString(str, { displayMode: isDisplay, throwOnError: false });
            }
            return str;
        } catch (_) { return str; }
    };
    html = html.replace(/\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]/g, (_m, p1, p2) => renderStr(p1 || p2, true));
    html = html.replace(/\$([^$\n]+?)\$|\\\(([\s\S]*?)\\\)/g, (_m, p1, p2) => renderStr(p1 || p2, false));
    if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
        try { html = marked.parse(html); } catch (_) {}
    }
    return html;
}
function qpRenderInline(text) {
    // Same as qpRenderMath but unwraps outer <p> tags so it sits cleanly
    // inside line-clamped containers.
    return qpRenderMath(text).replace(/<\/?p>/g, '');
}
function qpEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function qpFmtTime(secs) {
    const v = Math.max(0, Math.floor(secs));
    const m = Math.floor(v / 60).toString().padStart(2, '0');
    const s = (v % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

// ── Screen transitions + step indicator ─────────────────
const QP_SCREEN_STEP = { setup: 1, generating: 2, quiz: 3, results: 4 };

function qpGoToScreen(name) {
    qpState.screen = name;
    [qpEl.screenSetup, qpEl.screenGen, qpEl.screenQuiz, qpEl.screenResult].forEach(s => s && s.classList.remove('active'));
    const target = ({
        setup:      qpEl.screenSetup,
        generating: qpEl.screenGen,
        quiz:       qpEl.screenQuiz,
        results:    qpEl.screenResult,
    })[name];
    if (target) target.classList.add('active');
    if (qpEl.body) qpEl.body.scrollTop = 0;

    const stepNum = QP_SCREEN_STEP[name];
    document.querySelectorAll('.qp-step').forEach(el => {
        const i = parseInt(el.dataset.step, 10);
        el.classList.toggle('active', i === stepNum);
        el.classList.toggle('done',   i <  stepNum);
    });
}

// ── Open / close ─────────────────────────────────────────
function qpResetToSetup() {
    qpCleanupTimer();
    qpState.questions    = [];
    qpState.answers      = [];
    qpState.currentIndex = 0;
    qpState.score        = 0;
    qpState.streak       = 0;
    qpState.locked       = false;
    qpState.answered     = false;
    qpGoToScreen('setup');
    qpSyncSetupUI();
}
function qpSyncSetupUI() {
    document.querySelectorAll('.qp-topic-chip').forEach(c => {
        c.classList.toggle('selected', c.dataset.topic === qpState.topic);
    });
    document.querySelectorAll('.qp-diff-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.diff === qpState.difficulty);
    });
    qpUpdateStepper();
    if (qpEl.timeToggle) {
        qpEl.timeToggle.classList.toggle('on', qpState.timeLimit);
        qpEl.timeToggle.setAttribute('aria-checked', String(qpState.timeLimit));
    }
    if (qpEl.timePills) qpEl.timePills.classList.toggle('hidden', !qpState.timeLimit);
    document.querySelectorAll('.qp-time-pill').forEach(p => {
        p.classList.toggle('selected', parseInt(p.dataset.mins, 10) === qpState.timeMinutes);
    });
}

window.openPracticeDrawer = function(arg1, arg2) {
    let preDiff = null;
    let preselected = false;
    if (typeof arg1 === 'object' && arg1 !== null) {
        qpState.topic = (arg1.branch || arg1.topic || qpState.topic);
        qpState.unit  = arg1.sourceQuestion ? 'Contextual Practice' : (arg1.unit || 'General Practice');
        if (arg1.difficulty) preDiff = arg1.difficulty;
        if (arg1.preselected) preselected = true;
    } else {
        qpState.topic = arg1 || qpState.topic || 'Calculus';
        qpState.unit  = arg2 || 'General Practice';
    }

    // Snap to canonical topic (case-insensitive) so the chip matches.
    if (!QP_TOPICS.includes(qpState.topic)) {
        const match = QP_TOPICS.find(t => t.toLowerCase() === String(qpState.topic).toLowerCase());
        qpState.topic = match || 'Calculus';
    }

    qpResetToSetup();

    // BUG 2 FIX: When opened from the Hub with a pre-selected topic,
    // hide the topic selector row — the user already chose the topic.
    const topicField = document.getElementById('qp-topic-field');
    if (topicField) {
        topicField.style.display = preselected ? 'none' : '';
    }

    qpEl.overlay.hidden = false;
    qpEl.drawer.hidden  = false;
    requestAnimationFrame(() => {
        qpEl.overlay.classList.add('active');
        qpEl.drawer.classList.add('open');
    });

    // Legacy callers that pre-pick difficulty skip the Setup screen.
    if (preDiff) {
        qpState.difficulty = preDiff;
        qpStartGeneration();
    }
};
window.openQuizPanel = window.openPracticeDrawer;

window.closePracticeDrawer = function() {
    qpCleanupTimer();
    if (qpState.genAbort) { try { qpState.genAbort.abort(); } catch (_) {} qpState.genAbort = null; }
    qpEl.overlay.classList.remove('active');
    qpEl.drawer.classList.remove('open');
    setTimeout(() => {
        qpEl.overlay.hidden = true;
        qpEl.drawer.hidden  = true;
    }, 400);
};

function qpTryClose() {
    if (qpState.screen === 'setup' || qpState.screen === 'results' || qpState.screen === 'generating') {
        window.closePracticeDrawer();
    } else if (confirm('Quit this quiz? Your progress will be lost.')) {
        window.closePracticeDrawer();
    }
}
qpEl.closeBtn?.addEventListener('click', qpTryClose);
qpEl.overlay?.addEventListener('click', () => {
    // Backdrop only closes on Setup / Results.
    if (qpState.screen === 'setup' || qpState.screen === 'results') window.closePracticeDrawer();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && qpEl.drawer && !qpEl.drawer.hidden) qpTryClose();
});

// ── Setup screen controls ────────────────────────────────
qpEl.topicChips?.addEventListener('click', (e) => {
    const chip = e.target.closest('.qp-topic-chip');
    if (!chip) return;
    document.querySelectorAll('.qp-topic-chip').forEach(c => c.classList.toggle('selected', c === chip));
    qpState.topic = chip.dataset.topic;
});
qpEl.diffGrid?.addEventListener('click', (e) => {
    const card = e.target.closest('.qp-diff-card');
    if (!card) return;
    document.querySelectorAll('.qp-diff-card').forEach(c => c.classList.toggle('selected', c === card));
    qpState.difficulty = card.dataset.diff;
});
function qpUpdateStepper() {
    if (!qpEl.stepValueEl) return;
    qpEl.stepValueEl.textContent = String(qpState.numQuestions);
    if (qpEl.stepDownBtn) qpEl.stepDownBtn.disabled = qpState.numQuestions <= 5;
    if (qpEl.stepUpBtn)   qpEl.stepUpBtn.disabled   = qpState.numQuestions >= 20;
}
qpEl.stepUpBtn?.addEventListener('click', () => {
    if (qpState.numQuestions < 20) { qpState.numQuestions++; qpUpdateStepper(); }
});
qpEl.stepDownBtn?.addEventListener('click', () => {
    if (qpState.numQuestions > 5)  { qpState.numQuestions--; qpUpdateStepper(); }
});
function qpSetToggle(on) {
    qpState.timeLimit = !!on;
    if (qpEl.timeToggle) {
        qpEl.timeToggle.classList.toggle('on', !!on);
        qpEl.timeToggle.setAttribute('aria-checked', String(!!on));
    }
    if (qpEl.timePills) qpEl.timePills.classList.toggle('hidden', !on);
}
qpEl.timeToggle?.addEventListener('click', () => qpSetToggle(!qpState.timeLimit));
qpEl.timeToggle?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); qpSetToggle(!qpState.timeLimit); }
});
qpEl.timePills?.addEventListener('click', (e) => {
    const pill = e.target.closest('.qp-time-pill');
    if (!pill) return;
    document.querySelectorAll('.qp-time-pill').forEach(p => p.classList.toggle('selected', p === pill));
    qpState.timeMinutes = parseInt(pill.dataset.mins, 10) || 10;
});
qpEl.generateBtn?.addEventListener('click', () => qpStartGeneration());

// ── Generating screen ───────────────────────────────────
function qpShowGenLoader() {
    qpEl.genInner.innerHTML = `
        <div class="qp-big-spinner"></div>
        <h3 class="qp-gen-title">Generating your quiz…</h3>
        <p class="qp-gen-sub">Creating <strong>${qpState.numQuestions}</strong> <strong>${qpEsc(qpState.difficulty)}</strong> questions on <strong>${qpEsc(qpState.topic)}</strong></p>
        <button class="qp-btn-secondary" id="qp-cancel-gen-btn">Cancel</button>
    `;
    document.getElementById('qp-cancel-gen-btn')?.addEventListener('click', () => {
        if (qpState.genAbort) { try { qpState.genAbort.abort(); } catch (_) {} qpState.genAbort = null; }
        qpGoToScreen('setup');
    });
}
function qpShowGenError(msg) {
    qpEl.genInner.innerHTML = `
        <div class="qp-gen-error">
            <strong>Couldn't generate the quiz</strong>
            ${qpEsc(msg)}
        </div>
        <button class="qp-btn-primary" style="width:auto;padding:0 22px;height:42px" id="qp-retry-gen-btn">Try Again</button>
        <button class="qp-btn-secondary" id="qp-back-setup-btn">Back to Setup</button>
    `;
    document.getElementById('qp-retry-gen-btn')?.addEventListener('click', () => qpStartGeneration());
    document.getElementById('qp-back-setup-btn')?.addEventListener('click', () => qpGoToScreen('setup'));
}

async function qpStartGeneration() {
    qpGoToScreen('generating');
    qpShowGenLoader();
    qpState.genAbort = new AbortController();

    try {
        const API_URL = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL)
            ? String(import.meta.env.VITE_API_URL).replace(/\/$/, '')
            : (window.location.hostname === 'localhost' ? 'http://localhost:8000' : '');

        const body = {
            topic:               qpState.topic,
            unit:                qpState.unit,
            difficulty:          qpState.difficulty,
            num_questions:       qpState.numQuestions,
            time_limit_seconds:  qpState.timeLimit ? qpState.timeMinutes * 60 : 0,
        };

        const res = await fetch(`${API_URL}/study/quiz_panel/generate`, {
            method:  'POST',
            signal:  qpState.genAbort.signal,
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });

        let data = {};
        try { data = await res.json(); } catch (_) {}

        if (!res.ok || !data.questions || !data.questions.length) {
            throw new Error((data && data.error) || `HTTP ${res.status}`);
        }

        // Backend may return more than we asked. Truncate to requested.
        const list = Array.isArray(data.questions) ? data.questions.slice(0, qpState.numQuestions) : [];
        qpState.questions    = list.map(qpNormalizeQuestion);
        qpState.answers      = new Array(qpState.questions.length).fill(null);
        qpState.currentIndex = 0;
        qpState.score        = 0;
        qpState.streak       = 0;
        qpState.answered     = false;
        qpState.locked       = false;

        qpStartQuiz();
    } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.error('[Quiz] generation error:', err);
        qpShowGenError(err && err.message ? err.message : 'Failed to generate quiz.');
    }
}

// Normalize a backend question to the panel's working shape.
// Backend returns: { question, options:["A) ...", ...], correct: "A) text" | "A" | 0..3, steps:[...] }
function qpNormalizeQuestion(q) {
    const opts        = Array.isArray(q.options) ? q.options.slice(0, 4) : [];
    const cleanedOpts = opts.map(o => String(o).replace(/^\s*[A-Da-d][\)\.\:]\s*/, '').trim());

    let correctIdx = -1;
    if (typeof q.correct === 'number') {
        correctIdx = q.correct;
    } else if (typeof q.correct === 'string' && q.correct.length > 0) {
        const letter = q.correct.trim().charAt(0).toUpperCase();
        const i = letter.charCodeAt(0) - 65;
        if (i >= 0 && i < cleanedOpts.length) {
            correctIdx = i;
        } else {
            // Fall back: substring match against original options
            const target = q.correct.trim().toUpperCase();
            const idx = opts.findIndex(o => String(o).trim().toUpperCase().startsWith(target.slice(0, 4)));
            if (idx !== -1) correctIdx = idx;
        }
    }
    if (correctIdx < 0 || correctIdx > 3) correctIdx = 0;

    return {
        question:    String(q.question || ''),
        options:     cleanedOpts,
        correctIdx,
        steps:       Array.isArray(q.steps) ? q.steps : [],
        explanation: String(q.explanation || ''),
    };
}

// ── Active quiz ──────────────────────────────────────────
function qpStartQuiz() {
    qpEl.qTotalEl.textContent = qpState.questions.length;
    qpEl.qIndexEl.textContent = 1;
    qpGoToScreen('quiz');

    qpState.elapsedSeconds   = 0;
    qpState.remainingSeconds = qpState.timeLimit ? (qpState.timeMinutes * 60) : 0;

    if (qpState.timeLimit) {
        qpEl.quizTimer.hidden = false;
        qpUpdateTimerDisplay();
        qpState.timerInterval = setInterval(qpTickCountdown, 1000);
    } else {
        // Count up for the "Time" stat shown on results.
        qpEl.quizTimer.hidden = true;
        qpState.timerInterval = setInterval(() => { qpState.elapsedSeconds++; }, 1000);
    }

    qpRenderCurrentQuestion();
}
function qpTickCountdown() {
    qpState.remainingSeconds--;
    qpState.elapsedSeconds++;
    qpUpdateTimerDisplay();
    if (qpState.remainingSeconds <= 0) {
        qpCleanupTimer();
        qpFinishQuiz(true);
    }
}
function qpUpdateTimerDisplay() {
    if (!qpEl.timerText) return;
    qpEl.timerText.textContent = qpFmtTime(qpState.remainingSeconds);
    qpEl.quizTimer.classList.toggle('warning', qpState.remainingSeconds <= 30);
}
function qpCleanupTimer() {
    if (qpState.timerInterval) {
        clearInterval(qpState.timerInterval);
        qpState.timerInterval = null;
    }
}

function qpRenderCurrentQuestion() {
    const idx = qpState.currentIndex;
    const q   = qpState.questions[idx];
    if (!q) return;

    qpState.answered = false;
    qpState.locked   = false;

    qpEl.qIndexEl.textContent = String(idx + 1);
    qpEl.qNumEl.textContent   = String(idx + 1);
    qpEl.questionText.innerHTML = qpRenderMath(q.question);

    const last = (idx === qpState.questions.length - 1);
    qpEl.nextBtnText.textContent = last ? 'Finish Quiz' : 'Next Question';

    qpEl.optionsGrid.innerHTML = '';
    q.options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = 'qp-option-card';
        btn.type = 'button';
        btn.dataset.idx = String(i);
        btn.innerHTML = `
            <span class="qp-opt-letter">${String.fromCharCode(65 + i)}</span>
            <span class="qp-opt-text">${qpRenderInline(opt)}</span>
        `;
        btn.addEventListener('click', () => qpSelectOption(i, btn));
        qpEl.optionsGrid.appendChild(btn);
    });

    qpEl.stepBtn.hidden    = true;
    qpEl.stepsPanel.hidden = true;
    qpEl.stepsPanel.innerHTML = '';
    if (qpEl.stepBtnText) qpEl.stepBtnText.textContent = 'Show Step-by-Step Solution';

    qpEl.nextBtn.disabled = true;

    const pct = (idx / qpState.questions.length) * 100;
    qpEl.progressBar.style.width = pct + '%';
}
function qpSelectOption(i, btn) {
    if (qpState.locked) return;
    qpState.answers[qpState.currentIndex] = i;
    document.querySelectorAll('#qp-options-grid .qp-option-card').forEach(b => {
        b.classList.toggle('selected', b === btn);
    });
    qpEl.nextBtn.disabled = false;
}

qpEl.nextBtn?.addEventListener('click', () => {
    if (qpState.locked) { qpAdvanceOrFinish(); return; }
    if (qpState.answers[qpState.currentIndex] == null) return;

    // Reveal correct/wrong
    qpState.locked   = true;
    qpState.answered = true;
    const q          = qpState.questions[qpState.currentIndex];
    const correctIdx = q.correctIdx;
    const chosenIdx  = qpState.answers[qpState.currentIndex];
    const isCorrect  = chosenIdx === correctIdx;

    if (isCorrect) { qpState.score++; qpState.streak++; }
    else           { qpState.streak = 0; }

    document.querySelectorAll('#qp-options-grid .qp-option-card').forEach((b, i) => {
        b.classList.add('locked');
        if (i === correctIdx) b.classList.add('correct');
        if (i === chosenIdx && !isCorrect) b.classList.add('wrong');
    });

    if (q.steps && q.steps.length) {
        qpEl.stepBtn.hidden = false;
        qpEl.stepsPanel.innerHTML = q.steps.map((step, si) => `
            <div class="qp-step-item">
                <div class="qp-step-title">${qpEsc(step.title || `Step ${si + 1}`)}</div>
                <div class="qp-step-explanation">${qpRenderMath(step.explanation || '')}</div>
                ${step.formula ? `<div class="qp-step-formula">${qpRenderMath(step.formula)}</div>` : ''}
            </div>
        `).join('');
    }

    setTimeout(() => qpAdvanceOrFinish(), 750);
});

function qpAdvanceOrFinish() {
    if (qpState.currentIndex < qpState.questions.length - 1) {
        qpState.currentIndex++;
        qpRenderCurrentQuestion();
        const pct = (qpState.currentIndex / qpState.questions.length) * 100;
        qpEl.progressBar.style.width = pct + '%';
    } else {
        qpFinishQuiz(false);
    }
}

qpEl.stepBtn?.addEventListener('click', () => {
    const isHidden = qpEl.stepsPanel.hidden;
    qpEl.stepsPanel.hidden = !isHidden;
    if (qpEl.stepBtnText) qpEl.stepBtnText.textContent = isHidden ? 'Hide Solution' : 'Show Step-by-Step Solution';
});

qpEl.quitBtn?.addEventListener('click', () => {
    if (confirm('Quit this quiz? Your progress will be lost.')) {
        qpCleanupTimer();
        qpResetToSetup();
    }
});

// ── Results ──────────────────────────────────────────────
function qpAnimateNumber(el, from, to, dur, fmt) {
    if (!el) return;
    const start = performance.now();
    function tick(now) {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        const val = Math.round(from + (to - from) * eased);
        el.textContent = fmt(val);
        if (t < 1) requestAnimationFrame(tick);
        else el.textContent = fmt(to);
    }
    requestAnimationFrame(tick);
}

function qpFinishQuiz(timedOut) {
    qpCleanupTimer();
    qpEl.progressBar.style.width = '100%';

    const total   = qpState.questions.length;
    const correct = qpState.score;
    const pct     = total > 0 ? Math.round((correct / total) * 100) : 0;
    const elapsed = qpState.elapsedSeconds;

    qpEl.resultsTitle.textContent = `Quiz Complete · ${qpState.topic}` + (timedOut ? ' ' : ' ');

    // Ring animation reset
    const RING_CIRC = 2 * Math.PI * 72;
    if (qpEl.ringFill) {
        qpEl.ringFill.style.transition = 'none';
        qpEl.ringFill.style.strokeDashoffset = String(RING_CIRC);
        void qpEl.ringFill.getBoundingClientRect();
        qpEl.ringFill.style.transition = '';
    }
    if (qpEl.ringPct)   qpEl.ringPct.textContent   = '0%';
    if (qpEl.ringScore) qpEl.ringScore.textContent = `${correct} / ${total} correct`;

    if (qpEl.resScore) qpEl.resScore.textContent = `0/${total}`;
    if (qpEl.resAcc)   qpEl.resAcc.textContent   = '0%';
    if (qpEl.resTime)  qpEl.resTime.textContent  = '00:00';

    qpGoToScreen('results');

    setTimeout(() => {
        if (qpEl.ringFill) qpEl.ringFill.style.strokeDashoffset = String(RING_CIRC - (RING_CIRC * pct / 100));
        qpAnimateNumber(qpEl.ringPct,  0, pct,     1100, v => `${v}%`);
        qpAnimateNumber(qpEl.resScore, 0, correct, 1200, v => `${v}/${total}`);
        qpAnimateNumber(qpEl.resAcc,   0, pct,     1200, v => `${v}%`);
        qpAnimateNumber(qpEl.resTime,  0, elapsed, 1200, v => qpFmtTime(v));
    }, 60);

    // Performance badge
    const badge = qpEl.perfBadge;
    if (badge) {
        badge.classList.remove('good', 'warn');
        if      (pct >= 80) { badge.classList.add('good'); badge.textContent = 'Excellent!'; }
        else if (pct >= 60) {                              badge.textContent = 'Good Job'; }
        else                { badge.classList.add('warn'); badge.textContent = 'Keep Practicing 💪'; }
    }

    qpRenderReviewList();
}

function qpRenderReviewList() {
    const root = qpEl.reviewList;
    if (!root) return;
    root.innerHTML = '';
    const total = qpState.questions.length;
    if (qpEl.reviewCount) qpEl.reviewCount.textContent = `${total} question${total === 1 ? '' : 's'}`;

    qpState.questions.forEach((q, idx) => {
        const chosen      = qpState.answers[idx];
        const isCorrect   = chosen === q.correctIdx;
        const yourText    = chosen == null
            ? '— (no answer)'
            : `${String.fromCharCode(65 + chosen)}) ${q.options[chosen]}`;
        const correctText = `${String.fromCharCode(65 + q.correctIdx)}) ${q.options[q.correctIdx]}`;

        // Build explanation: explicit field wins, otherwise concatenate steps.
        let explHtml = '';
        if (q.explanation) {
            explHtml = qpRenderMath(q.explanation);
        } else if (q.steps && q.steps.length) {
            explHtml = q.steps.map(s => {
                const t = s.title    ? `<strong>${qpEsc(s.title)}.</strong> ` : '';
                const e = s.explanation ? qpRenderMath(s.explanation)         : '';
                const f = s.formula  ? `<div class="qp-review-expl-formula">${qpRenderMath(s.formula)}</div>` : '';
                return t + e + f;
            }).join('<br/>');
        }

        const item = document.createElement('div');
        item.className = 'qp-review-item ' + (isCorrect ? 'correct' : 'wrong');
        item.innerHTML = `
            <button class="qp-review-row" type="button">
                <span class="qp-review-icon">${isCorrect ? '✓' : '✕'}</span>
                <span class="qp-review-q"><strong>Q${idx + 1}</strong>${qpRenderInline(q.question)}</span>
                <span class="qp-review-arrow">›</span>
            </button>
            <div class="qp-review-detail">
                <div class="qp-review-detail-inner">
                    <div class="qp-review-detail-q">${qpRenderMath(q.question)}</div>
                    <div class="qp-review-ans-row ${isCorrect ? 'correct' : 'wrong'}">
                        <span class="lbl">Your answer</span>
                        <span class="val">${qpRenderInline(yourText)}</span>
                    </div>
                    ${isCorrect ? '' : `
                    <div class="qp-review-ans-row correct">
                        <span class="lbl">Correct</span>
                        <span class="val">${qpRenderInline(correctText)}</span>
                    </div>`}
                    ${explHtml ? `<div class="qp-review-expl"><strong>Why:</strong> ${explHtml}</div>` : ''}
                </div>
            </div>
        `;
        item.querySelector('.qp-review-row').addEventListener('click', () => {
            item.classList.toggle('expanded');
        });
        root.appendChild(item);
    });
}

// ── Results action buttons ──────────────────────────────
qpEl.tryAgainBtn?.addEventListener('click', () => qpStartGeneration());
qpEl.newQuizBtn?.addEventListener('click', () => qpResetToSetup());
qpEl.mistakesBtn?.addEventListener('click', () => {
    const items = document.querySelectorAll('.qp-review-item.wrong');
    if (items.length === 0) return;
    items.forEach(it => { if (!it.classList.contains('expanded')) it.classList.add('expanded'); });
    items[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ── Initial setup-UI sync ───────────────────────────────
qpSyncSetupUI();
