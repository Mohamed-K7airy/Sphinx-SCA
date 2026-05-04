// ============================================================
// UI Components — Sidebar, Theme, Calculator, Math Toolbar,
//                 Mode Dropdown, Graph, Modals
// ============================================================

import { appState, autoResize } from './helpers.js';

// ── Sidebar ───────────────────────────────────────────────────
export function initSidebar() {
    const mainSidebar = document.getElementById('main-sidebar');
    const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
    const mobileLeftMenuBtn = document.getElementById('mobile-left-menu-btn');
    const sidebarOverlay = document.getElementById('sidebar-overlay');

    if (sidebarToggleBtn && mainSidebar) {
        sidebarToggleBtn.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                mainSidebar.classList.remove('mobile-open');
                if (sidebarOverlay) sidebarOverlay.classList.remove('active');
            } else {
                mainSidebar.classList.toggle('collapsed');
            }
        });
    }

    if (mobileLeftMenuBtn && mainSidebar) {
        mobileLeftMenuBtn.addEventListener('click', () => {
            mainSidebar.classList.add('mobile-open');
            if (sidebarOverlay) sidebarOverlay.classList.add('active');
        });
    }

    if (sidebarOverlay && mainSidebar) {
        sidebarOverlay.addEventListener('click', () => {
            mainSidebar.classList.remove('mobile-open');
            sidebarOverlay.classList.remove('active');
        });
    }
}

// ── Theme ─────────────────────────────────────────────────────
export function initTheme() {
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    const themeIcon = themeToggleBtn?.querySelector('.theme-icon');

    function updateThemeUI() {
        if (!themeIcon) return;
        const isDark = document.body.classList.contains('dark-theme');
        themeIcon.textContent = isDark ? 'light_mode' : 'dark_mode';
    }
    updateThemeUI();

    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            document.documentElement.classList.toggle('dark-theme');
            document.body.classList.toggle('dark-theme');
            const isDark = document.body.classList.contains('dark-theme');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            updateThemeUI();
        });
    }

    // Profile container touch support (mobile)
    const profileContainer = document.getElementById('nav-profile-container');
    if (profileContainer) {
        profileContainer.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                profileContainer.classList.toggle('active');
            }
        });
    }
}

// ── Mode Dropdown & GPT Tabs ──────────────────────────────────
export function initMode() {
    const modeDropdownBtn = document.getElementById('mode-dropdown-btn');
    const modeDropdownMenu = document.getElementById('mode-dropdown-menu');
    const chatModeBtn = document.getElementById('chat-mode-btn');
    const chatModeMenu = document.getElementById('chat-mode-dropdown-menu');
    const modeOptions = document.querySelectorAll('.mode-option');
    const gptTabs = document.querySelectorAll('.gpt-tab');

    const toggleMenu = (menu, e) => {
        e.stopPropagation();
        document.querySelectorAll('.mode-dropdown-menu').forEach((m) => {
            if (m !== menu) m.classList.remove('active');
        });
        menu.classList.toggle('active');
    };

    if (modeDropdownBtn && modeDropdownMenu) {
        modeDropdownBtn.addEventListener('click', (e) => toggleMenu(modeDropdownMenu, e));
    }
    if (chatModeBtn && chatModeMenu) {
        chatModeBtn.addEventListener('click', (e) => toggleMenu(chatModeMenu, e));
    }

    // Close menus on document click
    document.addEventListener('click', () => {
        document.querySelectorAll('.mode-dropdown-menu').forEach((m) => m.classList.remove('active'));
    });

    // Sync helper: update both dropdown buttons
    function syncModeUI(mode) {
        appState.currentMode = mode;
        const option = Array.from(modeOptions).find((o) => o.dataset.mode === mode);
        if (!option) return;

        const text = option.querySelector('span:last-child').textContent;
        const icon = option.querySelector('.material-symbols-outlined').textContent;

        [modeDropdownBtn, chatModeBtn].forEach((btn) => {
            if (!btn) return;
            const dt = btn.querySelector('.dropdown-text');
            const di = btn.querySelector('.dropdown-icon');
            if (dt) dt.textContent = text;
            if (di) di.textContent = icon;
        });

        modeOptions.forEach((o) => o.classList.toggle('active', o.dataset.mode === mode));
        gptTabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
    }

    // GPT Tabs click
    gptTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            const mode = tab.dataset.mode;
            if (!mode) {
                // Coming-soon tab
                const modal = document.getElementById('coming-soon-modal');
                if (modal) { modal.classList.add('active'); modal.style.display = 'flex'; }
                return;
            }
            syncModeUI(mode);
        });
    });

    // Mode dropdown options click
    modeOptions.forEach((option) => {
        option.addEventListener('click', () => {
            syncModeUI(option.dataset.mode);
            document.querySelectorAll('.mode-dropdown-menu').forEach((m) => m.classList.remove('active'));
        });
    });
}

