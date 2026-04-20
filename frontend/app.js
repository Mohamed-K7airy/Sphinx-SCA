// ============================================================
// Frontend Entry Point — Sphinx-SCA / IntelliMath-AI
// ============================================================
// This file wires together every frontend module and initialises
// Supabase auth, chat history, and the full UI.

import { supabase } from './supabaseClient.js';
import { generateUUID, autoResize, appState } from './lib/helpers.js';
import { initMarkdown } from './lib/markdown.js';
import { initChat, addMessage, handleSend, setChatCallbacks } from './lib/chat.js';
import { initImageUpload } from './lib/imageUpload.js';
import {
    initSidebar,
    initTheme,
    initMode,
    initCalculator,
    initMathToolbar,
    initModals,
    initGraph,
} from './lib/ui.js';

// ── Supabase helpers ──────────────────────────────────────────

async function saveMessageToSupabase(content, sender, imageUrl = null) {
    if (!appState.currentUserId) {
        console.warn('User is not logged in. Message not saved.');
        return;
    }
    const payload = {
        user_id: appState.currentUserId,
        session_id: appState.currentSessionId,
        content,
        sender,
    };
    if (imageUrl) payload.image_url = imageUrl;

    const { data, error } = await supabase.from('messages').insert([payload]);
    if (error) {
        console.error('Error saving message:', error);
        throw error;
    }
    return data;
}

