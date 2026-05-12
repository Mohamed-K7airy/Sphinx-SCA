// ============================================================
// MATHX — MCQ Mock Bank (PR-B demo-grade)
// ============================================================
// This file exists so the frontend Khan-style quiz UI can ship
// WITHOUT waiting on PR-A (the backend /study/mcq/* endpoints).
//
// DEMO-LEAKAGE: `correctOptionId` and `explanation` are served
// client-side and WILL appear in the DOM. This is acceptable as
// an interim until PR-A lands — at that point swap `getMockTest`
// for the real fetch in quiz.js. Grep for `MOCK-BANK:` to find
// the swap points.
// ============================================================

// Each question: {
//   id, question (LaTeX inside $…$),
//   options [{ id:"a"|"b"|"c"|"d", label, labelAr? }],
//   correctOptionId: "a"|"b"|"c"|"d",
//   explanation, explanationAr, hint, hintAr
// }

const BANK = {
    algebra: [
        {
            id: 'alg-1',
            question: 'Solve for $x$: $\\ 2x + 3 = 11$',
            questionAr: 'أوجد قيمة $x$: $\\ 2x + 3 = 11$',
            options: [
                { id: 'a', label: '$x = 3$' },
                { id: 'b', label: '$x = 4$' },
                { id: 'c', label: '$x = 5$' },
                { id: 'd', label: '$x = 7$' },
            ],
            correctOptionId: 'b',
            explanation: 'Subtract 3 from both sides to get $2x = 8$, then divide by 2 to find $x = 4$.',
            explanationAr: 'اطرح 3 من الطرفين لتحصل على $2x = 8$، ثم اقسم على 2 لتجد $x = 4$.',
            hint: 'Isolate $x$ by reversing the order of operations.',
            hintAr: 'اعزل $x$ بعكس ترتيب العمليات.',
        },
        {
            id: 'alg-2',
            question: 'Factor: $x^2 - 9$',
            questionAr: 'حلّل: $x^2 - 9$',
            options: [
                { id: 'a', label: '$(x - 3)(x - 3)$' },
                { id: 'b', label: '$(x + 3)(x + 3)$' },
                { id: 'c', label: '$(x - 3)(x + 3)$' },
                { id: 'd', label: '$(x - 9)(x + 1)$' },
            ],
            correctOptionId: 'c',
            explanation: 'This is a difference of squares: $a^2 - b^2 = (a-b)(a+b)$, with $a = x$ and $b = 3$.',
            explanationAr: 'هذا فرق بين مربعين: $a^2 - b^2 = (a-b)(a+b)$، حيث $a = x$ و $b = 3$.',
            hint: 'Look for the pattern $a^2 - b^2$.',
            hintAr: 'ابحث عن النمط $a^2 - b^2$.',
        },
        {
            id: 'alg-3',
            question: 'If $3x - 5 = 2x + 4$, what is $x$?',
            questionAr: 'إذا كان $3x - 5 = 2x + 4$، فما قيمة $x$؟',
            options: [
                { id: 'a', label: '$x = -1$' },
                { id: 'b', label: '$x = 1$' },
                { id: 'c', label: '$x = 9$' },
                { id: 'd', label: '$x = -9$' },
            ],
            correctOptionId: 'c',
            explanation: 'Subtract $2x$ from both sides: $x - 5 = 4$. Then add 5 to both sides: $x = 9$.',
            explanationAr: 'اطرح $2x$ من الطرفين: $x - 5 = 4$. ثم أضف 5 إلى الطرفين: $x = 9$.',
            hint: 'Get all the $x$ terms on one side first.',
            hintAr: 'اجمع حدود $x$ في طرف واحد أولاً.',
        },
        {
            id: 'alg-4',
            question: 'Simplify: $\\dfrac{x^2 \\cdot x^3}{x^2}$',
            questionAr: 'بسّط: $\\dfrac{x^2 \\cdot x^3}{x^2}$',
            options: [
                { id: 'a', label: '$x^3$' },
                { id: 'b', label: '$x^5$' },
                { id: 'c', label: '$x^2$' },
                { id: 'd', label: '$x$' },
            ],
            correctOptionId: 'a',
            explanation: 'Multiply powers by adding exponents: $x^2 \\cdot x^3 = x^5$. Then divide by $x^2$ to subtract: $x^{5-2} = x^3$.',
            explanationAr: 'اضرب القوى بجمع الأسس: $x^2 \\cdot x^3 = x^5$. ثم اقسم على $x^2$ بطرح الأس: $x^{5-2} = x^3$.',
            hint: 'Use the exponent rules: $x^a \\cdot x^b = x^{a+b}$ and $\\dfrac{x^a}{x^b} = x^{a-b}$.',
            hintAr: 'استخدم قواعد الأسس: $x^a \\cdot x^b = x^{a+b}$ و $\\dfrac{x^a}{x^b} = x^{a-b}$.',
        },
        {
            id: 'alg-5',
            question: 'What are the roots of $x^2 - 5x + 6 = 0$?',
            questionAr: 'ما هي جذور $x^2 - 5x + 6 = 0$؟',
            options: [
                { id: 'a', label: '$x = 1,\\ x = 6$' },
                { id: 'b', label: '$x = 2,\\ x = 3$' },
                { id: 'c', label: '$x = -2,\\ x = -3$' },
                { id: 'd', label: '$x = 5,\\ x = 6$' },
            ],
            correctOptionId: 'b',
            explanation: 'Factor as $(x-2)(x-3)=0$, so $x = 2$ or $x = 3$.',
            explanationAr: 'حلّل إلى $(x-2)(x-3)=0$، إذن $x = 2$ أو $x = 3$.',
            hint: 'Find two numbers that multiply to 6 and add to 5.',
            hintAr: 'ابحث عن عددين حاصل ضربهما 6 ومجموعهما 5.',
        },
        {
            id: 'alg-6',
            question: 'If $y = 2x + 1$ and $x = 3$, then $y = ?$',
            questionAr: 'إذا كانت $y = 2x + 1$ و $x = 3$، فإن $y = ?$',
            options: [
                { id: 'a', label: '$5$' },
                { id: 'b', label: '$6$' },
                { id: 'c', label: '$7$' },
                { id: 'd', label: '$8$' },
            ],
            correctOptionId: 'c',
            explanation: 'Substitute $x = 3$: $y = 2(3) + 1 = 7$.',
            explanationAr: 'عوّض بـ $x = 3$: $y = 2(3) + 1 = 7$.',
            hint: 'Plug the value of $x$ into the equation.',
            hintAr: 'عوّض قيمة $x$ في المعادلة.',
        },
    ],
    calculus: [
        {
            id: 'calc-1',
            question: 'What is $\\dfrac{d}{dx}(x^2)$?',
            questionAr: 'ما هو $\\dfrac{d}{dx}(x^2)$؟',
            options: [
                { id: 'a', label: '$2x$' },
                { id: 'b', label: '$x$' },
                { id: 'c', label: '$x^2$' },
                { id: 'd', label: '$2$' },
            ],
            correctOptionId: 'a',
            explanation: 'By the power rule: $\\dfrac{d}{dx}(x^n) = n \\cdot x^{n-1}$, so $\\dfrac{d}{dx}(x^2) = 2x$.',
            explanationAr: 'بقاعدة القوة: $\\dfrac{d}{dx}(x^n) = n \\cdot x^{n-1}$، إذن $\\dfrac{d}{dx}(x^2) = 2x$.',
            hint: 'Apply the power rule for derivatives.',
            hintAr: 'طبّق قاعدة القوة للتفاضل.',
        },
        {
            id: 'calc-2',
            question: 'Evaluate: $\\int 3x^2\\,dx$',
            questionAr: 'احسب: $\\int 3x^2\\,dx$',
            options: [
                { id: 'a', label: '$6x + C$' },
                { id: 'b', label: '$x^3 + C$' },
                { id: 'c', label: '$3x^3 + C$' },
                { id: 'd', label: '$\\dfrac{x^3}{3} + C$' },
            ],
            correctOptionId: 'b',
            explanation: 'Using the reverse power rule: $\\int x^n\\,dx = \\dfrac{x^{n+1}}{n+1}$, so $\\int 3x^2\\,dx = 3 \\cdot \\dfrac{x^3}{3} + C = x^3 + C$.',
            explanationAr: 'باستخدام قاعدة القوة العكسية: $\\int x^n\\,dx = \\dfrac{x^{n+1}}{n+1}$، إذن $\\int 3x^2\\,dx = 3 \\cdot \\dfrac{x^3}{3} + C = x^3 + C$.',
            hint: 'Increase the exponent by 1, then divide by the new exponent.',
            hintAr: 'زِد الأس بواحد، ثم اقسم على الأس الجديد.',
        },
        {
            id: 'calc-3',
            question: 'What is $\\displaystyle\\lim_{x \\to 0} \\dfrac{\\sin x}{x}$?',
            questionAr: 'ما هو $\\displaystyle\\lim_{x \\to 0} \\dfrac{\\sin x}{x}$؟',
            options: [
                { id: 'a', label: '$0$' },
                { id: 'b', label: '$1$' },
                { id: 'c', label: '$\\infty$' },
                { id: 'd', label: 'undefined' },
            ],
            correctOptionId: 'b',
            explanation: 'This is a fundamental trig limit: $\\lim_{x \\to 0} \\dfrac{\\sin x}{x} = 1$.',
            explanationAr: 'هذا حدّ مثلثي أساسي: $\\lim_{x \\to 0} \\dfrac{\\sin x}{x} = 1$.',
            hint: 'This is one of the fundamental limits of trigonometry.',
            hintAr: 'هذا أحد الحدود الأساسية في حساب المثلثات.',
        },
        {
            id: 'calc-4',
            question: 'If $f(x) = 3x^4 - 2x$, find $f\'(x)$.',
            questionAr: 'إذا كانت $f(x) = 3x^4 - 2x$، فأوجد $f\'(x)$.',
            options: [
                { id: 'a', label: '$12x^3 - 2$' },
                { id: 'b', label: '$12x^3$' },
                { id: 'c', label: '$3x^3 - 2$' },
                { id: 'd', label: '$x^4 - x^2$' },
            ],
            correctOptionId: 'a',
            explanation: 'Differentiate term by term: $\\dfrac{d}{dx}(3x^4) = 12x^3$ and $\\dfrac{d}{dx}(-2x) = -2$.',
            explanationAr: 'اشتق كل حد على حدة: $\\dfrac{d}{dx}(3x^4) = 12x^3$ و $\\dfrac{d}{dx}(-2x) = -2$.',
            hint: 'Apply the power rule to each term.',
            hintAr: 'طبّق قاعدة القوة على كل حد.',
        },
        {
            id: 'calc-5',
            question: 'What is $\\dfrac{d}{dx}(\\sin x)$?',
            questionAr: 'ما هو $\\dfrac{d}{dx}(\\sin x)$؟',
            options: [
                { id: 'a', label: '$-\\sin x$' },
                { id: 'b', label: '$-\\cos x$' },
                { id: 'c', label: '$\\cos x$' },
                { id: 'd', label: '$\\tan x$' },
            ],
            correctOptionId: 'c',
            explanation: 'The derivative of $\\sin x$ is $\\cos x$. Basic trig derivative.',
            explanationAr: 'مشتقة $\\sin x$ هي $\\cos x$. مشتقة مثلثية أساسية.',
            hint: 'Memorize: $\\sin \\to \\cos$.',
            hintAr: 'احفظ: $\\sin \\to \\cos$.',
        },
        {
            id: 'calc-6',
            question: 'Evaluate: $\\displaystyle\\int_{0}^{1} 2x\\,dx$',
            questionAr: 'احسب: $\\displaystyle\\int_{0}^{1} 2x\\,dx$',
            options: [
                { id: 'a', label: '$0$' },
                { id: 'b', label: '$1$' },
                { id: 'c', label: '$2$' },
                { id: 'd', label: '$\\dfrac{1}{2}$' },
            ],
            correctOptionId: 'b',
            explanation: 'Antiderivative is $x^2$. Evaluate from 0 to 1: $1^2 - 0^2 = 1$.',
            explanationAr: 'الدالة الأصلية هي $x^2$. احسب من 0 إلى 1: $1^2 - 0^2 = 1$.',
            hint: 'Find the antiderivative, then apply the limits.',
            hintAr: 'أوجد الدالة الأصلية، ثم طبّق الحدود.',
        },
    ],
    trigonometry: [
        {
            id: 'trig-1',
            question: 'What is $\\sin(30°)$?',
            questionAr: 'ما قيمة $\\sin(30°)$؟',
            options: [
                { id: 'a', label: '$\\dfrac{1}{2}$' },
                { id: 'b', label: '$\\dfrac{\\sqrt{2}}{2}$' },
                { id: 'c', label: '$\\dfrac{\\sqrt{3}}{2}$' },
                { id: 'd', label: '$1$' },
            ],
            correctOptionId: 'a',
            explanation: '$\\sin(30°) = \\dfrac{1}{2}$ — one of the standard unit-circle values.',
            explanationAr: '$\\sin(30°) = \\dfrac{1}{2}$ — إحدى القيم الأساسية على دائرة الوحدة.',
            hint: 'This is a memorized value from the unit circle.',
            hintAr: 'هذه قيمة محفوظة من دائرة الوحدة.',
        },
        {
            id: 'trig-2',
            question: 'Simplify: $\\sin^2 x + \\cos^2 x$',
            questionAr: 'بسّط: $\\sin^2 x + \\cos^2 x$',
            options: [
                { id: 'a', label: '$0$' },
                { id: 'b', label: '$1$' },
                { id: 'c', label: '$2$' },
                { id: 'd', label: '$\\tan^2 x$' },
            ],
            correctOptionId: 'b',
            explanation: 'The Pythagorean identity: $\\sin^2 x + \\cos^2 x = 1$ for all $x$.',
            explanationAr: 'المتطابقة الفيثاغورية: $\\sin^2 x + \\cos^2 x = 1$ لأي قيمة $x$.',
            hint: 'This is a fundamental Pythagorean identity.',
            hintAr: 'هذه متطابقة فيثاغورية أساسية.',
        },
        {
            id: 'trig-3',
            question: 'What is $\\tan(45°)$?',
            questionAr: 'ما قيمة $\\tan(45°)$؟',
            options: [
                { id: 'a', label: '$0$' },
                { id: 'b', label: '$\\dfrac{\\sqrt{3}}{3}$' },
                { id: 'c', label: '$1$' },
                { id: 'd', label: '$\\sqrt{3}$' },
            ],
            correctOptionId: 'c',
            explanation: '$\\tan(45°) = \\dfrac{\\sin(45°)}{\\cos(45°)} = \\dfrac{\\sqrt{2}/2}{\\sqrt{2}/2} = 1$.',
            explanationAr: '$\\tan(45°) = \\dfrac{\\sin(45°)}{\\cos(45°)} = \\dfrac{\\sqrt{2}/2}{\\sqrt{2}/2} = 1$.',
            hint: 'Use $\\tan = \\dfrac{\\sin}{\\cos}$.',
            hintAr: 'استخدم $\\tan = \\dfrac{\\sin}{\\cos}$.',
        },
        {
            id: 'trig-4',
            question: '$\\cos(0°) = ?$',
            questionAr: '$\\cos(0°) = ?$',
            options: [
                { id: 'a', label: '$0$' },
                { id: 'b', label: '$1$' },
                { id: 'c', label: '$-1$' },
                { id: 'd', label: '$\\dfrac{1}{2}$' },
            ],
            correctOptionId: 'b',
            explanation: 'At $0°$ the cosine is 1 — the $x$-coordinate on the unit circle.',
            explanationAr: 'عند $0°$ قيمة جيب التمام تساوي 1 — وهي الإحداثي السيني على دائرة الوحدة.',
            hint: 'Think about the unit circle at angle 0.',
            hintAr: 'فكّر في دائرة الوحدة عند الزاوية 0.',
        },
        {
            id: 'trig-5',
            question: 'Which is equal to $\\dfrac{1}{\\cos x}$?',
            questionAr: 'أي مما يلي يساوي $\\dfrac{1}{\\cos x}$؟',
            options: [
                { id: 'a', label: '$\\sin x$' },
                { id: 'b', label: '$\\sec x$' },
                { id: 'c', label: '$\\csc x$' },
                { id: 'd', label: '$\\cot x$' },
            ],
            correctOptionId: 'b',
            explanation: 'By definition, $\\sec x = \\dfrac{1}{\\cos x}$.',
            explanationAr: 'بحكم التعريف، $\\sec x = \\dfrac{1}{\\cos x}$.',
            hint: 'Recall the reciprocal trig identities.',
            hintAr: 'تذكّر المتطابقات المثلثية المقلوبة.',
        },
        {
            id: 'trig-6',
            question: 'If $\\sin \\theta = \\dfrac{3}{5}$ and $\\theta$ is acute, what is $\\cos \\theta$?',
            questionAr: 'إذا كان $\\sin \\theta = \\dfrac{3}{5}$ و $\\theta$ حادّة، فما قيمة $\\cos \\theta$؟',
            options: [
                { id: 'a', label: '$\\dfrac{3}{5}$' },
                { id: 'b', label: '$\\dfrac{4}{5}$' },
                { id: 'c', label: '$\\dfrac{5}{3}$' },
                { id: 'd', label: '$\\dfrac{5}{4}$' },
            ],
            correctOptionId: 'b',
            explanation: 'Using $\\sin^2 + \\cos^2 = 1$: $\\cos^2 \\theta = 1 - \\dfrac{9}{25} = \\dfrac{16}{25}$, so $\\cos \\theta = \\dfrac{4}{5}$ (positive since $\\theta$ is acute).',
            explanationAr: 'باستخدام $\\sin^2 + \\cos^2 = 1$: $\\cos^2 \\theta = 1 - \\dfrac{9}{25} = \\dfrac{16}{25}$، إذن $\\cos \\theta = \\dfrac{4}{5}$ (موجبة لأن $\\theta$ حادّة).',
            hint: 'Apply the Pythagorean identity.',
            hintAr: 'طبّق المتطابقة الفيثاغورية.',
        },
    ],
};

