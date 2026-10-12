window.runPlayerDOMTests = async function (check) {
    const [tabsHtml, playerHtml] = await Promise.all([
        fetch('fixtures/sequence-tabs.html').then(r => r.text()),
        fetch('fixtures/youtube-wrapper.html').then(r => r.text())
    ]);
    const host = document.getElementById('fixture');
    host.innerHTML = tabsHtml + '<div id="seq_content"></div>';
    const panel = document.getElementById('seq_content');
    function mountPlayer(index) {
        const template = document.createElement('template');
        template.innerHTML = playerHtml;
        // Keep local DOM tests offline; remote player messaging has separate integration tests.
        template.content.querySelector('iframe').src = 'about:blank?tab=' + index;
        panel.replaceChildren(template.content.cloneNode(true));
    }
    mountPlayer(2);
    const clicked = [];
    for (const tab of host.querySelectorAll('button[role="tab"]')) {
        tab.addEventListener('click', () => {
            clicked.push(Number(tab.dataset.index));
            for (const item of host.querySelectorAll('button[role="tab"]')) {
                item.setAttribute('aria-selected', String(item === tab));
            }
            setTimeout(() => mountPlayer(tab.dataset.index), 30);
        });
    }
    const signal = new AbortController().signal;
    const tabs = await CourseActions.discoverVideoTabs(signal);
    check(tabs.length === 3 && tabs[0].title === '1.1' && tabs[2].title === '1.3', 'discover all sequence tabs, including seq_problem');
    for (const tab of tabs) {
        const before = panel.querySelector('.tc-wrapper');
        const pending = CourseActions.openVideoTab({ video: { tab } }, signal);
        await Promise.resolve();
        const wrapper = await pending;
        check(wrapper !== before && wrapper.querySelector('iframe').src.endsWith('tab=' + tab.index), 'wait for new player after selecting tab ' + tab.title);
    }
    check(clicked.join(',') === '0,1,2', 'click each tab in sequence, including both problem tabs');
    await CourseActions.openVideoTab({ video: { tab: tabs[2] } }, signal);
    check(clicked.length === 3, 'already selected video tab is not clicked again');
    let rejected = false;
    try { await CourseActions.openVideoTab({ video: { tab: { ...tabs[0], blockId: 'wrong' } } }, signal); }
    catch { rejected = true; }
    check(rejected && clicked.length === 3, 'wrong tab block ID fails before clicking');
    const controller = new AbortController();
    const loading = CourseActions.openVideoTab({ video: { tab: tabs[0] } }, controller.signal);
    await Promise.resolve();
    controller.abort();
    await loading.then(() => { throw new Error('Tab wait should abort'); }, error => check(error.name === 'AbortError', 'Stop cancels waiting for new tab content'));
};