async function fetchUserData(userId) {
    const sidebarHistoryList = document.getElementById('sidebar-history-list');
    try {
        const { data: messages, error } = await supabase
            .from('messages')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(100);

        if (error) throw error;

        if (!sidebarHistoryList) return;
        sidebarHistoryList.innerHTML = '';

        if (messages && messages.length > 0) {
            const sessions = [];
            const seenSessions = new Set();
            messages.forEach((msg) => {
                if (!msg.session_id) return;
                if (!seenSessions.has(msg.session_id) && msg.sender === 'user') {
                    seenSessions.add(msg.session_id);
                    sessions.push(msg);
                }
            });

            // Read the study session registry tagged by study-mode.js
            let studySessionMap = {};
            try { studySessionMap = JSON.parse(localStorage.getItem('study_sessions') || '{}'); } catch (e) { }

            // Read chat session metadata for rename/pin/archive
            let sessionMeta = {};
            try { sessionMeta = JSON.parse(localStorage.getItem('chat_session_meta') || '{}'); } catch (e) { }

            // Filter out archived
            let displaySessions = sessions.filter(s => {
                const meta = sessionMeta[s.session_id] || {};
                return !meta.archived;
            });

            // Sort pinned to top
            displaySessions.sort((a, b) => {
                const aPinned = sessionMeta[a.session_id]?.pinned ? 1 : 0;
                const bPinned = sessionMeta[b.session_id]?.pinned ? 1 : 0;
                return bPinned - aPinned;
            });

            const topSessions = displaySessions.slice(0, 15);

            if (topSessions.length > 0) {
                topSessions.forEach((sessionMsg) => {
                    const sessionId = sessionMsg.session_id;
                    const meta = sessionMeta[sessionId] || {};
                    const displayName = meta.name || sessionMsg.content;
                    const isStudy = studySessionMap[sessionId] === 'study';
                    const li = document.createElement('li');
                    li.className = 'history-item';

                    if (isStudy) {
                        // Study Mode session → redirect to study-mode.html
                        li.innerHTML = `
                            <a href="study-mode.html?session=${sessionId}" class="history-link" data-session-id="${sessionId}">
                                <span class="material-symbols-outlined" style="font-size:14px;flex-shrink:0;color:var(--primary);">school</span>
                                <span class="history-text"></span>
                            </a>
                        `;
                    } else {
                        // Normal chat → load in-page as before
                        li.innerHTML = `
                            <a href="#" class="history-link" data-session-id="${sessionId}">
                                <span class="material-symbols-outlined" style="font-size:14px;flex-shrink:0;">${meta.pinned ? 'push_pin' : 'forum'}</span>
                                <span class="history-text"></span>
                            </a>
                        `;
                        li.querySelector('.history-link').addEventListener('click', (e) => {
                            e.preventDefault();
                            loadSession(sessionId, sessionMsg.user_id);
                        });
                    }

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
                        // Close any other open menus
                        document.querySelectorAll('.history-options-menu.active').forEach(m => {
                            if (m !== optsMenu) {
                                m.classList.remove('active');
                                m.style.position = '';
                                m.style.top = '';
                                m.style.left = '';
                            }
                        });
                        document.querySelectorAll('.history-options-btn.active').forEach(b => {
                            if (b !== optsBtn) b.classList.remove('active');
                        });
                        
                        const isActive = optsMenu.classList.toggle('active');
                        optsBtn.classList.toggle('active');
                        
                        if (isActive) {
                            const rect = optsBtn.getBoundingClientRect();
                            optsMenu.style.position = 'fixed';
                            optsMenu.style.top = (rect.bottom + 4) + 'px';
                            optsMenu.style.left = (rect.left - 130) + 'px';
                            optsMenu.style.right = 'auto';
                            optsMenu.style.zIndex = '99999';
                        } else {
                            optsMenu.style.position = '';
                            optsMenu.style.top = '';
                            optsMenu.style.left = '';
                            optsMenu.style.right = '';
                        }
                    });
                    
                    optsMenu.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const actionBtn = e.target.closest('button[data-action]');
                        if (!actionBtn) return;
                        
                        const action = actionBtn.dataset.action;
                        optsMenu.classList.remove('active');
                        optsMenu.style.position = '';
                        optsMenu.style.top = '';
                        optsMenu.style.left = '';
                        optsMenu.style.right = '';
                        optsBtn.classList.remove('active');
                        
                        let currentMeta = {};
                        try { currentMeta = JSON.parse(localStorage.getItem('chat_session_meta') || '{}'); } catch(err){}
                        if (!currentMeta[sessionId]) currentMeta[sessionId] = {};
                        
                        if (action === 'share') {
                            const url = new URL(window.location.origin + window.location.pathname);
                            url.searchParams.set('session', sessionId);
                            if (isStudy) url.pathname = '/study-mode.html';
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
                                fetchUserData(userId);
                            }
                        } else if (action === 'pin') {
                            currentMeta[sessionId].pinned = !currentMeta[sessionId].pinned;
                            localStorage.setItem('chat_session_meta', JSON.stringify(currentMeta));
                            fetchUserData(userId);
                        } else if (action === 'archive') {
                            currentMeta[sessionId].archived = true;
                            localStorage.setItem('chat_session_meta', JSON.stringify(currentMeta));
                            fetchUserData(userId);
                        } else if (action === 'delete') {
                            const confirmed = (typeof window.showConfirmModal === 'function')
                                ? await window.showConfirmModal('Are you sure you want to delete this chat session?')
                                : confirm('Are you sure you want to delete this chat session?');
                            if (confirmed) {
                                await supabase.from('messages').delete().eq('session_id', sessionId);
                                delete currentMeta[sessionId];
                                localStorage.setItem('chat_session_meta', JSON.stringify(currentMeta));
                                fetchUserData(userId);
                                if (appState.currentSessionId === sessionId) {
                                    appState.currentSessionId = null;
                                    document.getElementById('chat-messages').innerHTML = '';
                                    const heroSection = document.querySelector('.hero');
                                    const chatInterface = document.getElementById('chat-interface');
                                    if (heroSection) heroSection.style.display = 'flex';
                                    if (chatInterface) chatInterface.style.display = 'none';
                                    const floatingWrapper = document.getElementById('floating-search-wrapper');
                                    if (floatingWrapper) floatingWrapper.style.display = 'none';
                                }
                            }
                        }
                    });
                    
                    li.appendChild(optsBtn);
                    li.appendChild(optsMenu);
                    sidebarHistoryList.appendChild(li);
                });
            } else {
                sidebarHistoryList.innerHTML =
                    '<li style="padding: 10px 12px; font-size: 13px; color: var(--text-muted);">No chats yet</li>';
            }
        } else {
            sidebarHistoryList.innerHTML =
                '<li style="padding: 10px 12px; font-size: 13px; color: var(--text-muted);">No chats yet</li>';
        }
    } catch (error) {
        console.error('Error fetching chat history:', error);
        if (typeof window.showAlertModal === 'function') {
            window.showAlertModal('Error', 'Could not load chat history.');
        } else {
            alert('Could not load chat history.');
        }
    }
}

