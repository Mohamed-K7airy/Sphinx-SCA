// ============================================================
// math-hub.js  —  Math Topic Hub
// [4] ADD TO <script> (loaded as plain script after study-mode.js)
// ============================================================
// Hardcoded topic/unit data (no backend needed)
// Integrates with existing handleSend() / transitionToChat()
// ============================================================

import { formatMessage } from './markdown.js';

// Resolve the FastAPI base URL the same way study-mode.js does:
//   - Vite dev (npm run dev): VITE_API_URL is empty → use same-origin so the
//     vite proxy forwards /study/* to port 8000
//   - localhost (e.g. opening study-mode.html directly via uvicorn): hit 8000
//   - Production: VITE_API_URL is set at build time
function _apiBase() {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) {
        return String(import.meta.env.VITE_API_URL).replace(/\/$/, '');
    }
    return window.location.hostname === 'localhost' ? 'http://localhost:8000' : '';
}

(function () {
    'use strict';

    // ── Data ─────────────────────────────────────────────────
    const MATH_TOPICS = {
        calculus: {
            label: 'Calculus',
            icon: '∫',
            formulas: [
                { name: 'Derivative (limit def.)', expr: "f'(x) = lim[h→0] (f(x+h)-f(x))/h" },
                { name: 'Power Rule', expr: "d/dx[xⁿ] = n·xⁿ⁻¹" },
                { name: 'Chain Rule', expr: "d/dx[f(g(x))] = f'(g(x))·g'(x)" },
                { name: 'Product Rule', expr: "d/dx[uv] = u'v + uv'" },
                { name: 'Fundamental Theorem', expr: "∫ₐᵇ f(x)dx = F(b) - F(a)" },
                { name: 'Integration by Parts', expr: "∫u dv = uv - ∫v du" },
            ],
            units: [
                'Unit 1: Limits and Continuity',
                'Unit 2: Differentiation – Definition and Fundamentals',
                'Unit 3: Differentiation – Composite & Implicit',
                'Unit 4: Contextual Applications of Differentiation',
                'Unit 5: Analytical Applications of Differentiation',
                'Unit 6: Integration and Accumulation',
                'Unit 7: Differential Equations',
                'Unit 8: Applications of Integration',
            ],
        },
        algebra: {
            label: 'Algebra',
            icon: 'x²',
            formulas: [
                { name: 'Quadratic Formula', expr: 'x = (-b ± √(b²-4ac)) / 2a' },
                { name: 'Difference of Squares', expr: 'a²-b² = (a+b)(a-b)' },
                { name: 'Perfect Square', expr: '(a+b)² = a² + 2ab + b²' },
                { name: 'Slope-Intercept', expr: 'y = mx + b' },
                { name: 'Point-Slope', expr: 'y - y₁ = m(x - x₁)' },
            ],
            units: [
                'Unit 1: Linear Equations',
                'Unit 2: Quadratics',
                'Unit 3: Polynomials',
                'Unit 4: Systems of Equations',
                'Unit 5: Inequalities',
            ],
        },
        statistics: {
            label: 'Statistics',
            icon: 'σ',
            formulas: [
                { name: 'Mean', expr: 'x̄ = (Σxᵢ) / n' },
                { name: 'Variance', expr: 'σ² = Σ(xᵢ - x̄)² / n' },
                { name: 'Standard Deviation', expr: 'σ = √(Σ(xᵢ - x̄)² / n)' },
                { name: 'Z-score', expr: 'z = (x - μ) / σ' },
                { name: 'Bayes Theorem', expr: 'P(A|B) = P(B|A)·P(A) / P(B)' },
            ],
            units: [
                'Unit 1: Descriptive Statistics',
                'Unit 2: Probability',
                'Unit 3: Distributions',
                'Unit 4: Inference',
                'Unit 5: Regression',
            ],
        },
        geometry: {
            label: 'Geometry',
            icon: '△',
            formulas: [
                { name: 'Pythagorean Theorem', expr: 'a² + b² = c²' },
                { name: 'Circle Area', expr: 'A = πr²' },
                { name: 'Circle Circumference', expr: 'C = 2πr' },
                { name: 'Triangle Area', expr: 'A = ½ · b · h' },
                { name: 'Law of Cosines', expr: 'c² = a² + b² - 2ab·cos(C)' },
            ],
            units: [
                'Unit 1: Lines and Angles',
                'Unit 2: Triangles',
                'Unit 3: Circles',
                'Unit 4: Coordinate Geometry',
                'Unit 5: Solid Geometry',
            ],
        },
        linearAlgebra: {
            label: 'Linear Algebra',
            icon: '[]',
            formulas: [
                { name: 'Matrix Multiply', expr: '(AB)ᵢⱼ = Σₖ AᵢₖBₖⱼ' },
                { name: 'Determinant (2×2)', expr: 'det(A) = ad - bc' },
                { name: 'Eigenvalue Eq.', expr: 'Av = λv' },
                { name: 'Dot Product', expr: 'a·b = Σ aᵢbᵢ = |a||b|cos(θ)' },
                { name: 'Cross Product Magnitude', expr: '|a×b| = |a||b|sin(θ)' },
            ],
            units: [
                'Unit 1: Vectors',
                'Unit 2: Matrices',
                'Unit 3: Linear Transformations',
                'Unit 4: Eigenvalues',
                'Unit 5: Vector Spaces',
            ],
        },
    };

    // ── Helpers ──────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);

    /** Pre-fill the hero/chat input and send, the same way topic cards do. */
    function sendToChat(prompt) {
        // If a chat is already active, use the chat input; else use the hero input.
        const type = document.getElementById('study-chat-active')?.style.display === 'none' ? 'hero' : 'chat';
        const input = $(`${type}-search-input`);
        if (input) {
            input.value = prompt;
            // Trigger auto-resize
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Use the existing handleSend if available (it's a module-private function,
        // so we trigger a click on the send button instead — safest integration point)
        const sendBtn = $(`${type}-send-btn`);
        if (sendBtn) sendBtn.click();
    }

    // ── State ────────────────────────────────────────────────
    let activeTopic = null;   // current topic key
    let activeUnit  = null;   // current unit string

    // ── DOM refs ─────────────────────────────────────────────
    const topicPage     = $('mh-topic-page');
    const unitDrawer    = $('mh-unit-drawer');
    const studyMain     = $('study-main');

    // ── Open Topic Page ──────────────────────────────────────
    function openTopicPage(topicKey) {
        const data = MATH_TOPICS[topicKey];
        if (!data || !topicPage) return;
        activeTopic = topicKey;

        // Mark active pill
        document.querySelectorAll('.mh-pill').forEach(p => p.classList.toggle('active', p.dataset.topic === topicKey));

        // Set header
        $('mh-tp-title').textContent = data.label;
        $('mh-tp-icon').textContent  = data.icon;

        // Build unit list
        const ul = $('mh-units-list');
        ul.innerHTML = '';
        data.units.forEach((unitName, i) => {
            const div = document.createElement('div');
            div.className = 'mh-unit-item';
            div.innerHTML = `
                <span class="mh-unit-icon material-symbols-outlined">description</span>
                <span class="mh-unit-name">${unitName}</span>
            `;
            div.addEventListener('click', () => {
                if (window.openUnitPanel) {
                    window.openUnitPanel(topicKey, unitName);
                } else {
                    openUnitDrawer(topicKey, unitName);
                }
            });            ul.appendChild(div);
        });

        // Hide study sheet if open
        $('mh-study-sheet-panel').hidden = true;

        // Show overlay
        topicPage.hidden = false;
        // Ensure the study-page-layout container is positioned (needed for absolute children)
        const layout = document.querySelector('.study-page-layout');
        if (layout) layout.style.position = 'relative';
    }

    // ── Close Topic Page ─────────────────────────────────────
    function closeTopicPage() {
        if (topicPage) topicPage.hidden = true;
        if (unitDrawer) unitDrawer.hidden = true;
        document.querySelectorAll('.mh-pill').forEach(p => p.classList.remove('active'));
        activeTopic = null;
        activeUnit  = null;
    }

    // ── Open Unit Drawer ─────────────────────────────────────
    function openUnitDrawer(topicKey, unitName) {
        const data = MATH_TOPICS[topicKey];
        if (!unitDrawer || !data) return;
        activeUnit = unitName;

        $('mh-ud-unit-label').textContent  = unitName;
        $('mh-ud-topic-label').textContent = data.label;
        unitDrawer.hidden = false;
    }

    // ── Close Unit Drawer ────────────────────────────────────
    function closeUnitDrawer() {
        if (unitDrawer) unitDrawer.hidden = true;
        activeUnit = null;
    }

    // ── Toggle Study Sheet ────────────────────────────────────
    function toggleStudySheet(topicKey) {
        const panel = $('mh-study-sheet-panel');
        if (!panel) return;
        const isHidden = panel.hidden;
        panel.hidden = !isHidden;
        if (isHidden) buildStudySheet(topicKey);
    }

    function buildStudySheet(topicKey) {
        const data = MATH_TOPICS[topicKey];
        if (!data) return;
        const body = $('mh-ss-body');
        body.innerHTML = data.formulas.map(f => `
            <div class="mh-formula-item">
                <span class="mh-formula-name">${f.name}</span>
                <span class="mh-formula-expr">${f.expr}</span>
            </div>`).join('');
    }

    // ── Unit drawer card actions ──────────────────────────────
    function handleDrawerCard(cardId) {
        if (!activeTopic || !activeUnit) return;
        const topicLabel = MATH_TOPICS[activeTopic]?.label || activeTopic;
        let prompt = '';

        if (cardId === 'mh-udc-summary') {
            prompt = `Give me a concise unit summary for "${activeUnit}" from ${topicLabel}. Cover the key concepts, definitions, and important theorems.`;
        } else if (cardId === 'mh-udc-exam') {
            prompt = `Start a practice session on "${activeUnit}" from ${topicLabel}. Give me 5 practice exam questions with increasing difficulty.`;
        } else if (cardId === 'mh-udc-flash') {
            prompt = `Create flashcards for "${activeUnit}" from ${topicLabel}. List 8 key terms and their definitions in a flashcard format.`;
        }

        if (!prompt) return;

        // Close drawer and topic page, then send to chat
        closeUnitDrawer();
        closeTopicPage();
        sendToChat(prompt);
    }

    // ── Wire everything up ───────────────────────────────────
    function init() {
        // Sidebar pills
        document.querySelectorAll('.mh-pill').forEach(pill => {
            pill.addEventListener('click', () => openTopicPage(pill.dataset.topic));
        });

        // Back button
        $('mh-back-btn')?.addEventListener('click', closeTopicPage);

        // Practice Problems card
        $('mh-action-practice')?.addEventListener('click', () => {
            if (!activeTopic) return;
            const label = MATH_TOPICS[activeTopic]?.label || activeTopic;
            if (window.openQuizPanel) {
                // Pass as object with preselected flag — hides topic row
                // since the user already chose the topic from the Hub.
                window.openQuizPanel({ topic: label, preselected: true });
            } else {
                closeTopicPage();
                sendToChat(`Give me a practice problem on ${label}. Walk me through it step by step using the Socratic method.`);
            }
        });

        // Study Sheet card
        $('mh-action-sheet')?.addEventListener('click', () => {
            if (activeTopic) toggleStudySheet(activeTopic);
        });

        // Close study sheet
        $('mh-ss-close')?.addEventListener('click', () => {
            const p = $('mh-study-sheet-panel');
            if (p) p.hidden = true;
        });

        // Unit drawer close
        $('mh-ud-close')?.addEventListener('click', closeUnitDrawer);

        // Unit drawer cards
        ['mh-udc-summary', 'mh-udc-exam', 'mh-udc-flash'].forEach(id => {
            $(id)?.addEventListener('click', () => handleDrawerCard(id));
        });

        // ESC key closes drawer / topic page
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (unitDrawer && !unitDrawer.hidden) { closeUnitDrawer(); return; }
            if (topicPage && !topicPage.hidden)   { closeTopicPage(); }
        });
    }

    // Wait for DOM to be ready (script is deferred after study-mode.js)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ── NEW STUDY GUIDE PANEL ────────────────────────────────
    window.openUnitPanel = function(topicKey, unitName) {
        const data = MATH_TOPICS[topicKey] || { label: topicKey };
        const topicLabel = data.label;

        const overlay = document.getElementById('sg-overlay');
        const panel = document.getElementById('sg-panel');
        if (!overlay || !panel) return;

        overlay.classList.add('open');
        panel.classList.add('open');
        document.getElementById('sg-title').textContent = `Unit: ${unitName} Study Guide`;
        
        // Store current state
        window.__sgCurrentTopicKey = topicKey;
        window.__sgCurrentTopicLabel = topicLabel;
        window.__sgCurrentUnit = unitName;

        // Reset tabs
        document.querySelectorAll('.sg-tab').forEach(t => t.classList.remove('active'));
        const guideTab = document.querySelector('.sg-tab[data-sg-tab="guide"]');
        if (guideTab) guideTab.classList.add('active');

        generateStudyGuide(unitName, topicLabel);
    };

    function initPanelEvents() {
        const backBtn = document.getElementById('sg-back-btn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                document.getElementById('sg-overlay').classList.remove('open');
                document.getElementById('sg-panel').classList.remove('open');
            });
        }

        const printBtn = document.getElementById('sg-print-btn');
        if (printBtn) {
            printBtn.addEventListener('click', () => {
                // calls window.print() on panel content only is handled via CSS @media print
                window.print();
            });
        }

        document.querySelectorAll('.sg-tab').forEach(tab => {
            tab.addEventListener('click', (e) => {
                document.querySelectorAll('.sg-tab').forEach(t => t.classList.remove('active'));
                e.target.classList.add('active');
                window.switchTab(e.target.dataset.sgTab);
            });
        });

        const askBtn = document.getElementById('sg-btn-ask');
        if (askBtn) {
            askBtn.addEventListener('click', () => {
                const unit = window.__sgCurrentUnit;
                const topic = window.__sgCurrentTopicLabel;
                if (!unit || !topic) return;

                // Close the Study Guide panel + ALL hub overlays. Previously
                // only sg-panel was dismissed, which left mh-topic-page on top
                // of the chat so the send-to-chat call appeared to "do
                // nothing" — the message was queued but the chat surface was
                // hidden behind the topic page.
                document.getElementById('sg-overlay')?.classList.remove('open');
                document.getElementById('sg-panel')?.classList.remove('open');
                closeUnitDrawer();
                closeTopicPage();

                const prompt = `I want to study ${unit} from ${topic}. Please help me understand it step by step.`;
                // Defer the send to the next tick so the panel close
                // transitions complete and the input is actually focusable.
                setTimeout(() => sendToChat(prompt), 30);
            });
        }

        const practiceBtn = document.getElementById('sg-btn-practice');
        if (practiceBtn) {
            practiceBtn.addEventListener('click', () => {
                const unit = window.__sgCurrentUnit;
                const topicLabel = window.__sgCurrentTopicLabel;
                document.getElementById('sg-overlay')?.classList.remove('open');
                document.getElementById('sg-panel')?.classList.remove('open');
                closeUnitDrawer();
                closeTopicPage();
                if (window.openPracticeDrawer) {
                    window.openPracticeDrawer(topicLabel, unit);
                } else {
                    console.warn('openPracticeDrawer is not defined');
                }
            });
        }
    }

    window.switchTab = function(tabId) {
        const unit = window.__sgCurrentUnit;
        const topic = window.__sgCurrentTopicLabel;
        if (tabId === 'guide') {
            window.generateStudyGuide(unit, topic);
        } else {
            window.generateCheatsheet(unit, topic);
        }
    };

    // Word-by-word reveal walker, mirrors the chat.js implementation so the
    // study-guide stream feels consistent with assistant replies. Skips
    // already-rendered KaTeX nodes so we don't break formula layout.
    function _wrapWordsInHTML(html, alreadyRenderedWordCount) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        let currentWordIndex = 0;

        const walk = (node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                if (tag === 'code' || tag === 'pre' ||
                    node.classList.contains('math') ||
                    node.classList.contains('katex') ||
                    node.classList.contains('katex-display')) {
                    return;
                }
                for (const child of Array.from(node.childNodes)) walk(child);
            } else if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent;
                if (!text.trim()) return;
                const parts = text.split(/(\s+)/);
                const fragment = document.createDocumentFragment();
                parts.forEach(part => {
                    if (part.trim().length > 0) {
                        if (currentWordIndex >= alreadyRenderedWordCount) {
                            const span = document.createElement('span');
                            span.className = 'word-reveal';
                            const delayIdx = currentWordIndex - alreadyRenderedWordCount;
                            span.style.animationDelay = `${delayIdx * 0.04}s`;
                            span.textContent = part;
                            fragment.appendChild(span);
                        } else {
                            fragment.appendChild(document.createTextNode(part));
                        }
                        currentWordIndex++;
                    } else {
                        fragment.appendChild(document.createTextNode(part));
                    }
                });
                node.replaceWith(fragment);
            }
        };

        walk(tempDiv);
        return { html: tempDiv.innerHTML, totalWords: currentWordIndex };
    }

    // Render an inline error block with a retry button. Used by both the
    // study guide and cheatsheet fetchers so rate-limit messaging is uniform.
    function _renderSgError(body, friendlyMsg, retryFn) {
        // Stash the retry handler on a global counter so the inline onclick=
        // attribute can reference it without `unsafe-eval`.
        const retryKey = `__sgRetry_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        window[retryKey] = () => {
            try { retryFn(); } catch (e) { console.error('[StudyGuide] retry failed:', e); }
            try { delete window[retryKey]; } catch (_) {}
        };
        body.innerHTML = `
            <div style="padding:1rem; border-left:3px solid var(--accent-color, var(--primary)); color:var(--text-secondary); background:var(--bg-secondary); border-radius:8px;">
                <strong style="color:var(--text-primary);">Could not load this content</strong><br>
                <span style="font-size:13px;">${_esc(friendlyMsg)}</span><br><br>
                <button onclick="window['${retryKey}']()"
                    style="padding:6px 16px; border-radius:6px; cursor:pointer; background:var(--primary); color:#fff; border:none; font-size:13px; font-weight:600;">
                    ↻ Retry
                </button>
            </div>
        `;
    }

    function _friendlyErrorMessage(raw) {
        let msg = (raw == null ? '' : String(raw)) || 'Unknown error';
        const lower = msg.toLowerCase();
        if (msg.includes('429') || lower.includes('rate_limit') || lower.includes('rate limit')) {
            msg = 'Rate limit reached. Please wait 1-2 minutes and try again.';
        }
        return msg;
    }

    window.generateStudyGuide = async function(unitName, topicName) {
        const body = document.getElementById('sg-body');
        if (!body) return;
        body.innerHTML = `
            <div class="sg-skeleton">
                <div class="sg-skeleton-bar"></div>
                <div class="sg-skeleton-bar"></div>
                <div class="sg-skeleton-bar"></div>
            </div>
        `;

        try {
            const res = await fetch(`${_apiBase()}/study/study_guide/generate`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ unit: unitName, topic: topicName }),
            });

            // Backend always returns JSON now (post FIX 1+5). Pull the body once.
            let data = {};
            try { data = await res.json(); } catch (_) { /* unparseable body */ }

            if (!res.ok || !data.markdown) {
                const errMsg = _friendlyErrorMessage((data && data.error) || `HTTP ${res.status}`);
                _renderSgError(body, errMsg, () => window.generateStudyGuide(unitName, topicName));
                return;
            }

            body.innerHTML = '<div id="sg-guide-content" class="sg-guide-content"></div>';
            const contentDiv = document.getElementById('sg-guide-content');

            // Render the full markdown via KaTeX, then wrap text words in
            // `.word-reveal` spans so the existing chat animation plays once.
            const rendered = formatMessage(data.markdown);
            const { html } = _wrapWordsInHTML(rendered, 0);
            contentDiv.innerHTML = html;

            // Post-process: add numbered badges to <h2> headings + highlight
            // key math terms on first occurrence (orange accent).
            _enhanceStudyGuideContent(contentDiv);

        } catch (e) {
            console.error('[StudyGuide] error:', e);
            const friendly = _friendlyErrorMessage(e && e.message);
            _renderSgError(body, friendly, () => window.generateStudyGuide(unitName, topicName));
        }
    };

    // Tiny escape helper for the only place we drop user-driven text into innerHTML
    // (formula title and note). The formula itself is rendered via KaTeX so it does
    // not need HTML escaping — formatMessage handles that path.
    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    window.generateCheatsheet = async function(unitName, topicName) {
        const body = document.getElementById('sg-body');
        if (!body) return;
        body.innerHTML = `
            <div class="sg-skeleton">
                <div class="sg-skeleton-bar"></div>
                <div class="sg-skeleton-bar"></div>
                <div class="sg-skeleton-bar"></div>
            </div>
        `;

        try {
            const res = await fetch(`${_apiBase()}/study/cheatsheet/generate`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ unit: unitName, topic: topicName }),
            });

            // Pull the body once whether res.ok or not — backend always returns JSON.
            let data = {};
            try { data = await res.json(); } catch (_) { /* unparseable body */ }

            const list = Array.isArray(data.cheatsheet) ? data.cheatsheet : [];

            if (!res.ok || !list.length) {
                const errMsg = _friendlyErrorMessage(
                    (data && data.error) || (res.ok ? 'Cheatsheet came back empty.' : `HTTP ${res.status}`)
                );
                _renderSgError(body, errMsg, () => window.generateCheatsheet(unitName, topicName));
                return;
            }

            body.innerHTML = '';
            list.forEach(item => {
                const card = document.createElement('div');
                card.className = 'sg-cheat-card';

                // KaTeX renders the formula inline via formatMessage('$$…$$').
                // Title / note are escaped to avoid breaking layout if the LLM
                // emits stray HTML or angle brackets.
                const formulaHtml = formatMessage(`$$${item.formula || ''}$$`);
                card.innerHTML = `
                    <div class="sg-cheat-title">${_esc(item.title)}</div>
                    <button class="sg-cheat-copy" title="Copy Formula">
                        <span class="material-symbols-outlined" style="font-size:16px;">content_copy</span>
                    </button>
                    <div class="sg-cheat-formula">${formulaHtml}</div>
                    <div class="sg-cheat-note">${_esc(item.note)}</div>
                `;
                card.querySelector('.sg-cheat-copy').addEventListener('click', () => {
                    try { navigator.clipboard.writeText(String(item.formula || '')); } catch (_) {}
                });
                body.appendChild(card);
            });
        } catch (e) {
            console.error('[Cheatsheet] error:', e);
            const friendly = _friendlyErrorMessage(e && e.message);
            _renderSgError(body, friendly, () => window.generateCheatsheet(unitName, topicName));
        }
    };

    // ─── Study Guide content post-processor ─────────────────────
    // Adds numbered section badges + highlights key math terms on first
    // occurrence. Runs after the rendered markdown lands in the DOM.
    const SG_KEY_TERMS = [
        // Calculus
        'limit', 'continuity', 'derivative', 'integral', 'antiderivative',
        'differential equation', 'L\'Hôpital\'s rule', "L'Hôpital", 'chain rule',
        'product rule', 'quotient rule', 'power rule', 'fundamental theorem',
        'integration by parts', 'squeeze theorem', 'indeterminate form',
        'continuous', 'differentiable', 'integrable', 'convergent', 'divergent',
        'asymptote', 'inflection', 'concavity', 'tangent', 'normal',
        // Algebra
        'polynomial', 'quadratic', 'logarithm', 'exponential', 'factor',
        'discriminant', 'binomial', 'expansion', 'inequality', 'equation',
        // Geometry
        'theorem', 'pythagorean', 'triangle', 'circle', 'angle',
        'congruent', 'similar', 'perpendicular', 'parallel', 'radius',
        // Stats
        'mean', 'median', 'mode', 'variance', 'standard deviation',
        'probability', 'distribution', 'z-score', 'regression', 'correlation',
        // Linear algebra
        'matrix', 'vector', 'eigenvalue', 'eigenvector', 'determinant',
        'transpose', 'inverse', 'identity matrix', 'linear combination',
        'span', 'basis', 'orthogonal',
        // General
        'definition', 'property', 'function', 'formula',
    ];

    function _enhanceStudyGuideContent(root) {
        if (!root) return;

        // 1. Section badges on h2s
        const h2s = root.querySelectorAll('h2');
        h2s.forEach((h, i) => {
            if (h.querySelector('.sg-section-num')) return;
            const badge = document.createElement('span');
            badge.className = 'sg-section-num';
            badge.textContent = String(i + 1);
            h.insertBefore(badge, h.firstChild);
        });

        // 2. First-occurrence key-term highlighting (skip code/katex/headings)
        const SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'A',
                                   'H1', 'H2', 'H3', 'H4', 'TH']);
        const isKatex = (n) => n && n.classList && (
            n.classList.contains('katex') ||
            n.classList.contains('katex-display') ||
            n.classList.contains('katex-mathml') ||
            n.classList.contains('katex-html')
        );

        const textNodes = [];
        (function walk(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                if (SKIP_TAGS.has(node.tagName)) return;
                if (isKatex(node)) return;
                for (const child of Array.from(node.childNodes)) walk(child);
            } else if (node.nodeType === Node.TEXT_NODE) {
                if (node.textContent && node.textContent.trim()) textNodes.push(node);
            }
        })(root);

        for (const term of SG_KEY_TERMS) {
            // Word-boundary regex; escape special chars in term
            const escaped = term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
            const regex = new RegExp('\\b(' + escaped + ')\\b', 'i');
            for (const node of textNodes) {
                if (!node.parentNode) continue; // already replaced
                const m = node.textContent.match(regex);
                if (!m || m.index == null) continue;

                const before  = node.textContent.slice(0, m.index);
                const matched = m[0];
                const after   = node.textContent.slice(m.index + matched.length);

                const span = document.createElement('span');
                span.className = 'sg-key-term';
                span.textContent = matched;

                const frag = document.createDocumentFragment();
                if (before) frag.appendChild(document.createTextNode(before));
                frag.appendChild(span);
                if (after)  frag.appendChild(document.createTextNode(after));
                node.replaceWith(frag);
                break; // first occurrence found; move on
            }
        }
    }

    // ─── Scroll-progress bar (driven by sg-body scroll position) ──
    function _initSgScrollProgress() {
        const body = document.getElementById('sg-body');
        const bar  = document.getElementById('sg-progress-bar');
        if (!body || !bar) return;
        if (body.__sgProgressBound) return;
        body.__sgProgressBound = true;

        const update = () => {
            const max = body.scrollHeight - body.clientHeight;
            const pct = max > 0 ? (body.scrollTop / max) * 100 : 0;
            bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
        };
        body.addEventListener('scroll', update, { passive: true });
        update();

        // Reset / recompute when content changes (tab swap, fresh fetch, …).
        try {
            const obs = new MutationObserver(() => requestAnimationFrame(update));
            obs.observe(body, { childList: true, subtree: true });
        } catch (_) { /* MutationObserver not available */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { initPanelEvents(); _initSgScrollProgress(); });
    } else {
        initPanelEvents();
        _initSgScrollProgress();
    }
})();
