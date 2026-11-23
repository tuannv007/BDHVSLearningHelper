/* The supplied test page contains one problem per question, in source order. */
(function (root) {
    'use strict';
    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
    const submitSelector = '.submit-attempt-container > button.submit.btn-brand:not(:disabled):not([aria-disabled="true"])';
    // Firing all 20 Submit clicks back to back can outrun the site's own
    // grading, so results may not have caught up yet by the time we check
    // them. Space submissions out a little instead.
    const SUBMIT_GAP_MS = 200;
    // Waiting for each question's graded result to show up in the DOM could
    // take up to 45s per question (15 minutes for 20 unanswered results) when
    // the site is slow to record them, which looked like the run was stuck.
    // Submit every answer, then give the site one flat pause to catch up
    // before moving on — do not wait question by question for confirmation.
    const AFTER_TEST_SETTLE_MS = 5000;
    const log = (...args) => { if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(...args); };
    const err = (...args) => { if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(...args); };

    async function answerLessonTest(step, signal, coursePath) {
        const site = root.CourseSite;

        // Trả về { list, scope } — list là mảng .problems-wrapper, scope là document chứa chúng
        // (trang chính hoặc iframe cùng domain).
        const problems = () => {
            const content = site.find('#seq_content');
            if (!content) return { list: [], scope: typeof document !== 'undefined' ? document : null };
            // Tìm trực tiếp trong trang chính.
            const direct = [...(content.querySelectorAll?.('.problems-wrapper') || [])]
                .filter(element => !(typeof element.closest === 'function' && element.closest('.in-video-problem')));
            if (direct.length) return { list: direct, scope: content };
            // Câu hỏi nằm trong iframe cùng domain — truy cập contentDocument.
            const iframe = typeof content.querySelector === 'function' ? content.querySelector('iframe') : null;
            const iframeDoc = (() => {
                try { return iframe?.contentDocument || iframe?.contentWindow?.document; } catch { return null; }
            })();
            if (!iframeDoc) return { list: [], scope: content };
            const inFrame = [...(iframeDoc.querySelectorAll?.('.problems-wrapper') || [])]
                .filter(element => !(typeof element.closest === 'function' && element.closest('.in-video-problem')));
            return { list: inFrame, scope: iframeDoc };
        };

        const page = () => {
            const content = site.find('#seq_content');
            if (!content) return null;
            // Nếu còn video player YouTube thì chắc chắn vẫn đang ở trang video bài giảng
            if (typeof content.querySelector === 'function' && content.querySelector('.tc-wrapper, .video, iframe[src*="youtube"]')) {
                return null;
            }

            const title = site.find('.unit-title', content);
            if (title) {
                const norm = normalize(title.textContent).toLowerCase();
                const expected = normalize(step.pageTitle || '').toLowerCase();
                if (norm === 'video') return null;
                if (norm === expected || (expected && norm.includes(expected)) || norm.includes('ôn tập') || norm.includes('kiểm tra')) {
                    return content;
                }
                return null;
            }

            if (step.manualPage) {
                return (typeof content.querySelector !== 'function' || !content.querySelector('.tc-wrapper, .in-video-problem')) ? content : null;
            }

            const { list } = problems();
            if (list.length > 0) return content;

            return null;
        };

        site.throwIfAborted(signal);

        function doClick(element) {
            if (!element) return;
            try {
                site.click(element, signal);
            } catch (err) {
                if (err?.message && err.message.includes('Phần tử chưa sẵn sàng')) {
                    try {
                        if (typeof element.click === 'function') element.click();
                    } catch {}
                    if (element.tagName === 'INPUT' && (element.type === 'radio' || element.type === 'checkbox')) {
                        element.checked = true;
                        const label = (typeof element.closest === 'function' ? element.closest('label') : null) ||
                            (element.id && typeof document !== 'undefined' ? document.querySelector('label[for="' + element.id + '"]') : null);
                        if (label && label !== element) {
                            try { label.click(); } catch {}
                        }
                    }
                } else {
                    throw err;
                }
            }
        }

        // Nếu chưa ở trang kiểm tra, tự động chuyển sang trang kiểm tra
        if (!page() && !step.manualPage) {
            log('[Bình dân học vụ số] ℹ️ Chưa ở trang kiểm tra, đang chuyển sang bài kiểm tra...');

            const tabs = [...(document.querySelectorAll?.('#sequence-list button[role="tab"][data-index]') || [])];
            if (tabs.length) {
                const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true');
                const lastIndex = Math.max(...tabs.map(tab => Number(tab.getAttribute('data-index'))));
                if (selected.length !== 1 || Number(selected[0].getAttribute('data-index')) !== lastIndex) {
                    throw new Error('Chưa ở tab video cuối cùng.');
                }
            }

            // Trên trình duyệt thật, chuyển thẳng đến testPath nếu có
            if (step.testPath && typeof location !== 'undefined' && typeof location.assign === 'function') {
                log('[Bình dân học vụ số] ➡️ Đang chuyển thẳng đến trang bài kiểm tra...');
                location.assign(step.testPath);
            } else {
                // Cách 1: Tìm link bài kiểm tra này trong menu/sidebar trên trang
                let testLink = null;
                const seqId = step.sequenceId?.split('+block@')?.at(-1);
                if (seqId && typeof document.querySelector === 'function') {
                    testLink = document.querySelector(`a[href*="${seqId}"]`);
                }
                if (!testLink && step.pageTitle && typeof document.querySelectorAll === 'function') {
                    const allLinks = [...document.querySelectorAll('a')];
                    testLink = allLinks.find(a => normalize(a.textContent).toLowerCase().includes(normalize(step.pageTitle).toLowerCase()));
                }

                if (testLink) {
                    log('[Bình dân học vụ số] ➡️ Đang mở liên kết bài kiểm tra từ danh sách bài học...');
                    if (testLink.href && typeof location !== 'undefined' && typeof location.assign === 'function') {
                        location.assign(testLink.href);
                    } else {
                        doClick(testLink);
                    }
                } else {
                    // Cách 2: Bấm nút "Trang sau" ở cuối trang video
                    let nextBtn = null;
                    try {
                        nextBtn = site.find('nav.sequence-bottom button.button-next:not(:disabled):not([aria-disabled="true"])');
                    } catch {}
                    if (!nextBtn && typeof document.querySelector === 'function') {
                        nextBtn = document.querySelector('nav.sequence-bottom button.button-next:not(:disabled):not([aria-disabled="true"]), button.button-next:not(:disabled):not([aria-disabled="true"])');
                    }

                    if (nextBtn) {
                        log('[Bình dân học vụ số] ➡️ Đang bấm nút Trang sau...');
                        doClick(nextBtn);
                    } else {
                        log('[Bình dân học vụ số] ⏳ Đang chờ trang kiểm tra...');
                    }
                }
            }
        }

        const waitTitle = step.pageTitle || 'bài kiểm tra';
        log('[Bình dân học vụ số] ⏳ Đang chờ trang kiểm tra: "' + waitTitle + '"...');
        await site.waitFor(page, signal, waitTitle);
        log('[Bình dân học vụ số] 📋 Đã vào trang kiểm tra: "' + waitTitle + '"');

        // Kiểm tra khóa SAU KHI đã xác nhận đang ở đúng trang kiểm tra,
        // và chỉ kiểm tra trong #seq_content để tránh false-positive từ nội dung khác trên trang.
        const seqContent = site.find('#seq_content');
        const isLocked = seqContent && seqContent.textContent?.includes('Nội dung này đã bị khóa');
        if (isLocked) {
            err('[Bình dân học vụ số] 🔒 NỘI DUNG ĐÃ BỊ KHÓA: Bạn phải hoàn thành phần Video bài giảng trước để có thể làm bài kiểm tra!');
            throw new Error('Nội dung bài kiểm tra đang bị khóa bởi hệ thống (chưa hoàn thành Video bài giảng).');
        }

        const initial = await site.waitFor(() => {
            const { list } = problems();
            if (list.length > step.questions.length) throw new Error('Số câu trên trang vượt test.questions trong data.json.');
            return list.length === step.questions.length && list.every(panel =>
                panel.querySelectorAll('input[type="radio"]').length >= 2) ? list : null;
        }, signal, 'danh sách câu hỏi kiểm tra');

        if (initial.length !== step.questions.length) throw new Error('Số câu trên trang không khớp test.questions trong data.json.');
        log('[Bình dân học vụ số] 📋 Tìm thấy đủ ' + initial.length + ' câu hỏi kiểm tra trên trang.');
        const ids = initial.map(element => element.id);
        if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('ID câu hỏi kiểm tra không hợp lệ.');

        // Validate every answer before the first submission.
        const valueFor = question => 'choice_' + (question.answer.charCodeAt(0) - 65);
        for (const question of step.questions) {
            const panel = initial[question.id - 1];
            const options = [...panel.querySelectorAll('input[type="radio"]')];
            if (options.length < 2 || options.length > 4 || new Set(options.map(option => option.name)).size !== 1 ||
                !options.some(option => option.value === valueFor(question))) throw new Error('Lựa chọn câu ' + question.id + ' không khớp dữ liệu.');
        }

        // getScope() trả về đúng document chứa câu hỏi (trang chính hoặc iframe).
        const getScope = () => problems().scope;

        const submissions = [];
        log('[Bình dân học vụ số] ✍️ Bắt đầu chọn đáp án cho ' + step.questions.length + ' câu hỏi kiểm tra...');
        for (const question of step.questions) {
            site.throwIfAborted(signal);
            const current = () => {
                const scope = getScope();
                const selector = '#' + CSS.escape(ids[question.id - 1]);
                if (typeof scope?.querySelector === 'function') {
                    const el = scope.querySelector(selector);
                    if (el) return el;
                }
                return site.find(selector, scope);
            };
            const optionCss = 'input[type="radio"][value="' + valueFor(question) + '"]';
            const panel = await site.waitFor(current, signal, 'câu kiểm tra ' + question.id);
            const option = site.find(optionCss, panel) || (typeof panel.querySelector === 'function' ? panel.querySelector(optionCss) : null);
            if (!option) throw new Error('Không tìm thấy đáp án cho câu kiểm tra ' + question.id);
            doClick(option);
            // A radio that was already checked does not emit a native change.
            // Notify the course form so it can enable its own Submit button.
            option.dispatchEvent(new Event('change', { bubbles: true }));
            await site.waitFor(() => {
                const p = current();
                const opt = site.find(optionCss, p) || (typeof p?.querySelector === 'function' ? p.querySelector(optionCss) : null);
                return opt?.checked;
            }, signal, 'chọn đáp án câu kiểm tra ' + question.id);
            submissions.push({ question, current, optionCss });
        }

        log('[Bình dân học vụ số] 📤 Đã chọn xong, bắt đầu bấm Gửi lần lượt từng câu hỏi...');
        // Fill the whole page first, then submit every question. Do not wait on
        // each question's graded result — only make sure it was submitted.
        for (const { question, current, optionCss } of submissions) {
            site.throwIfAborted(signal);
            const option = await site.waitFor(() => {
                const p = current();
                return site.find(optionCss, p) || (typeof p?.querySelector === 'function' ? p.querySelector(optionCss) : null);
            }, signal, 'đáp án câu kiểm tra ' + question.id);
            if (!option.checked) {
                doClick(option);
                option.dispatchEvent(new Event('change', { bubbles: true }));
            }
            await site.waitFor(() => {
                const p = current();
                const opt = site.find(optionCss, p) || (typeof p?.querySelector === 'function' ? p.querySelector(optionCss) : null);
                return opt?.checked;
            }, signal, 'chọn lại câu kiểm tra ' + question.id);
            const submitBtn = await site.waitFor(() => {
                const p = current();
                return site.find(submitSelector, p) || (typeof p?.querySelector === 'function' ? p.querySelector(submitSelector) : null);
            }, signal, 'Gửi câu kiểm tra ' + question.id);
            doClick(submitBtn);
            log('[Bình dân học vụ số] 📤 Đã gửi câu ' + question.id + ' (đáp án ' + question.answer + ')');
            // Give the site a moment to record this answer before firing the next
            // Submit; sending all of them at once is what causes results to lag.
            await site.delay(SUBMIT_GAP_MS, signal);
        }

        // Every answer is already submitted above. Rather than waiting on each
        // question's graded result (slow/missing confirmations were leaving the
        // run stuck for a long time), give the site one fixed pause to finish
        // recording, then let returnToOutline move on to the next lesson.
        site.throwIfAborted(signal);
        log('[Bình dân học vụ số] ⏳ Đã nộp toàn bộ câu hỏi, chờ hệ thống lưu kết quả (5s)...');
        await site.delay(AFTER_TEST_SETTLE_MS, signal);
        log('[Bình dân học vụ số] ✔️ Hoàn thành bài kiểm tra ' + waitTitle);
    }

    async function openFinalReview(step, signal, context) {
        const site = root.CourseSite;
        const nav = step.navigation;
        const coursePath = context.path;
        const arrived = () => root.CourseRunner.isLecturePage(location.href, coursePath, nav.sequenceId);
        site.throwIfAborted(signal);
        if (!arrived()) {
            if (context.navigation?.phase === 'review') {
                const backAtOutline = new URL(location.href).pathname === new URL(coursePath).pathname;
                const error = new Error(backAtOutline
                    ? 'Trang đã quay lại danh sách bài học thay vì mở bài kiểm tra cuối khoá. Hãy kiểm tra điều kiện tiên quyết.'
                    : 'Đã mở link bài kiểm tra cuối khoá nhưng chưa xác nhận được trang đích.');
                error.code = backAtOutline ? 'NAVIGATION_FAILED' : 'CONFIG_REQUIRED';
                throw error;
            }
            const link = site.find('a#' + CSS.escape(nav.sequenceId));
            if (link && new URL(link.href).href !== new URL(nav.path).href) {
                throw new Error('Link bài kiểm tra cuối khoá không khớp dữ liệu.');
            }
            await context.prepareNavigation('review', nav.path);
            site.throwIfAborted(signal);
            if (link) site.click(link, signal);
            else location.assign(nav.path);
            await site.waitFor(arrived, signal, 'trang kiểm tra cuối khoá');
        }
        const tabCss = '#sequence-list button[role="tab"][data-index="' + nav.tabIndex + '"]';
        const gateCss = 'button.gated-sequence.start-timed-exam[data-exam-id="' + CSS.escape(String(nav.examId)) + '"]';
        await site.waitFor(() => site.find(gateCss) || site.find(tabCss), signal, 'nút bắt đầu bài kiểm tra');
        const gate = site.find(gateCss);
        if (gate) {
            site.click(gate, signal);
            await site.waitFor(() => !site.find(gateCss), signal, 'bắt đầu bài kiểm tra tính giờ');
        }
        const tab = await site.waitFor(() => site.find(tabCss), signal, 'tab thứ hai của bài kiểm tra');
        const old = site.find('#seq_content');
        const oldChild = old?.firstElementChild;
        const selected = tab.getAttribute('aria-selected') === 'true';
        if (!selected) site.click(tab, signal);
        await site.waitFor(() => {
            const current = site.find('#seq_content');
            return site.find(tabCss)?.getAttribute('aria-selected') === 'true' && current &&
                (selected || current !== old || current.firstElementChild !== oldChild) &&
                current.querySelector('.problems-wrapper');
        }, signal, 'câu hỏi trong tab thứ hai');
    }

    root.CourseActions = { ...root.CourseActions, answerLessonTest, openFinalReview };
})(globalThis);
