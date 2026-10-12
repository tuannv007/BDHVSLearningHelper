(function (root) {
    'use strict';
    function tabSelector(step) {
        if (!Number.isInteger(step.video.tab?.index) || step.video.tab.index < 0) {
            throw new Error('Video thiếu tab.index hợp lệ trong data.json.');
        }
        return '#sequence-list button[role="tab"][data-index="' + step.video.tab.index + '"]';
    }
    function container(step) {
        const site = root.CourseSite;
        const tab = site.find(tabSelector(step));
        if (tab?.getAttribute('aria-selected') !== 'true') return null;
        const panelId = tab.getAttribute('aria-controls');
        if (!panelId) throw new Error('Tab video thiếu aria-controls.');
        const panel = site.find('#' + CSS.escape(panelId));
        return panel && site.find('.tc-wrapper', panel);
    }
    const log = (...args) => { if (typeof console !== 'undefined' && typeof console.log === 'function') console.log(...args); };
    async function openVideoTab(step, signal) {
        const site = root.CourseSite;
        log('[Bình dân học vụ số] 🗂️ Đang mở tab ' + (step.video.tab?.title || step.video.title) + ' (index ' + step.video.tab?.index + ')...');
        const target = await site.waitFor(() => site.find(tabSelector(step)), signal, 'tab ' + step.video.tab.title);
        if (step.video.tab.title && target.getAttribute('data-page-title') !== step.video.tab.title) {
            throw new Error('Tiêu đề tab không khớp dữ liệu: ' + step.video.tab.title);
        }
        if (step.video.tab.blockId && target.getAttribute('data-id') !== step.video.tab.blockId) {
            throw new Error('ID tab không khớp dữ liệu: ' + step.video.tab.title);
        }
        const wasSelected = target.getAttribute('aria-selected') === 'true';
        const old = site.find('#seq_content .tc-wrapper');
        const oldFrame = old?.querySelector('iframe');
        const oldSrc = oldFrame?.src;
        if (!wasSelected) site.click(target, signal);
        // Selecting a tab can update aria-selected before its async content is replaced.
        const result = await site.waitFor(() => {
            const current = container(step);
            if (!current) return null;
            const iframe = current.querySelector('iframe');
            if (!iframe) return null;
            return wasSelected || current !== old || iframe !== oldFrame || iframe.src !== oldSrc ? current : null;
        }, signal, 'player mới của tab ' + step.video.tab.title);
        log('[Bình dân học vụ số] ✔️ Player của tab ' + (step.video.tab?.title || step.video.title) + ' đã tải xong');
        try { result.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
        return result;
    }
    async function discoverVideoTabs(signal) {
        const list = await root.CourseSite.waitFor(() => root.CourseSite.find('#sequence-list'), signal, 'danh sách tab video');
        const tabs = [...list.querySelectorAll('button[role="tab"][data-index]')].map(tab => ({
            index: Number(tab.getAttribute('data-index')),
            title: tab.getAttribute('data-page-title') || '', blockId: tab.getAttribute('data-id') || ''
        }));
        log('[Bình dân học vụ số] 📑 Đã đọc ' + tabs.length + ' tab video trên trang: ' + tabs.map(t => t.title).join(', '));
        return tabs;
    }
    root.CourseActions = { ...root.CourseActions, openVideoTab, videoContainer: container, discoverVideoTabs };
})(globalThis);
