/* Reusable outline action. Course/lesson IDs and links come only from data.json. */
(function (root) {
    'use strict';

    const normalize = text => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('vi');

    const log = (...args) => { if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(...args); };

    async function openLessonVideo(step, signal, context) {
        const site = root.CourseSite;
        const nav = step.lesson.navigation;
        const arrived = () => root.CourseRunner.isLecturePage(location.href, context.path, nav.lectureId);
        site.throwIfAborted(signal);
        if (arrived()) return; // Resume after jump_to redirect without clicking again.

        let outline = site.find(step.outlineSelector);
        if (context.navigation?.phase === 'lecture') {
            const error = new Error(outline
                ? 'Trang đã quay lại danh sách thay vì mở Video bài giảng. Hãy kiểm tra điều kiện tiên quyết của bài.'
                : 'Đã mở link bài giảng nhưng chưa xác nhận được trang đích. Cần HTML/URL trang bài giảng (TODO: LECTURE_PAGE_HTML).');
            error.code = outline ? 'NAVIGATION_FAILED' : 'CONFIG_REQUIRED';
            throw error;
        }
        if (!outline) {
            const onOutlinePage = new URL(location.href).pathname === new URL(context.path).pathname;
            if (!onOutlinePage) {
                // Returning from another lesson: use this course's own outline, not browser history.
                await context.prepareNavigation('outline', context.path);
                site.throwIfAborted(signal);
                location.assign(context.path);
            }
            outline = await site.waitFor(() => site.find(step.outlineSelector), signal, 'danh sách bài học');
        }

        log('[Bình dân học vụ số] 📂 Mở danh sách bài học: ' + step.lesson.title);
        const section = await site.waitFor(
            () => site.find('#' + CSS.escape(nav.sectionId), outline), signal, 'tiêu đề ' + step.lesson.title
        );
        if (section.tagName !== 'BUTTON') throw new Error('sectionId phải trỏ đúng nút mở bài.');
        const panelId = section.getAttribute('aria-controls');
        if (!panelId) throw new Error('Nút bài học thiếu aria-controls.');
        const expanded = section.getAttribute('aria-expanded');
        if (expanded === 'false') {
            log('[Bình dân học vụ số] 🔽 Bung accordion ' + step.lesson.title);
            site.click(section, signal);
        } else if (expanded !== 'true') throw new Error('Không nhận diện được trạng thái mở bài.');

        const panel = await site.waitFor(() => {
            if (section.getAttribute('aria-expanded') !== 'true') return null;
            return site.find('#' + CSS.escape(panelId), outline);
        }, signal, 'bung danh sách ' + step.lesson.title);
        const link = await site.waitFor(
            () => site.find('#' + CSS.escape(nav.lectureId), panel), signal, nav.lectureTitle
        );
        const title = link.querySelector('.subsection-title')?.textContent || '';
        // Ignore the question-count suffix, but never match reading/exam/introduction links.
        const lectureTitle = normalize(title.replace(/\s*\(\s*\d+\s+câu hỏi\s*\)\s*$/i, ''));
        if (link.tagName !== 'A' || lectureTitle !== normalize(nav.lectureTitle) ||
            !/^video bài giảng\s+\d+$/.test(lectureTitle)) {
            throw new Error('Mục được cấu hình không phải đúng Video bài giảng: ' + nav.lectureTitle);
        }
        if (new URL(link.href).href !== new URL(nav.lecturePath).href) {
            throw new Error('Link bài giảng trên trang không khớp data.json.');
        }
        log('[Bình dân học vụ số] 🔗 Click mở ' + nav.lectureTitle + '...');
        // Persist before click: a full navigation destroys this document immediately.
        await context.prepareNavigation('lecture', link.href);
        site.throwIfAborted(signal);
        site.click(link, signal);
        await site.waitFor(arrived, signal, 'chuyển đến ' + nav.lectureTitle);
        log('[Bình dân học vụ số] ✔️ Đã vào ' + nav.lectureTitle);
    }

    async function returnToOutline(signal, coursePath) {
        const site = root.CourseSite;
        site.throwIfAborted(signal);
        const arrived = () => new URL(location.href).pathname === new URL(coursePath).pathname &&
            site.find('#course-outline-block-tree');
        if (arrived()) return;
        // The runner already acknowledged the test and persisted this separate
        // step. A new document resumes here, without submitting the test again.
        if (new URL(location.href).pathname !== new URL(coursePath).pathname) location.assign(coursePath);
        await site.waitFor(arrived, signal, 'danh sách bài học');
    }
    root.CourseActions = { ...root.CourseActions, openLessonVideo, returnToOutline };
})(globalThis);