async function loadSession(sessionId, _userId) {
    try {
        const mainSidebar = document.getElementById('main-sidebar');
        const sidebarOverlay = document.getElementById('sidebar-overlay');
        if (window.innerWidth <= 768) {
            if (mainSidebar) mainSidebar.classList.remove('mobile-open');
            if (sidebarOverlay) sidebarOverlay.classList.remove('active');
        }

        const { data: messages, error } = await supabase
            .from('messages')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: true });

        if (error) throw error;

        appState.currentSessionId = sessionId;
        const chatMessages = document.getElementById('chat-messages');
        chatMessages.innerHTML = '';

        if (messages && messages.length > 0) {
            messages.forEach((msg) => {
                addMessage(msg.content, msg.sender, msg.image_url);
            });
        }

        const heroSection = document.querySelector('.hero');
        const chatInterface = document.getElementById('chat-interface');
        const floatingWrapper = document.getElementById('floating-search-wrapper');
        if (heroSection) heroSection.style.display = 'none';
        if (chatInterface) chatInterface.style.display = 'flex';
        if (floatingWrapper) floatingWrapper.style.display = 'flex';
        appState.isChatActive = true;
        document.querySelectorAll('.chat-attach-hide').forEach((el) => el.classList.add('chat-attach-btn-hidden'));

        if (chatInterface) chatInterface.scrollTop = chatInterface.scrollHeight;
    } catch (error) {
        console.error('Error loading session:', error);
        alert('Could not load chat history.');
    }
}

// Expose loadSession globally (called from sidebar history links)
window.loadSession = loadSession;