// ── Calculator ────────────────────────────────────────────────
export function initCalculator() {
    let calcExpression = '';
    const calcToggleBtn = document.getElementById('chat-calc-toggle');
    const heroCalcToggle = document.getElementById('hero-calc-toggle');
    const calculatorPanel = document.getElementById('calculatorPanel');
    const calcCloseBtn = document.getElementById('calcCloseBtn');

    const toggleCalculator = () => calculatorPanel?.classList.toggle('open');

    if (calcToggleBtn && calculatorPanel) calcToggleBtn.addEventListener('click', toggleCalculator);
    if (heroCalcToggle && calculatorPanel) heroCalcToggle.addEventListener('click', toggleCalculator);

    if (calcCloseBtn && calculatorPanel) {
        calcCloseBtn.addEventListener('click', () => {
            calculatorPanel.classList.remove('open');
            calcExpression = '';
            const display = document.getElementById('calcDisplay');
            if (display) display.textContent = '0';
        });
    }

    // Calculator button clicks via delegation
    document.querySelector('.calc-grid')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.calc-btn');
        if (!btn) return;
        const val = btn.dataset.calc;
        const display = document.getElementById('calcDisplay');

        if (val === 'AC') {
            calcExpression = '';
            display.textContent = '0';
        } else if (val === '⌫') {
            calcExpression = calcExpression.slice(0, -1);
            display.textContent = calcExpression || '0';
        } else if (val === '=') {
            try {
                const expr = calcExpression.replace(/\^/g, '**').replace(/\(-\)/g, '-');
                // ✅ FIX (C-02): Validate expression before evaluating to prevent code injection
                // Only allow digits, operators, parentheses, and decimal points
                if (!/^[\d+\-*/().%e\s]+$/.test(expr)) {
                    display.textContent = 'Invalid';
                    calcExpression = '';
                    return;
                }
                const result = Function('"use strict"; return (' + expr + ')')();
                if (typeof result !== 'number' || !isFinite(result)) {
                    display.textContent = 'Error';
                    calcExpression = '';
                    return;
                }
                display.textContent = parseFloat(result.toFixed(10)).toString();
                calcExpression = display.textContent;
            } catch {
                display.textContent = 'Error';
                calcExpression = '';
            }
        } else {
            calcExpression += val;
            display.textContent = calcExpression;
        }
    });
}