// ── Public API ────────────────────────────────────────────────

function pickRandom(arr, n) {
    const copy = arr.slice();
    const out  = [];
    const k    = Math.min(n, copy.length);
    for (let i = 0; i < k; i++) {
        const idx = Math.floor(Math.random() * copy.length);
        out.push(copy[idx]);
        copy.splice(idx, 1);
    }
    return out;
}

/**
 * Get N questions for a branch + difficulty.
 * Currently difficulty is ignored in the mock — PR-A will respect it.
 *
 * @param {string} branch    — 'algebra' | 'calculus' | 'trigonometry'
 * @param {number} count     — 1 or 5
 * @param {string} difficulty — ignored here, passed through for API parity
 * @returns {{ test_id: string, branch: string, questions: Array }}
 */
export function getMockTest(branch, count = 5, difficulty = 'medium') {
    const key  = (branch || 'algebra').toLowerCase();
    const pool = BANK[key] || BANK.algebra;
    const qs   = pickRandom(pool, count);
    return {
        test_id: `mock-${key}-${Date.now()}`,
        branch: key,
        difficulty,
        // MOCK-BANK: correctOptionId + explanation leak client-side.
        // Swap for `/study/mcq/generate` fetch once PR-A lands; the server
        // should strip `correctOptionId` before returning.
        questions: qs,
    };
}

/**
 * Check a single answer against the mock bank.
 * Returns the same shape as the future /study/mcq/check endpoint.
 */
export function checkMockAnswer(question, selectedOptionId, lang = 'en') {
    const correct = question.correctOptionId;
    const explanation = lang === 'ar' ? (question.explanationAr || question.explanation) : question.explanation;
    return {
        is_correct: selectedOptionId === correct,
        correct_option_id: correct,
        explanation,
        points_awarded: selectedOptionId === correct ? 1 : 0,
    };
}

export function getAvailableBranches() {
    return Object.keys(BANK);
}
