/* Local real-DOM tests in an isolated headless browser; no site login or npm packages. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const browser = process.env.BROWSER_EXECUTABLE || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
].find(filename => fs.existsSync(filename));
if (!browser) throw new Error('Set BROWSER_EXECUTABLE to a Chromium executable.');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'course-browser-test-'));
const server = http.createServer((req, res) => {
    const filename = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    try {
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' }[path.extname(filename)] || 'text/plain';
        res.setHeader('Content-Type', type + '; charset=utf-8');
        res.end(fs.readFileSync(filename));
    } catch { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1', () => {
    const child = spawn(browser, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        '--window-size=900,900', '--virtual-time-budget=15000',
        '--user-data-dir=' + path.join(output, 'profile'),
        '--screenshot=' + path.join(output, 'smoke.png'), '--dump-dom',
        'http://127.0.0.1:' + server.address().port + '/tests/browser-smoke.html'
    ], { windowsHide: true });
    let dom = '';
    let errors = '';
    child.stdout.on('data', chunk => { dom += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const timeout = setTimeout(() => { child.kill(); }, 45000);
    child.on('error', error => { console.error(error); process.exitCode = 1; clearTimeout(timeout); server.close(); });
    child.on('close', () => {
        clearTimeout(timeout);
        server.close();
        fs.writeFileSync(path.join(output, 'dom.html'), dom);
        fs.writeFileSync(path.join(output, 'browser.log'), errors);
        const report = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom)?.[1] || 'No browser report';
        console.log(report.replaceAll('&gt;', '>').replaceAll('&lt;', '<'));
        console.log('Artifacts: ' + output);
        if (!dom.includes('data-smoke="passed"')) process.exitCode = 1;
    });
});