// ── Math Toolbar ──────────────────────────────────────────────
export function initMathToolbar() {
    const mathToolbar = document.getElementById('math-toolbar');
    const heroMathToggle = document.getElementById('math-keyboard-toggle');
    const chatMathToggle = document.getElementById('chat-math-keyboard-toggle');

    const toggleMathToolbar = () => {
        if (!mathToolbar) return;
        const isVisible = mathToolbar.classList.toggle('visible');
        heroMathToggle?.classList.toggle('active', isVisible);
        chatMathToggle?.classList.toggle('active', isVisible);
    };

    const closeMathToolbar = () => {
        if (!mathToolbar) return;
        mathToolbar.classList.remove('visible');
        heroMathToggle?.classList.remove('active');
        chatMathToggle?.classList.remove('active');
    };

    if (heroMathToggle) heroMathToggle.addEventListener('click', toggleMathToolbar);
    if (chatMathToggle) chatMathToggle.addEventListener('click', toggleMathToolbar);

    const mathToolbarClose = document.getElementById('math-toolbar-close');
    if (mathToolbarClose) mathToolbarClose.addEventListener('click', closeMathToolbar);

    // Symbol insertion helper
    function insertSymbol(symbol) {
        const chatVisible = document.getElementById('chat-interface').style.display !== 'none';
        const target = chatVisible
            ? document.getElementById('chat-search-input')
            : document.getElementById('main-search-input');
        if (!target) return;

        const start = target.selectionStart;
        const end = target.selectionEnd;
        const before = target.value.substring(0, start);
        const after = target.value.substring(end);
        target.value = before + symbol + after;
        target.selectionStart = target.selectionEnd = start + symbol.length;
        target.focus();
        autoResize(target);
    }

    // Initial symbol buttons
    document.querySelectorAll('.math-sym-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.dataset.insert) insertSymbol(btn.dataset.insert);
        });
    });

    // Tab switching with symbol set replacement
    const mathSymbolSets = {
        popular: ['/', 'x^', 'x_', '√(', '∛(', 'log(', '∫', 'Σ', 'π', '∞', '+', '−', '×', '÷', '!', 'log(', 'ln(', 'x^2', 'x^(-1)', '(n choose k)', '∂', 'e^', 'e^(iπ)', '±'],
        trig: ['sin(', 'cos(', 'tan(', 'sec(', 'csc(', 'cot(', 'arcsin(', 'arccos(', 'arctan(', 'sinh(', 'cosh(', 'tanh('],
        calculus: ['∫', '∬', '∮', 'd/dx', '∂', '∂/∂x', 'lim', '→', 'Δ', '∇', 'dy/dx', "d²y/dx²"],
        comparison: ['≥', '≤', '≠', '≈', '≡', '∝', '<', '>', '≫', '≪'],
        sets: ['∈', '∉', '⊂', '⊃', '⊆', '⊇', '∩', '∪', '∅', 'ℝ', 'ℤ', 'ℕ', 'ℚ'],
        arrows: ['→', '←', '↔', '⇒', '⇐', '⇔', '↑', '↓', '⟹', '⟸'],
        greek: ['α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'σ', 'τ', 'φ', 'ω', 'Ω', 'Δ', 'Γ', 'Θ', 'Λ', 'Φ', 'Ψ'],
    };

    const mathTabs = document.querySelectorAll('.math-tab');
    mathTabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            mathTabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');

            const category = tab.dataset.tab;
            const symbols = mathSymbolSets[category] || mathSymbolSets.popular;
            const grid = document.getElementById('math-symbols-grid');
            if (!grid) return;

            grid.innerHTML = symbols
                .map((sym) => {
                    const display = sym.length <= 3 ? sym : sym.replace('(', '');
                    return `<button class="math-sym-btn" data-insert="${sym}" title="${sym}">${display}</button>`;
                })
                .join('');

            // Re-bind
            grid.querySelectorAll('.math-sym-btn').forEach((btn) => {
                btn.addEventListener('click', () => {
                    if (btn.dataset.insert) insertSymbol(btn.dataset.insert);
                });
            });
        });
    });
}

// ── Modals ─────────────────────────────────────────────────────
export function initModals() {
    // Coming Soon modal
    const comingSoonModal = document.getElementById('coming-soon-modal');
    const closeComingSoonBtn = document.getElementById('close-coming-soon');
    if (closeComingSoonBtn && comingSoonModal) {
        closeComingSoonBtn.addEventListener('click', () => {
            comingSoonModal.style.display = 'none';
        });
    }

    // Mic buttons → coming soon
    document.querySelectorAll('.mic-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (comingSoonModal) {
                comingSoonModal.style.display = 'flex';
            }
        });
    });

    // Media zoom modal
    const mediaModal = document.getElementById('media-modal');
    const mediaModalImg = document.getElementById('media-modal-img');
    const mediaModalClose = document.getElementById('media-modal-close');

    // Delegate: clicking any .message-image or [data-action="zoom-media"]
    document.addEventListener('click', (e) => {
        const target = e.target.closest('.message-image, [data-action="zoom-media"]');
        if (target && mediaModal && mediaModalImg) {
            const src = target.src || target.dataset.src;
            if (src) {
                mediaModalImg.src = src;
                mediaModal.classList.add('active');
            }
        }
    });

    if (mediaModalClose && mediaModal) {
        mediaModalClose.addEventListener('click', () => {
            mediaModal.classList.remove('active');
            if (mediaModalImg) mediaModalImg.src = '';
        });
    }
    if (mediaModal) {
        mediaModal.addEventListener('click', (e) => {
            if (e.target === mediaModal) {
                mediaModal.classList.remove('active');
                if (mediaModalImg) mediaModalImg.src = '';
            }
        });
    }
}

