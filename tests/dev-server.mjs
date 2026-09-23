// Local preview only. --fixtures uses synthetic transcription/ranking; no paid API calls.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import trial from '../api/trial.js';
import feedback from '../api/feedback.js';
import moments from '../api/moments.js';
import eleven from '../api/eleven.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = process.argv.includes('--fixtures');
// Read only the supported server settings. Refresh for each request so pasting keys
// into .env.local does not require a browser reload or discard the current recording.
async function loadLocalEnvironment() {
  try {
    const values = parseEnv(await fs.readFile(path.join(root, '.env.local'), 'utf8'));
    for (const key of ['ELEVENLABS_API_KEY', 'OPENAI_API_KEY', 'TESTER_PASSWORD', 'MOMENTS_MODEL', 'AUDIO_IMPORT_WORKER_URL', 'AUDIO_IMPORT_WORKER_KEY','SUPABASE_URL','SUPABASE_SERVICE_KEY','RESEND_API_KEY']) {
      if (Object.hasOwn(values, key)) process.env[key] = values[key];
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const port = Number(process.env.PORT || (fixture ? 4181 : 4180));
const story = [
  'Make the work you want to be hired to make. A portfolio is an invitation to your next client. Show the direction you want to grow, and give people a reason to remember your perspective.',
  'The tool will change again next month. Your creative goal can stay the same. Start with a clear idea, then choose the tools that help you bring that idea into the world.',
  'Practice makes your decisions more intentional. Try small experiments, notice what works, and use those discoveries in the next project. Building your own creative voice takes repetition, curiosity, and a willingness to change your mind.'
];
const words = story.flatMap((text, section) => text.split(' ').map((text, i, all) => ({ type: 'word', text, start: section * 40 + i * 38 / all.length, end: section * 40 + (i + .9) * 38 / all.length, speaker_id: section === 1 ? 'speaker_1' : 'speaker_0' })));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.wav': 'audio/wav' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  res.send = body => res.end(body);
  try {
    if (!fixture && url.pathname.startsWith('/api/')) await loadLocalEnvironment();
    if (fixture && url.pathname.startsWith('/api/')) {
      for await (const _ of req) { /* consume fixture request without retaining it */ }
      if (url.pathname.includes('speech-to-text')) return res.json({ words, language_code: 'eng' });
      if (url.pathname === '/api/moments') return res.json(req.method === 'GET' ? { ready: true } : {
        moments: story.map((text, i) => ({ start: i * 40, end: i * 40 + 38,
          title: ['Make work that attracts your next client', 'Start with your idea', 'Find your voice through practice'][i],
          reason: 'Synthetic test recommendation — a complete practical takeaway.', context: '', text, speakers: ['s0:speaker_0'] })) });
      if (url.pathname.endsWith('/voices')) return res.json({ voices: [] });
      return res.status(404).json({ error: 'Fixture does not implement this endpoint.' });
    }
    if (url.pathname === '/api/trial') { req.query=Object.fromEntries(url.searchParams);return await trial(req,res); }
    if (url.pathname === '/api/feedback') {
      let body='';for await(const chunk of req){body+=chunk;if(body.length>10000)return res.status(413).json({error:'Request too large.'});}
      req.body=body?JSON.parse(body):{};return await feedback(req,res);
    }
    if (url.pathname === '/api/moments') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1000000) return res.status(413).json({ error: 'Request too large.' }); }
      req.body = body ? JSON.parse(body) : undefined; return await moments(req, res);
    }
    if (url.pathname.startsWith('/api/eleven/')) { req.query = { path: url.pathname.slice('/api/eleven/'.length) }; return await eleven(req, res); }
    const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) || path.relative(root, file).split(path.sep).some(p => p.startsWith('.'))) return res.status(403).end();
    let data = await fs.readFile(file);
    res.setHeader('Cache-Control', 'no-store');
    if (path.extname(file) === '.html') data = Buffer.from(data.toString().replace('MOMENT SELECTOR', fixture ? 'MOMENT SELECTOR · DEMO' : 'MOMENT SELECTOR'));
    if (fixture && path.extname(file) === '.html') data = Buffer.from(data.toString().replace('<body>', '<body><div style="position:fixed;bottom:0;left:0;right:0;z-index:100;padding:8px;text-align:center;background:#33233e;color:#fff;font:12px sans-serif">Local test preview · Synthetic recommendations and test audio · No paid API calls</div>'));
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); res.end(data);
  } catch (_) { res.status(404).end('Not found'); }
}).listen(port, '127.0.0.1', () => console.log(`OutLoud preview http://127.0.0.1:${port} (${fixture ? 'SYNTHETIC FIXTURES — no paid calls' : 'real endpoints; configure environment'})`));
