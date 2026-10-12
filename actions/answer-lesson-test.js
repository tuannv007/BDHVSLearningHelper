/* The supplied test page contains one problem per question, in source order. */
(function (root) {
    'use strict';
    const normalize = value => value.replace(/\s+/g, ' ').trim();
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
        const page = () => {
            const content = site.find('#seq_content');
            if (step.manualPage) {
                return content && !content.querySelector('.tc-wrapper, .in-video-problem') &&
                    content.querySelector('.problems-wrapper') ? content : null;
            }
            const title = content && site.find('.unit-title', content);
            return title && normalize(title.textContent) === normalize(step.pageTitle) ? content : null;
        };
        const isLocked = typeof document !== 'undefined' && document.body?.textContent?.includes('Nội dung này đã bị khóa');
        if (isLocked) {
            err('[Bình dân học vụ số] 🔒 NỘI DUNG ĐÃ BỊ KHÓA: Bạn phải hoàn thành phần Video bài giảng trước để có thể làm bài kiểm tra!');
            throw new Error('Nội dung bài kiểm tra đang bị khóa bởi hệ thống (chưa hoàn thành Video bài giảng).');
        }

        site.throwIfAborted(signal);
        if (!page() && !step.manualPage) {
            log('[Bình dân học vụ số] ℹ️ Chưa ở trang kiểm tra, đang kiểm tra trang video hiện tại để bấm Trang sau...');
            // Only navigate from the final tab of this lesson's lecture. A new
            // document resumes this same step and recognizes the test title.
            if (!root.CourseRunner.isLecturePage(location.href, coursePath, step.lesson.navigation.lectureId)) {
                throw new Error('Chưa ở trang video của đúng bài để bấm Trang sau.');
            }
            const tabs = [...document.querySelectorAll('#sequence-list button[role="tab"][data-index]')];
            const selected = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true');
            const lastIndex = Math.max(...tabs.map(tab => Number(tab.getAttribute('data-index'))));
            if (selected.length !== 1 || Number(selected[0].getAttribute('data-index')) !== lastIndex) {
                throw new Error('Chưa ở tab video cuối cùng.');
            }
            log('[Bình dân học vụ số] ➡️ Đang bấm nút Trang sau...');
            site.click(await site.waitFor(() => site.find('nav.sequence-bottom button.button-next:not(:disabled):not([aria-disabled="true"])'), signal, 'nút Trang sau'), signal);
        }
        log('[Bình dân học vụ số] ⏳ Đang chờ trang kiểm tra: "' + step.pageTitle + '"...');
        await site.waitFor(page, signal, step.pageTitle);
        log('[Bình dân học vụ số] 📋 Đã vào trang kiểm tra: "' + step.pageTitle + '"');
        const problems = () => {
            const content = page();
            if (!content) throw new Error('Trang kiểm tra đã thay đổi.');
            return [...content.querySelectorAll('.problems-wrapper')]
                .filter(element => !element.closest('.in-video-problem'));
        };
        const initial = await site.waitFor(() => {
            const list = problems();
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
        const submissions = [];
        log('[Bình dân học vụ số] ✍️ Bắt đầu chọn đáp án cho ' + step.questions.length + ' câu hỏi kiểm tra...');
        for (const question of step.questions) {
            site.throwIfAborted(signal);
            const current = () => {
                const content = page();
                if (!content) throw new Error('Trang kiểm tra đã thay đổi.');
                return site.find('#' + CSS.escape(ids[question.id - 1]), content);
            };
            const optionCss = 'input[type="radio"][value="' + valueFor(question) + '"]';
            const panel = await site.waitFor(current, signal, 'câu kiểm tra ' + question.id);
            const option = site.find(optionCss, panel);
            site.click(option, signal);
            // A radio that was already checked does not emit a native change.
            // Notify the course form so it can enable its own Submit button.
            option.dispatchEvent(new Event('change', { bubbles: true }));
            await site.waitFor(() => {
                const panel = current();
                return panel && site.find(optionCss, panel)?.checked;
            }, signal, 'chọn đáp án câu kiểm tra ' + question.id);
            submissions.push({ question, current, optionCss });
        }
        log('[Bình dân học vụ số] 📤 Đã chọn xong, bắt đầu bấm Gửi lần lượt từng câu hỏi...');
        // Fill the whole page first, then submit every question. Do not wait on
        // each question's graded result — only make sure it was submitted.
        for (const { question, current, optionCss } of submissions) {
            site.throwIfAborted(signal);
            const option = await site.waitFor(() => {
                const panel = current();
                return panel && site.find(optionCss, panel);
            }, signal, 'đáp án câu kiểm tra ' + question.id);
            if (!option.checked) {
                site.click(option, signal);
                option.dispatchEvent(new Event('change', { bubbles: true }));
            }
            await site.waitFor(() => {
                const panel = current();
                return panel && site.find(optionCss, panel)?.checked;
            }, signal, 'chọn lại câu kiểm tra ' + question.id);
            site.click(await site.waitFor(() => {
                const panel = current();
                return panel && site.find(submitSelector, panel);
            }, signal, 'Gửi câu kiểm tra ' + question.id), signal);
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
        log('[Bình dân học vụ số] ✔️ Hoàn thành bài kiểm tra ' + step.pageTitle);
    }
    async function openFinalReview(step, signal, context) {
        const site = root.CourseSite;
        const nav = step.navigation;
        const coursePath = context.path;
        const arrived = () => root.CourseRunner.isLecturePage(location.href, coursePath, nav.sequenceId);
        site.throwIfAborted(signal);
        if (!arrived()) {
            // Persist before a full navigation destroys this document, same as
            // openLessonVideo — otherwise a real page load here can lose track
            // of this step and the run has no way to tell it apart from
            // already being finished.
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
