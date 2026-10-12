/* All site-specific DOM integration belongs here. No guessed text/index clicks. */
(function (root) {
    'use strict';

    function questionPanel(step) {
        if (!Number.isInteger(step.question?.id) || step.question.id < 1 ||
            !Number.isInteger(step.video?.tab?.index)) throw configError('question.id / video.tab.index');
        // The supplied overlay identifies its question with this hidden field.
        // Scope to the active lecture content, never the course's separate tests.
        return '#seq_content .in-video-problem:has(input[name="problem_id"][value="Câu ' + step.question.id + '"])';
    }
    const selectors = {
        questionPanel,
        answerOption: step => {
            if (!/^[A-D]$/.test(step.question?.answer)) throw configError('question.answer');
            return 'input[type="radio"][value="choice_' + (step.question.answer.charCodeAt(0) - 65) + '"]';
        },
        submitAnswer: () => 'button.submit:not(:disabled):not([aria-disabled="true"])',
        questionAnswered: step => questionPanel(step) + ' .problems-wrapper[data-attempts-used]:not([data-attempts-used="0"]):not([data-attempts-used=""]):has(' + selectors.answerOption(step) + ':checked)'
    };

    function configError(name) {
        const error = new Error('Cần cập nhật HTML: ' + name + ' trong site-adapter.js (TODO).');
        error.code = 'CONFIG_REQUIRED';
        return error;
    }

    function selector(name, step) {
        if (typeof selectors[name] !== 'function') throw configError(name);
        const value = selectors[name](step);
        if (typeof value !== 'string' || !value.trim()) throw configError(name);
        return value;
    }

    function visible(element) {
        return element.isConnected && element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden' &&
            !element.closest('[hidden], [aria-hidden="true"]');
    }

    function find(css, scope = document) {
        const matches = [...scope.querySelectorAll(css)].filter(visible);
        if (matches.length > 1) throw new Error('Selector khớp nhiều phần tử, cần thu hẹp: ' + css);
        return matches[0] || null;
    }

    function throwIfAborted(signal) {
        if (signal.aborted) throw new DOMException('Đã dừng', 'AbortError');
    }

    function delay(ms, signal) {
        throwIfAborted(signal);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', cancel);
                resolve();
            }, ms);
            function cancel() {
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                reject(new DOMException('Đã dừng', 'AbortError'));
            }
            signal.addEventListener('abort', cancel, { once: true });
        });
    }

    // Every wait loop in the extension re-checks its condition on this
    // cadence. 400ms keeps the run feeling prompt (nothing here is watched
    // interactively) while roughly halving how often a tab wakes up and
    // re-queries the DOM compared to the previous 200ms -- real CPU savings
    // over a run this long, and the difference that lets a low-end machine
    // keep up instead of falling behind and piling up wake-ups.
    const POLL_MS = 400;

    async function waitFor(probe, signal, description, timeoutMs = 30000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            throwIfAborted(signal);
            const result = probe();
            if (result) return result;
            await delay(POLL_MS, signal);
        }
        throw new Error('Hết thời gian chờ: ' + description);
    }

    function click(element, signal) {
        throwIfAborted(signal);
        if (!element || !visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') {
            throw new Error('Phần tử chưa sẵn sàng để click.');
        }
        element.click();
    }

    function questionSelectors(step) {
        return {
            panel: selector('questionPanel', step),
            option: selector('answerOption', step),
            submit: selectors.submitAnswer === false ? null : selector('submitAnswer', step),
            answered: selector('questionAnswered', step),
            continue: 'button.in-video-continue:not(:disabled):not([aria-disabled="true"])'
        };
    }

    // YouTube embed playback is handled by media-player.js + youtube-frame.js.
    root.CourseSite = { selectors, selector, find, click, waitFor, delay, throwIfAborted, questionSelectors };
})(globalThis);