// ── Main Initialisation ───────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Init rendering engine
    initMarkdown();

    // 2. Provide Supabase callbacks to the chat module
    setChatCallbacks({
        saveMessage: saveMessageToSupabase,
        fetchHistory: () => {
            if (appState.currentUserId) fetchUserData(appState.currentUserId);
        },
    });

    // 3. Init all UI modules
    initSidebar();
    initTheme();
    initMode();
    initCalculator();
    initMathToolbar();
    initModals();
    initGraph();
    initImageUpload();
    initChat();
    
    // Close context menus on click outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.history-item')) {
            document.querySelectorAll('.history-options-menu.active').forEach(m => {
                m.classList.remove('active');
                m.style.position = '';
                m.style.top = '';
                m.style.left = '';
                m.style.right = '';
            });
            document.querySelectorAll('.history-options-btn.active').forEach(b => b.classList.remove('active'));
        }
    });

    // ── Rotating placeholder for main search input ──
    const mainInput = document.getElementById('main-search-input');
    if (mainInput) {
        const placeholders = [
            'Solve x² + 5x + 6 = 0',
            'Find the derivative of sin(x)·eˣ',
            'Integrate ∫ (1/x) dx from 1 to e',
            'Simplify √(50) + 3√(2)',
            'What is the limit of (sin x)/x as x→0?',
            'Factor 2x³ - 6x² + 4x',
        ];
        let placeholderIdx = 0;
        let placeholderInterval;

        function rotatePlaceholder() {
            // Only animate when input is empty & not focused
            if (!mainInput.value && document.activeElement !== mainInput) {
                mainInput.style.transition = 'opacity 0.3s ease';
                mainInput.style.opacity = '0.5';
                setTimeout(() => {
                    placeholderIdx = (placeholderIdx + 1) % placeholders.length;
                    mainInput.placeholder = placeholders[placeholderIdx];
                    mainInput.style.opacity = '1';
                }, 300);
            }
        }

        placeholderInterval = setInterval(rotatePlaceholder, 3500);

        // Pause rotation when input is focused
        mainInput.addEventListener('focus', () => {
            clearInterval(placeholderInterval);
            mainInput.placeholder = 'Type your question here…';
            mainInput.style.opacity = '1';
        });
        mainInput.addEventListener('blur', () => {
            if (!mainInput.value) {
                placeholderInterval = setInterval(rotatePlaceholder, 3500);
            }
        });
    }

    // 4. Supabase Auth — session & user data
    const {
        data: { session },
    } = await supabase.auth.getSession();

    if (session) {
        appState.currentUserId = session.user.id;

        const userMetadata = session.user.user_metadata;
        let firstName = 'User';
        if (userMetadata?.name) {
            firstName = userMetadata.name.split(' ')[0];
        } else if (session.user.email) {
            firstName = session.user.email.split('@')[0];
        }

        const heroTitle = document.querySelector('.hero-title');
        if (heroTitle) heroTitle.textContent = 'Sphinx-SCA Your Personal Math Solver';

        // Hide login, show avatar
        const loginBtn = document.getElementById('nav-login-btn');
        if (loginBtn) loginBtn.style.display = 'none';

        const avatar = document.getElementById('nav-user-avatar');
        if (avatar) {
            avatar.innerHTML = `<img src="user.png" alt="${firstName}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
        }

        const profileContainer = document.getElementById('nav-profile-container');
        if (profileContainer) profileContainer.style.display = 'block';

        // Fetch sidebar history
        fetchUserData(session.user.id);

        // Logout handler
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                const confirmed = (typeof window.showConfirmModal === 'function')
                    ? await window.showConfirmModal('Are you sure you want to log out?')
                    : confirm('Are you sure you want to log out?');
                if (!confirmed) return;
                await supabase.auth.signOut();
                window.location.reload();
            });
        }
    }

    // 5. Suggestion chips
    document.querySelectorAll('.suggestion-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            const prompt = chip.dataset.prompt;
            const input = document.getElementById('main-search-input');
            if (prompt && input) {
                input.value = prompt;
                autoResize(input);
                input.focus();
            }
        });
    });


    //khairy update from 249 to 269
    //(اضافة خاصية محادثات مود المذاكرة + خاصية الملاحظات والتاسكات )

    // 6. URL ?session= param — auto-load a normal chat session when landing
    //    from dashboard.html or any shared link.
    //    Study Mode sessions are handled by study-mode.html, so we skip those.
    const urlParams = new URLSearchParams(window.location.search);
    const sessionParam = urlParams.get('session');
    if (sessionParam) {
        let studySessionMap = {};
        try { studySessionMap = JSON.parse(localStorage.getItem('study_sessions') || '{}'); } catch (e) { }
        if (studySessionMap[sessionParam] === 'study') {
            // Redirect to study-mode.html — wrong page
            window.location.replace(`study-mode.html?session=${sessionParam}`);
        } else {
            // Load normal chat session after auth settles
            setTimeout(() => loadSession(sessionParam, null), 300);
        }
    }
});

window.showShareModal = function(url) {
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

window.showConfirmModal = function(message) {
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
            document.body.removeChild(overlay);
            resolve(result);
        };

        overlay.querySelector('.cancel-btn').addEventListener('click', () => close(false));
        overlay.querySelector('.confirm-btn').addEventListener('click', () => close(true));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    });
};

window.showPromptModal = function(title, defaultValue) {
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
            document.body.removeChild(overlay);
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

window.showAlertModal = function(title, message) {
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
        document.body.removeChild(overlay);
    });
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) document.body.removeChild(overlay);
    });
};