// ── Graph (inline mode — MathGPT-style) ──────────────────────
export function initGraph() {
    let graphBubbleCounter = 0;

    // ── Toggle Graph Mode on/off ──
    window.toggleGraphMode = function () {
        appState.graphMode = !appState.graphMode;

        const heroBadge = document.getElementById('hero-graph-mode-badge');
        const chatBadge = document.getElementById('chat-graph-mode-badge');
        const heroBtn = document.getElementById('hero-tool-create-graph');
        const chatBtn = document.getElementById('tool-create-graph');
        const mainInput = document.getElementById('main-search-input');
        const chatInput = document.getElementById('chat-search-input');

        if (appState.graphMode) {
            // Activate graph mode
            if (heroBadge) heroBadge.style.display = 'flex';
            if (chatBadge) chatBadge.style.display = 'flex';
            if (heroBtn) heroBtn.classList.add('active');
            if (chatBtn) chatBtn.classList.add('active');
            if (mainInput) {
                mainInput.placeholder = 'Enter equation: e.g. sin(x), x^2 + 3x - 2, cos(x)*exp(-x/5)';
                mainInput.classList.add('graph-mode-input');
                mainInput.focus();
            }
            if (chatInput) {
                chatInput.placeholder = 'Enter equation: e.g. sin(x), x^2 + 3x - 2, cos(x)*exp(-x/5)';
                chatInput.classList.add('graph-mode-input');
            }
            // Focus the active input
            if (appState.isChatActive && chatInput) { chatInput.focus(); }
            else if (mainInput) { mainInput.focus(); }
        } else {
            // Deactivate graph mode
            if (heroBadge) heroBadge.style.display = 'none';
            if (chatBadge) chatBadge.style.display = 'none';
            if (heroBtn) heroBtn.classList.remove('active');
            if (chatBtn) chatBtn.classList.remove('active');
            if (mainInput) {
                mainInput.placeholder = 'Type your question here…';
                mainInput.classList.remove('graph-mode-input');
            }
            if (chatInput) {
                chatInput.placeholder = 'Ask MATHX…';
                chatInput.classList.remove('graph-mode-input');
            }
        }
    };

    // ── Plot a function into the chat ──
    window.plotFnToChat = function (expr) {
        if (!expr || !expr.trim()) return;
        expr = expr.trim();

        // Transition to chat if needed
        const heroSection = document.querySelector('.hero');
        const chatInterface = document.getElementById('chat-interface');
        if (heroSection && heroSection.style.display !== 'none') {
            heroSection.classList.add('animate-out');
            setTimeout(() => {
                heroSection.style.display = 'none';
                heroSection.classList.remove('animate-out');
            }, 400);
            if (chatInterface) chatInterface.style.display = 'flex';
            const floatingWrapper = document.getElementById('floating-search-wrapper');
            if (floatingWrapper) floatingWrapper.style.display = 'flex';
            appState.isChatActive = true;
            document.querySelectorAll('.chat-attach-hide').forEach(el => el.classList.add('chat-attach-btn-hidden'));
        }

        // Add user message showing the equation
        const chatMessages = document.getElementById('chat-messages');
        const userDiv = document.createElement('div');
        userDiv.classList.add('message', 'user-message');
        userDiv.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: flex-end; width: 100%;">
                <div class="message-content" style="max-width: 100%;">
                    <div class="text-body"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;margin-right:4px;color:var(--primary);">show_chart</span>Plot: ${expr}</div>
                </div>
            </div>
            <div class="message-avatar">
                <img src="user.png" alt="User">
            </div>`;
        chatMessages.appendChild(userDiv);

        // Add AI message with graph
        const bubbleId = 'ggb-bubble-' + (++graphBubbleCounter);
        const aiDiv = document.createElement('div');
        aiDiv.classList.add('message', 'ai-message');
        aiDiv.innerHTML = `
            <div class="message-avatar"><img src="logo.png" alt="AI"></div>
            <div class="message-content" style="max-width:640px; width:100%;">
                <div class="ai-name">MATHX</div>
                <div class="graph-equation-label">
                    <span class="material-symbols-outlined" style="font-size:18px;">show_chart</span>
                    <span>f(x) = ${expr}</span>
                </div>
                <div class="graph-container-wrapper">
                    <div class="graph-loading" id="${bubbleId}-loading">
                        <div class="graph-loading-spinner"></div>
                        <span>Loading graph...</span>
                    </div>
                    <div id="${bubbleId}" style="width:100%; height:420px;"></div>
                </div>
                <div class="message-actions">
                    <button class="action-btn" data-action="copy" title="Copy equation" onclick="navigator.clipboard.writeText('${expr.replace(/'/g, "\\'")}')">
                        <span class="material-symbols-outlined">content_copy</span>
                    </button>
                </div>
            </div>`;
        chatMessages.appendChild(aiDiv);

        // Scroll to bottom
        if (chatInterface) chatInterface.scrollTop = chatInterface.scrollHeight;

        // Load and render GeoGebra
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

    // Keep legacy toggleGraphBar for backward compat
    window.toggleGraphBar = window.toggleGraphMode;
}
