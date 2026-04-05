/* ============================================================
   AMC 8 Timer Tracker – Application Logic
   ============================================================ */

(function () {
    'use strict';

    // ── Constants ──────────────────────────────────────────────
    const TOTAL_TIME = 40 * 60; // 40 minutes in seconds
    const CHOICES = ['A', 'B', 'C', 'D', 'E'];
    const WIKI_API = 'https://artofproblemsolving.com/wiki/api.php';

    // ── State ──────────────────────────────────────────────────
    let problems = [];          // { number, htmlContent }
    let answerKey = [];          // ['A', 'B', ...]
    let userAnswers = [];        // ['A', null, 'C', ...]   (null = unanswered)
    let problemTimes = [];       // seconds spent per problem
    let currentProblem = 0;      // index of the problem whose timer is running
    let problemStartTime = 0;    // Date.now() when current problem timer started
    let globalRemaining = TOTAL_TIME;
    let globalTimerInterval = null;
    let problemTimerInterval = null;
    let testActive = false;
    let testFinished = false;
    let totalElapsed = 0;        // total wall-clock seconds used
    let testTitle = '';

    // ── DOM References ──────────────────────────────────────────
    const $landing    = document.getElementById('landing-screen');
    const $test       = document.getElementById('test-screen');
    const $results    = document.getElementById('results-screen');
    const $urlInput   = document.getElementById('problem-url');
    const $startBtn   = document.getElementById('start-btn');
    const $errorMsg   = document.getElementById('error-msg');
    const $countdown  = document.getElementById('countdown-time');
    const $progressText = document.getElementById('progress-text');
    const $progressBar  = document.getElementById('progress-bar');
    const $testTitle  = document.getElementById('test-title');
    const $navInner   = document.getElementById('nav-inner');
    const $problems   = document.getElementById('problems-container');
    const $finishBtn  = document.getElementById('finish-btn');
    const $finishModal = document.getElementById('finish-modal');
    const $modalCancel = document.getElementById('modal-cancel');
    const $modalConfirm = document.getElementById('modal-confirm');

    // ── Initialization ──────────────────────────────────────────
    $urlInput.addEventListener('input', () => {
        $startBtn.disabled = !isValidUrl($urlInput.value.trim());
    });

    $startBtn.addEventListener('click', handleStart);

    $urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !$startBtn.disabled) handleStart();
    });

    $finishBtn.addEventListener('click', () => {
        $finishModal.classList.add('active');
    });

    $modalCancel.addEventListener('click', () => {
        $finishModal.classList.remove('active');
    });

    $modalConfirm.addEventListener('click', () => {
        $finishModal.classList.remove('active');
        finishTest();
    });

    // Close modal on escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && $finishModal.classList.contains('active')) {
            $finishModal.classList.remove('active');
        }
    });

    // Event delegation for choices and change answer (moved outside buildTestUI)
    $problems.addEventListener('click', (e) => {
        const choiceBtn = e.target.closest('.choice-btn');
        const changeBtn = e.target.closest('.btn-change');

        if (choiceBtn) {
            const pi = parseInt(choiceBtn.dataset.problem);
            if (!testFinished) {
                selectChoice(pi, choiceBtn.dataset.choice);
            }
        }

        if (changeBtn) {
            const pi = parseInt(changeBtn.dataset.problem);
            allowChangeAnswer(pi);
        }
    });

    document.getElementById('retry-btn').addEventListener('click', () => {
        location.reload();
    });

    // ── URL Validation ──────────────────────────────────────────
    function isValidUrl(url) {
        return /artofproblemsolving\.com\/wiki/.test(url) &&
               /_AMC_8_Problems/.test(url);
    }

    // ── Extract page title from URL ─────────────────────────────
    function extractPageTitle(url) {
        // Handle ?title=XXXX format
        let match = url.match(/[?&]title=([^&]+)/);
        if (match) return decodeURIComponent(match[1]);

        // Handle /wiki/index.php/XXXX format
        match = url.match(/\/wiki\/index\.php\/([^?#]+)/);
        if (match) return decodeURIComponent(match[1]);

        return null;
    }

    // ── Start Handler ───────────────────────────────────────────
    async function handleStart() {
        const url = $urlInput.value.trim();
        if (!isValidUrl(url)) return;

        showLoading(true);
        showError('');

        try {
            const pageTitle = extractPageTitle(url);
            if (!pageTitle) throw new Error('Could not extract page title from URL.');

            // Derive answer key title
            const answerTitle = pageTitle.replace('_Problems', '_Answer_Key');

            // Derive human-readable title
            testTitle = pageTitle.replace(/_/g, ' ').replace(' Problems', '');

            // Fetch both pages using MediaWiki API with CORS
            const [problemsHtml, answersHtml] = await Promise.all([
                fetchWikiPage(pageTitle),
                fetchWikiPage(answerTitle)
            ]);

            // Parse
            problems = parseProblems(problemsHtml);
            answerKey = parseAnswerKey(answersHtml);

            if (problems.length === 0) {
                throw new Error('Could not parse any problems from the page. Please check the URL.');
            }

            if (answerKey.length === 0) {
                throw new Error('Could not parse the answer key. Please check the URL.');
            }

            // Initialize state
            userAnswers = new Array(problems.length).fill(null);
            problemTimes = new Array(problems.length).fill(0);
            currentProblem = 0;
            globalRemaining = TOTAL_TIME;
            testActive = true;
            testFinished = false;
            totalElapsed = 0;

            // Build UI
            buildTestUI();

            // Switch screens
            switchScreen('test');

            // Start timers
            startGlobalTimer();
            startProblemTimer(0);

        } catch (err) {
            showError(err.message || 'Failed to load the problems. Please try again.');
            console.error(err);
        } finally {
            showLoading(false);
        }
    }

    // ── Fetch Wiki Page via MediaWiki API (CORS-friendly) ──────
    async function fetchWikiPage(pageTitle) {
        const apiUrl = `${WIKI_API}?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text&format=json&origin=*`;
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error(`Failed to fetch page (${res.status})`);
        const data = await res.json();

        if (data.error) {
            throw new Error(`Wiki API error: ${data.error.info || data.error.code}`);
        }

        return data.parse.text['*'];
    }

    // ── Fix URLs in HTML content ────────────────────────────────
    function fixUrls(html) {
        // 1. Fix protocol-relative URLs (//latex.artofproblemsolving.com/...)
        //    These MUST be handled first, before other replacements
        html = html.replace(/src="\/\//g, 'src="https://');
        html = html.replace(/srcset="\/\//g, 'srcset="https://');

        // 2. Fix absolute paths starting with /wiki/...
        html = html.replace(/src="\/wiki/g, 'src="https://artofproblemsolving.com/wiki');
        html = html.replace(/srcset="\/wiki/g, 'srcset="https://artofproblemsolving.com/wiki');

        // 3. Fix remaining relative paths starting with / (but NOT //)
        html = html.replace(/src="\/([^\/])/g, 'src="https://artofproblemsolving.com/$1');
        html = html.replace(/srcset="\/([^\/])/g, 'srcset="https://artofproblemsolving.com/$1');

        // 4. Fix href for links
        html = html.replace(/href="\/wiki/g, 'href="https://artofproblemsolving.com/wiki');

        return html;
    }

    // ── Extract answer choices from DOM elements ──────────────────
    function extractChoicesFromElements(elements) {
        console.log(`Searching through ${elements.length} elements for choices...`);
        // 1. Look for images with (A) and (B) in alt text
        for (const el of elements) {
            const imgs = el.querySelectorAll ? el.querySelectorAll('img') : [];
            for (const img of imgs) {
                const alt = img.getAttribute('alt') || '';
                if (alt.includes('(A)') && alt.includes('(B)')) {
                    console.log('Found potential choices image:', alt);
                    const choices = parseChoicesFromAlt(alt);
                    if (choices) return choices;
                }
            }
            
            // 2. Fallback: check if the text content looks like choices
            const text = el.textContent || '';
            if (text.includes('(A)') && text.includes('(B)') && text.includes('(C)')) {
                console.log('Found potential text-based choices:', text);
                const choices = parseChoicesFromAlt(text);
                if (choices) return choices;
            }
        }
        return null;
    }

    function parseChoicesFromAlt(alt) {
        console.log('Parsing text for choices:', alt);
        const choices = {};
        
        // 1. Pre-clean
        let cleanText = alt
            .replace(/\\textbf\{/g, '')
            .replace(/\\mathrm\{/g, '')
            .replace(/\\math\w+\{/g, '')
            .replace(/[\{\}\$]/g, '')
            .replace(/\\qquad/g, '  ')
            .replace(/\\quad/g, ' ')
            .replace(/\\ /g, ' ')
            .replace(/\\,/g, ' ');

        // 2. Extract using regex
        // We look for (X) followed by anything until the next (Y) or end
        const letters = ['A', 'B', 'C', 'D', 'E'];
        for (let i = 0; i < letters.length; i++) {
            const letter = letters[i];
            const nextLetter = letters[i + 1];
            
            const startStr = `(${letter})`;
            const startPos = cleanText.indexOf(startStr);
            if (startPos === -1) continue;

            let endPos = cleanText.length;
            if (nextLetter) {
                const nextStr = `(${nextLetter})`;
                const nextPos = cleanText.indexOf(nextStr, startPos + 3);
                if (nextPos !== -1) endPos = nextPos;
            }

            let val = cleanText.substring(startPos + 3, endPos);
            
            // Clean up remaining LaTeX
            val = val
                .replace(/\\[a-zA-Z]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
                
            if (val) choices[letter] = val;
        }

        console.log('Parsed choices result:', choices);
        return Object.keys(choices).length >= 3 ? choices : null;
    }

    // ── Parse Problems from HTML ────────────────────────────────
    function parseProblems(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const result = [];

        // Find all elements that contain "Problem N" headings
        const headings = doc.querySelectorAll('h2');
        const problemHeadings = [];

        headings.forEach(h => {
            const span = h.querySelector('.mw-headline');
            if (span) {
                const text = span.textContent.trim();
                const match = text.match(/^Problem\s+(\d+)$/);
                if (match) {
                    problemHeadings.push({ number: parseInt(match[1]), element: h });
                }
            }
        });

        // Sort by problem number
        problemHeadings.sort((a, b) => a.number - b.number);

        // Extract content between consecutive problem headings
        for (let i = 0; i < problemHeadings.length; i++) {
            const startEl = problemHeadings[i].element;
            const endEl = i + 1 < problemHeadings.length
                ? problemHeadings[i + 1].element
                : null;

            // Collect DOM elements between headings
            const contentElements = [];
            let el = startEl.nextElementSibling;
            while (el && el !== endEl) {
                // Skip "See Also" heading
                if (el.tagName === 'H2') break;

                const text = el.textContent.trim();
                const hasImage = el.querySelector('img') !== null;
                
                // Skip only if it has no text AND no image (truly empty)
                if (!hasImage && text === '') {
                    el = el.nextElementSibling;
                    continue;
                }

                // If it's a "Solution" link, skip it
                if (text === 'Solution' || (el.querySelector('a') && text === 'Solution')) {
                    el = el.nextElementSibling;
                    continue;
                }

                // Skip edit section links
                if (el.classList && el.classList.contains('mw-editsection')) {
                    el = el.nextElementSibling;
                    continue;
                }

                contentElements.push(el);
                el = el.nextElementSibling;
            }

            // Extract choices from DOM elements BEFORE converting to HTML
            const choices = extractChoicesFromElements(contentElements);

            // Re-build HTML string from elements, but hide the choice image if we extracted it
            let finalContentHtml = '';
            contentElements.forEach(ce => {
                let html = ce.outerHTML;
                if (choices) {
                    // Remove the choice image if we extracted values
                    // Use a broad search for any image with (A) and (B) in alt
                    html = html.replace(/<img[^>]*alt="[^"]*\(A\)[^"]*\(B\)[^"]*"[^>]*\/?>/gi, '');
                }
                finalContentHtml += html;
            });

            // Fix all URLs
            finalContentHtml = fixUrls(finalContentHtml);

            // Remove solution paragraph/links
            finalContentHtml = finalContentHtml.replace(/<p>\s*<a[^>]*>Solution<\/a>\s*<\/p>/gi, '');
            finalContentHtml = finalContentHtml.replace(/<a[^>]*>Solution<\/a>/gi, '');

            result.push({
                number: problemHeadings[i].number,
                htmlContent: finalContentHtml,
                choices: choices
            });
        }

        return result;
    }

    // ── Parse Answer Key ────────────────────────────────────────
    function parseAnswerKey(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const answers = [];

        // Try to find ordered list items
        const listItems = doc.querySelectorAll('ol li');
        if (listItems.length > 0) {
            listItems.forEach(li => {
                const text = li.textContent.trim();
                const match = text.match(/^\s*\(?([A-E])\)?\.?\s*$/);
                if (match) {
                    answers.push(match[1]);
                }
            });
        }

        // If the OL approach worked, return
        if (answers.length >= 20) return answers;

        // Fallback: parse plain text
        answers.length = 0;
        const bodyText = doc.body ? doc.body.textContent : html;
        const lines = bodyText.split('\n');
        for (const line of lines) {
            const match = line.trim().match(/^(\d+)\.\s*\(?([A-E])\)?/);
            if (match) {
                const num = parseInt(match[1]);
                if (num === answers.length + 1) {
                    answers.push(match[2]);
                }
            }
        }

        // Another fallback - look for formatted text like "1. E" across the whole content
        if (answers.length < 20) {
            answers.length = 0;
            const allText = (doc.body ? doc.body.textContent : html);
            const regex = /(\d+)\.\s*\(?([A-E])\)?/g;
            let m;
            while ((m = regex.exec(allText)) !== null) {
                const num = parseInt(m[1]);
                if (num === answers.length + 1) {
                    answers.push(m[2]);
                }
            }
        }

        return answers;
    }

    // ── Build Test UI ───────────────────────────────────────────
    function buildTestUI() {
        $testTitle.textContent = testTitle;

        // Navigation buttons
        $navInner.innerHTML = '';
        problems.forEach((p, i) => {
            const btn = document.createElement('button');
            btn.className = 'nav-btn';
            btn.textContent = p.number;
            btn.id = `nav-btn-${i}`;
            btn.addEventListener('click', () => {
                scrollToProblem(i);
            });
            $navInner.appendChild(btn);
        });

        // Problem cards
        $problems.innerHTML = '';
        problems.forEach((p, i) => {
            const card = document.createElement('div');
            card.className = 'problem-card';
            card.id = `problem-${i}`;

            card.innerHTML = `
                <div class="problem-header">
                    <div class="problem-number">
                        <div class="problem-badge">${p.number}</div>
                        <span class="problem-label">Problem ${p.number}</span>
                    </div>
                    <div class="problem-timer" id="timer-${i}">
                        <span class="dot"></span>
                        <span class="timer-value">0:00</span>
                    </div>
                </div>
                <div class="problem-content">${p.htmlContent}</div>
                <div class="choices-grid" id="choices-${i}">
                    ${CHOICES.map(ch => {
                        const hasChoices = p.choices && typeof p.choices === 'object';
                        const choiceVal = (hasChoices && p.choices[ch]) ? p.choices[ch] : '';
                        return `
                            <button class="choice-btn" data-problem="${i}" data-choice="${ch}">
                                <span class="choice-letter">${ch}</span>
                                <span class="choice-text">${choiceVal}</span>
                            </button>
                        `;
                    }).join('')}
                </div>
                <div class="change-answer-container">
                    <button class="btn-change" id="change-${i}" data-problem="${i}">Change Answer</button>
                </div>
            `;

            $problems.appendChild(card);
        });

        updateProgress();
        updateNavHighlight();
    }

    // ── Choice Selection ────────────────────────────────────────
    function selectChoice(problemIdx, choice) {
        const card = document.getElementById(`problem-${problemIdx}`);
        if (card.classList.contains('is-submitted')) return;

        userAnswers[problemIdx] = choice;

        // Update button states
        const btns = card.querySelectorAll('.choice-btn');
        btns.forEach(b => {
            b.classList.toggle('selected', b.dataset.choice === choice);
        });

        // Auto-submit after a short delay to provide visual feedback
        setTimeout(() => {
            // Only submit if the selection is still the same (avoid race conditions)
            if (userAnswers[problemIdx] === choice && !card.classList.contains('is-submitted')) {
                submitProblem(problemIdx);
            }
        }, 400);
    }

    // ── Submit Problem ──────────────────────────────────────────
    function submitProblem(problemIdx) {
        if (!testActive || userAnswers[problemIdx] === null) return;

        // Record time for this problem
        recordProblemTime(problemIdx);

        // Mark as submitted
        const card = document.getElementById(`problem-${problemIdx}`);
        card.classList.remove('is-active');
        card.classList.add('is-submitted');

        updateNavBtn(problemIdx, 'answered');
        updateProgress();

        // Stop the current problem timer display (it will restart in moveToNextProblem)
        document.getElementById(`timer-${problemIdx}`).classList.remove('is-running');

        // Move to next unanswered problem
        moveToNextProblem(problemIdx);
    }

    // ── Allow Changing Answer ────────────────────────────────────
    function allowChangeAnswer(problemIdx) {
        if (!testActive || testFinished) return;

        // Stop any currently running timer elsewhere
        recordProblemTime(currentProblem);

        // Mark problem as NOT submitted
        const card = document.getElementById(`problem-${problemIdx}`);
        card.classList.remove('is-submitted');
        
        // Clear previous selection visually (so they re-select)
        // userAnswers[problemIdx] = null; // Optional: Keep it or clear it? User said "allow to make choice again"
        // Let's keep it but allow re-selection.
        
        updateNavBtn(problemIdx, 'active');
        updateProgress();

        // Start timer for THIS problem again
        startProblemTimer(problemIdx);
        
        // Ensure it's in view
        scrollToProblem(problemIdx);
    }

    // ── Skip Problem ────────────────────────────────────────────
    function skipProblem(problemIdx) {
        if (!testActive) return;

        // Record time spent even if skipping
        recordProblemTime(problemIdx);

        // Remove active state
        const card = document.getElementById(`problem-${problemIdx}`);
        card.classList.remove('is-active');

        // Move to next
        moveToNextProblem(problemIdx);
    }

    // ── Move to Next Problem ────────────────────────────────────
    function moveToNextProblem(fromIdx) {
        // Find next unanswered problem
        let nextIdx = -1;
        for (let i = fromIdx + 1; i < problems.length; i++) {
            const card = document.getElementById(`problem-${i}`);
            if (!card.classList.contains('is-submitted')) {
                nextIdx = i;
                break;
            }
        }

        // If not found, search from beginning
        if (nextIdx === -1) {
            for (let i = 0; i < fromIdx; i++) {
                const card = document.getElementById(`problem-${i}`);
                if (!card.classList.contains('is-submitted')) {
                    nextIdx = i;
                    break;
                }
            }
        }

        if (nextIdx === -1) {
            // All problems answered
            finishTest();
            return;
        }

        startProblemTimer(nextIdx);
        scrollToProblem(nextIdx);
    }

    // ── Problem Timer ───────────────────────────────────────────
    function startProblemTimer(idx) {
        // Stop any running timer
        if (problemTimerInterval) clearInterval(problemTimerInterval);

        currentProblem = idx;
        problemStartTime = Date.now();

        // Set active state
        document.querySelectorAll('.problem-card').forEach(c => c.classList.remove('is-active'));
        const card = document.getElementById(`problem-${idx}`);
        card.classList.add('is-active');

        // Timer display class
        document.querySelectorAll('.problem-timer').forEach(t => t.classList.remove('is-running'));
        document.getElementById(`timer-${idx}`).classList.add('is-running');

        updateNavHighlight();

        // Update problem timer every 200ms
        problemTimerInterval = setInterval(() => {
            const elapsed = problemTimes[idx] + (Date.now() - problemStartTime) / 1000;
            updateProblemTimerDisplay(idx, elapsed);
        }, 200);
    }

    function recordProblemTime(idx) {
        if (idx === currentProblem) {
            const elapsed = (Date.now() - problemStartTime) / 1000;
            problemTimes[idx] += elapsed;
        }
        if (problemTimerInterval) clearInterval(problemTimerInterval);
        document.getElementById(`timer-${idx}`).classList.remove('is-running');
        updateProblemTimerDisplay(idx, problemTimes[idx]);
    }

    function updateProblemTimerDisplay(idx, seconds) {
        const timerEl = document.querySelector(`#timer-${idx} .timer-value`);
        if (timerEl) {
            timerEl.textContent = formatTime(Math.floor(seconds));
        }
    }

    // ── Global Timer ────────────────────────────────────────────
    function startGlobalTimer() {
        const startTime = Date.now();
        globalTimerInterval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            globalRemaining = Math.max(0, TOTAL_TIME - elapsed);
            totalElapsed = Math.min(TOTAL_TIME, elapsed);

            updateCountdownDisplay();

            if (globalRemaining <= 0) {
                finishTest();
            }
        }, 250);
    }

    function updateCountdownDisplay() {
        const mins = Math.floor(globalRemaining / 60);
        const secs = Math.floor(globalRemaining % 60);
        $countdown.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

        // Color coding
        $countdown.classList.remove('warning', 'danger');
        if (globalRemaining <= 120) {
            $countdown.classList.add('danger');
        } else if (globalRemaining <= 600) {
            $countdown.classList.add('warning');
        }
    }

    // ── Finish Test ─────────────────────────────────────────────
    function finishTest() {
        if (testFinished) return;
        testFinished = true;
        testActive = false;

        // Record current problem time
        recordProblemTime(currentProblem);

        // Stop all timers
        if (globalTimerInterval) clearInterval(globalTimerInterval);
        if (problemTimerInterval) clearInterval(problemTimerInterval);

        // Build results
        buildResults();

        // Switch screen
        switchScreen('results');
    }

    // ── Build Results ───────────────────────────────────────────
    function buildResults() {
        let correct = 0;
        let wrong = 0;
        let skipped = 0;

        const tbody = document.getElementById('results-tbody');
        tbody.innerHTML = '';

        problems.forEach((p, i) => {
            const userAns = userAnswers[i];
            const correctAns = answerKey[i] || '?';
            const timeSpent = problemTimes[i];
            const isCorrect = userAns === correctAns;
            const isSkipped = userAns === null;

            if (isSkipped) skipped++;
            else if (isCorrect) correct++;
            else wrong++;

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="font-weight:700; font-family: var(--font-mono);">${p.number}</td>
                <td>
                    <span style="
                        display: inline-flex; align-items: center; justify-content: center;
                        width: 30px; height: 30px; border-radius: 50%;
                        font-weight: 700; font-size: 0.85rem; font-family: var(--font-mono);
                        ${isSkipped
                            ? 'background: var(--bg-surface); color: var(--text-muted);'
                            : isCorrect
                                ? 'background: var(--green-bg); color: var(--green);'
                                : 'background: var(--red-bg); color: var(--red);'
                        }
                    ">${isSkipped ? '–' : userAns}</span>
                </td>
                <td>
                    <span style="
                        display: inline-flex; align-items: center; justify-content: center;
                        width: 30px; height: 30px; border-radius: 50%;
                        font-weight: 700; font-size: 0.85rem; font-family: var(--font-mono);
                        background: var(--green-bg); color: var(--green);
                    ">${correctAns}</span>
                </td>
                <td>
                    ${isSkipped
                        ? '<span class="result-skipped">Skipped</span>'
                        : isCorrect
                            ? '<span class="result-correct result-icon">✓ Correct</span>'
                            : '<span class="result-wrong result-icon">✗ Wrong</span>'
                    }
                </td>
                <td style="font-family: var(--font-mono); color: var(--text-secondary);">
                    ${formatTime(Math.round(timeSpent))}
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Update stats
        document.getElementById('stat-correct').textContent = correct;
        document.getElementById('stat-wrong').textContent = wrong;
        document.getElementById('stat-skipped').textContent = skipped;
        document.getElementById('stat-time').textContent = formatTime(Math.round(totalElapsed));

        // Score animation
        const scoreNum = document.getElementById('score-number');
        scoreNum.textContent = correct;

        // SVG ring – add gradient def
        const svgEl = document.querySelector('.score-circle svg');
        const defsExist = svgEl.querySelector('defs');
        if (!defsExist) {
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            defs.innerHTML = `
                <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#6366f1"/>
                    <stop offset="100%" stop-color="#a855f7"/>
                </linearGradient>
            `;
            svgEl.prepend(defs);
        }

        const ring = document.getElementById('score-ring');
        const circumference = 2 * Math.PI * 54;
        const pct = correct / problems.length;
        setTimeout(() => {
            ring.style.strokeDashoffset = circumference * (1 - pct);
        }, 300);

        // Confetti for good scores
        if (correct >= 20) {
            launchConfetti();
        }
    }

    // ── Helpers ──────────────────────────────────────────────────
    function switchScreen(name) {
        [$landing, $test, $results].forEach(s => s.classList.remove('active'));
        if (name === 'landing') $landing.classList.add('active');
        if (name === 'test') $test.classList.add('active');
        if (name === 'results') $results.classList.add('active');
    }

    function scrollToProblem(idx) {
        const el = document.getElementById(`problem-${idx}`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function updateProgress() {
        const submitted = document.querySelectorAll('.problem-card.is-submitted').length;
        $progressText.textContent = `${submitted} / ${problems.length}`;
        $progressBar.style.width = `${(submitted / problems.length) * 100}%`;
    }

    function updateNavHighlight() {
        document.querySelectorAll('.nav-btn').forEach((btn, i) => {
            btn.classList.remove('active', 'current-timing');
            if (i === currentProblem) {
                btn.classList.add('active', 'current-timing');
            }
        });
    }

    function updateNavBtn(idx, state) {
        const btn = document.getElementById(`nav-btn-${idx}`);
        if (btn && state === 'answered') {
            btn.classList.add('answered');
            btn.classList.remove('active', 'current-timing');
        }
    }

    function formatTime(totalSeconds) {
        const m = Math.floor(totalSeconds / 60);
        const s = totalSeconds % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function showLoading(show) {
        let overlay = document.getElementById('loading-overlay');
        if (show) {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'loading-overlay';
                overlay.className = 'loading-overlay';
                overlay.innerHTML = '<span class="spinner"></span><p>Loading problems...</p>';
                document.body.appendChild(overlay);
            }
            overlay.style.display = 'flex';
            $startBtn.querySelector('.btn-text').style.display = 'none';
            $startBtn.querySelector('.btn-loader').style.display = 'inline-flex';
        } else {
            if (overlay) overlay.style.display = 'none';
            $startBtn.querySelector('.btn-text').style.display = 'inline';
            $startBtn.querySelector('.btn-loader').style.display = 'none';
        }
    }

    function showError(msg) {
        if (msg) {
            $errorMsg.textContent = msg;
            $errorMsg.style.display = 'block';
        } else {
            $errorMsg.style.display = 'none';
        }
    }

    // ── Confetti ────────────────────────────────────────────────
    function launchConfetti() {
        const canvas = document.createElement('canvas');
        canvas.id = 'confetti-canvas';
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const pieces = [];
        const colors = ['#6366f1', '#a855f7', '#22c55e', '#eab308', '#ec4899', '#06b6d4'];

        for (let i = 0; i < 120; i++) {
            pieces.push({
                x: Math.random() * canvas.width,
                y: Math.random() * -canvas.height,
                w: Math.random() * 10 + 5,
                h: Math.random() * 6 + 3,
                color: colors[Math.floor(Math.random() * colors.length)],
                vx: (Math.random() - 0.5) * 4,
                vy: Math.random() * 3 + 2,
                rot: Math.random() * 360,
                rotSpeed: (Math.random() - 0.5) * 8
            });
        }

        let frame = 0;
        function animate() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            pieces.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.05;
                p.rot += p.rotSpeed;

                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate((p.rot * Math.PI) / 180);
                ctx.fillStyle = p.color;
                ctx.globalAlpha = Math.max(0, 1 - frame / 180);
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            });
            frame++;
            if (frame < 200) {
                requestAnimationFrame(animate);
            } else {
                canvas.remove();
            }
        }
        animate();
    }

})();
