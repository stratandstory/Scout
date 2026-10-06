const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const url = require('url');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Anthropic = require('@anthropic-ai/sdk').default;
const CalendarManager = require('./calendar');
const EventQueue = require('./scheduler');

const PORT = process.env.PORT || 8765;
const HOST = '127.0.0.1';
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const LOCAL_AUTH_TOKEN = process.env.SCOUT_LOCAL_TOKEN;
const DISPLAY_NAME = process.env.DISPLAY_NAME || 'Scout User';
const CAPTURES_DIR = path.join(os.homedir(), 'Scout-captures');
const SERVER_START_TIME = new Date().toISOString();

let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  anthropic = new Anthropic();
}

process.umask(0o077);
fs.mkdirSync(CAPTURES_DIR, { recursive: true, mode: 0o700 });

if (!LOCAL_AUTH_TOKEN || LOCAL_AUTH_TOKEN.length < 32) {
  console.error('SCOUT_LOCAL_TOKEN must be a random value of at least 32 characters. See .env.example.');
  process.exit(1);
}

const activeSessions = new Map();
const eventQueue = new EventQueue();

const ACCOUNT_NAMES = (process.env.GOOGLE_ACCOUNTS || 'personal').split(',').map(s => s.trim());
const calendarManagers = new Map();

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  for (const name of ACCOUNT_NAMES) {
    calendarManagers.set(name, new CalendarManager({
      name,
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      redirectUri: `http://localhost:${PORT}/auth/callback`
    }));
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) tooLarge = true;
    });
    req.on('end', () => {
      if (tooLarge) return resolve(null);
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function tokenMatches(value) {
  if (typeof value !== 'string') return false;
  const expected = Buffer.from(LOCAL_AUTH_TOKEN);
  const received = Buffer.from(value);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function requestToken(req) {
  const header = req.headers['x-scout-token'];
  if (typeof header === 'string') return header;
  const cookie = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('scout_session='));
  return cookie ? decodeURIComponent(cookie.slice('scout_session='.length)) : '';
}

function rejectUnauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized. Configure the Scout local token.' }));
}

function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(parsed.hostname);
  } catch { return false; }
}

const httpServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const corsHeaders = {};

  if (parsed.pathname === '/dashboard') {
    if (tokenMatches(parsed.query.token)) {
      res.writeHead(302, { Location: '/dashboard', 'Set-Cookie': `scout_session=${encodeURIComponent(LOCAL_AUTH_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
      res.end();
      return;
    }
    if (!tokenMatches(requestToken(req))) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Open /dashboard?token=YOUR_SCOUT_LOCAL_TOKEN once to begin a local session.');
      return;
    }
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    try {
      const html = fs.readFileSync(dashboardPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Dashboard file not found');
    }
    return;
  }

  if (!tokenMatches(requestToken(req))) {
    rejectUnauthorized(res);
    return;
  }

  if (parsed.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    const sessionSummaries = {};
    for (const [id, s] of activeSessions) {
      sessionSummaries[id] = {
        tabId: s.tabId,
        tabTitle: s.tabTitle,
        startTime: s.startTime,
        transcriptSegments: s.transcript.length,
        framesCaptured: s.frames.length
      };
    }
    res.end(JSON.stringify({
      status: 'running',
      startTime: SERVER_START_TIME,
      activeSessions: activeSessions.size,
      capturesDir: CAPTURES_DIR,
      hasAnthropic: !!anthropic,
      hasCalendar: calendarManagers.size > 0,
      accounts: Object.fromEntries(
        [...calendarManagers].map(([name, mgr]) => [name, mgr.isAuthenticated()])
      ),
      sessions: sessionSummaries
    }));
    return;
  }

  if (parsed.pathname === '/auth/login') {
    if (calendarManagers.size === 0) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Calendar not configured</h2><p>Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file, then restart the server.</p>');
      return;
    }
    const account = parsed.query.account || ACCOUNT_NAMES[0];
    const mgr = calendarManagers.get(account);
    if (!mgr) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h2>Unknown account</h2><p>"${account}" is not in GOOGLE_ACCOUNTS. Available: ${ACCOUNT_NAMES.join(', ')}</p>`);
      return;
    }
    const authUrl = mgr.getAuthUrl();
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  if (parsed.pathname === '/auth/callback') {
    const code = parsed.query.code;
    const account = parsed.query.state || ACCOUNT_NAMES[0];
    const mgr = calendarManagers.get(account);
    if (!mgr || !code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h2>Error</h2><p>Missing authorization code or unknown account.</p>');
      return;
    }
    mgr.handleCallback(code)
      .then(() => {
        console.log(`[auth] Google Calendar connected — ${account}`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Connected!</h2><p>Scout is now linked to your <b>${account}</b> Google Calendar. You can close this tab.</p>`);
      })
      .catch((err) => {
        console.error(`[auth] OAuth error (${account}):`, err.message);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Error</h2><p>${err.message}</p>`);
      });
    return;
  }

  if (parsed.pathname === '/auth/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({
      configured: calendarManagers.size > 0,
      accounts: Object.fromEntries(
        [...calendarManagers].map(([name, mgr]) => [name, mgr.isAuthenticated()])
      )
    }));
    return;
  }

  if (parsed.pathname === '/schedule') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    eventQueue.prune();
    const ready = eventQueue.getReady();
    res.end(JSON.stringify({
      displayName: DISPLAY_NAME,
      readyToOpen: ready,
      queued: eventQueue.list()
    }));
    return;
  }

  if (parsed.pathname === '/calendar/search' && req.method === 'GET') {
    const query = parsed.query.q;
    const account = parsed.query.account;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'Missing ?q= search term' }));
      return;
    }
    const managers = account
      ? [[account, calendarManagers.get(account)]].filter(([, m]) => m)
      : [...calendarManagers];

    Promise.all(managers.map(async ([name, mgr]) => {
      if (!mgr.isAuthenticated()) return [];
      return mgr.searchEvents({ query, daysAhead: 14 });
    }))
      .then(results => {
        const events = results.flat();
        const seen = new Set();
        const deduped = events.filter(e => {
          const key = (e.meetingUrl || '') + '|' + e.start;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ events: deduped }));
      })
      .catch(err => {
        console.error('[calendar/search] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  if (parsed.pathname === '/events/queue' && req.method === 'POST') {
    parseBody(req).then(body => {
      if (!body || !body.id || !body.start || !body.meetingUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: 'Required: id, start, meetingUrl' }));
        return;
      }
      const queued = eventQueue.add(body);
      console.log('[queue] Event added');
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, event: queued }));
    });
    return;
  }

  if (parsed.pathname === '/events/queued' && req.method === 'GET') {
    eventQueue.prune();
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ events: eventQueue.list() }));
    return;
  }

  if (parsed.pathname.startsWith('/events/queue/') && req.method === 'PATCH') {
    const eventId = decodeURIComponent(parsed.pathname.slice('/events/queue/'.length));
    parseBody(req).then(body => {
      const updated = eventQueue.update(eventId, body);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: 'Event not found' }));
        return;
      }
      console.log('[queue] Event updated');
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, event: updated }));
    });
    return;
  }

  if (parsed.pathname.startsWith('/events/queue/') && req.method === 'DELETE') {
    const eventId = decodeURIComponent(parsed.pathname.slice('/events/queue/'.length));
    const removed = eventQueue.remove(eventId);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ ok: true, removed }));
    return;
  }

  if (parsed.pathname.startsWith('/events/ack/') && req.method === 'POST') {
    const eventId = decodeURIComponent(parsed.pathname.slice('/events/ack/'.length));
    const acked = eventQueue.ack(eventId);
    console.log(`[queue] Event acked: ${eventId} (${acked ? 'found' : 'not found'})`);
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ ok: true, acked }));
    return;
  }

  if (parsed.pathname === '/calendar/create' && req.method === 'POST') {
    parseBody(req).then(async (body) => {
      const account = body.account || ACCOUNT_NAMES[0];
      const mgr = calendarManagers.get(account);
      if (!mgr || !mgr.isAuthenticated()) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: `Account "${account}" not authenticated` }));
        return;
      }
      try {
        const result = await mgr.createEvent(body);
        console.log('[calendar/create] Event created');
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: true, event: result }));
      } catch (err) {
        console.error('[calendar/create] Error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (parsed.pathname === '/today' && req.method === 'GET') {
    const days = Math.min(Math.max(parseInt(parsed.query.days, 10) || 1, 1), 30);
    const managers = [...calendarManagers].filter(([, mgr]) => mgr.isAuthenticated());
    if (managers.length === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ events: [] }));
      return;
    }
    Promise.all(managers.map(([, mgr]) => mgr.getTodayEvents(days)))
      .then(results => {
        const events = results.flat();
        const seen = new Set();
        const deduped = events.filter(e => {
          const key = (e.meetingUrl || '') + '|' + e.start;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        deduped.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ events: deduped }));
      })
      .catch(err => {
        console.error('[today] Error:', err.message);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ events: [], error: err.message }));
      });
    return;
  }

  if (parsed.pathname === '/captures' && req.method === 'GET') {
    try {
      const dirs = fs.existsSync(CAPTURES_DIR)
        ? fs.readdirSync(CAPTURES_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name)
            .sort()
            .reverse()
        : [];

      const captures = dirs.map(dir => {
        const sessionDir = path.join(CAPTURES_DIR, dir);
        const info = { id: dir, title: dir, date: null, transcriptSegments: 0, frameCount: 0, hasSlides: false };

        try {
          const transcriptPath = path.join(sessionDir, 'transcript.json');
          if (fs.existsSync(transcriptPath)) {
            const t = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
            info.title = t.tabTitle || dir;
            info.startTime = t.startTime || null;
            info.endTime = t.endTime || null;
            info.date = t.startTime ? new Date(t.startTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
            info.time = t.startTime ? new Date(t.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
            if (t.startTime && t.endTime) {
              const ms = new Date(t.endTime).getTime() - new Date(t.startTime).getTime();
              const mins = Math.round(ms / 60000);
              info.duration = mins < 1 ? '<1 min' : `${mins} min`;
            }
            info.transcriptSegments = (t.segments || []).length;
            const full = t.fullText || (t.segments || []).map(s => s.text).join(' ');
            if (full) {
              info.preview = full.length > 120 ? full.slice(0, 120).replace(/\s\S*$/, '...') : full;
            }
          }
        } catch {}

        try {
          const slideContentPath = path.join(sessionDir, 'slide-content.json');
          if (fs.existsSync(slideContentPath)) {
            const slides = JSON.parse(fs.readFileSync(slideContentPath, 'utf8'));
            const first = (slides.frames || []).find(frame => frame.content);
            if (first?.content) info.firstSlide = first.content.replace(/\s+/g, ' ').trim().slice(0, 150);
          }
        } catch {}

        try {
          const framesDir = path.join(sessionDir, 'frames');
          if (fs.existsSync(framesDir)) {
            info.frameCount = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).length;
            info.hasSlides = info.frameCount > 0;
          }
        } catch {}

        info.files = ['combined.md', 'combined-output.json', 'transcript.json', 'slide-content.json']
          .filter(file => fs.existsSync(path.join(sessionDir, file)));

        return info;
      });

      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ captures }));
    } catch (err) {
      console.error('[captures] Error:', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ captures: [], error: err.message }));
    }
    return;
  }

  if (parsed.pathname === '/capture/replay' && req.method === 'POST') {
    parseBody(req).then(body => {
      if (!body || !isYouTubeUrl(body.url)) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: 'A valid YouTube HTTPS URL is required' }));
        return;
      }

      const { replay } = require('./replay');
      const opts = {
        threshold: body.threshold || 0.03,
        noVision: body.noVision || false,
        keepVideo: body.keepVideo || false
      };

      const replayId = `replay-${Date.now()}`;
      res.writeHead(202, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ status: 'started', replayId, url: body.url }));

      console.log('[replay] Starting capture');
      replay(body.url, opts)
        .then(dir => console.log(`[replay] Complete: ${dir}`))
        .catch(err => console.error(`[replay] Failed: ${err.message}`));
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let session = null;

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (session?.deepgramWs?.readyState === WebSocket.OPEN) {
        session.deepgramWs.send(data);
      }
      return;
    }

    let message;
    try { message = JSON.parse(data.toString()); }
    catch { ws.close(1008, 'Invalid message'); return; }
    switch (message.type) {
      case 'start':
        if (!tokenMatches(message.token)) {
          ws.close(1008, 'Unauthorized');
          return;
        }
        session = startSession(ws, message);
        break;
      case 'stop':
        if (session) {
          stopSession(session);
          session = null;
        }
        break;
      case 'frame':
        if (session) {
          handleFrame(session, message);
        }
        break;
    }
  });

  ws.on('close', () => {
    if (session) stopSession(session);
  });

  ws.on('error', (err) => {
    console.error('Extension WebSocket error:', err.message);
    if (session) stopSession(session);
  });
});

function startSession(ws, metadata) {
  if (!DEEPGRAM_API_KEY) {
    ws.send(JSON.stringify({ type: 'error', message: 'DEEPGRAM_API_KEY not configured on server' }));
    return null;
  }

  const sessionId = `${Date.now()}-tab${metadata.tabId}`;
  const sessionDir = path.join(CAPTURES_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const session = {
    id: sessionId,
    tabId: metadata.tabId,
    tabTitle: metadata.tabTitle,
    startTime: new Date().toISOString(),
    lastActivity: Date.now(),
    dir: sessionDir,
    ws,
    deepgramWs: null,
    transcript: [],
    frames: []
  };

  const dgUrl = new URL('wss://api.deepgram.com/v1/listen');
  dgUrl.searchParams.set('model', 'nova-2');
  dgUrl.searchParams.set('encoding', 'linear16');
  dgUrl.searchParams.set('sample_rate', '16000');
  dgUrl.searchParams.set('channels', '1');
  dgUrl.searchParams.set('punctuate', 'true');
  dgUrl.searchParams.set('interim_results', 'true');

  const dgWs = new WebSocket(dgUrl.toString(), {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
  });

  dgWs.on('open', () => {
    console.log(`[${sessionId}] Deepgram connected`);
    ws.send(JSON.stringify({ type: 'status', status: 'transcribing' }));
  });

  dgWs.on('message', (raw) => {
    const result = JSON.parse(raw.toString());
    if (result.type !== 'Results') return;

    const alt = result.channel?.alternatives?.[0];
    if (!alt?.transcript) return;

    const text = alt.transcript;
    session.lastActivity = Date.now();
    if (result.is_final) {
      session.transcript.push({
        text,
        start: result.start,
        duration: result.duration,
        confidence: alt.confidence,
        timestamp: new Date().toISOString()
      });
      saveTranscript(session);
      console.log(`[${sessionId}] Transcript segment received`);
    }

    ws.send(JSON.stringify({
      type: 'transcript',
      text,
      isFinal: result.is_final,
      start: result.start,
      duration: result.duration
    }));
  });

  dgWs.on('error', (err) => {
    console.error(`[${sessionId}] Deepgram error:`, err.message);
    ws.send(JSON.stringify({ type: 'error', message: `Deepgram error: ${err.message}` }));
  });

  dgWs.on('close', (code) => {
    console.log(`[${sessionId}] Deepgram disconnected (${code})`);
  });

  session.deepgramWs = dgWs;
  activeSessions.set(sessionId, session);
  console.log(`[${sessionId}] Session started: "${metadata.tabTitle}"`);
  return session;
}

function stopSession(session) {
  if (session.deepgramWs) {
    if (session.deepgramWs.readyState === WebSocket.OPEN) {
      session.deepgramWs.send(JSON.stringify({ type: 'CloseStream' }));
    }
    session.deepgramWs.close();
  }

  saveTranscript(session);
  saveSlideContent(session);
  generateCombinedOutput(session);
  activeSessions.delete(session.id);
  console.log(`[${session.id}] Session stopped — ${session.transcript.length} segments, ${session.frames.length} frames saved`);
}

const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions) {
    const idle = now - session.lastActivity;
    if (idle >= INACTIVITY_TIMEOUT_MS) {
      console.log(`[${id}] No activity for ${Math.round(idle / 60000)}m — stopping session (safety net)`);
      stopSession(session);
    }
  }
}, 60 * 1000);

async function handleFrame(session, message) {
  const { frameIndex, timestamp, data } = message;
  session.lastActivity = Date.now();

  const framesDir = path.join(session.dir, 'frames');
  fs.mkdirSync(framesDir, { recursive: true });

  const filename = `frame-${String(frameIndex).padStart(3, '0')}.jpg`;
  const filepath = path.join(framesDir, filename);
  fs.writeFileSync(filepath, Buffer.from(data, 'base64'));

  const frameRecord = { index: frameIndex, filename, timestamp, content: null };
  session.frames.push(frameRecord);

  console.log(`[${session.id}] Frame ${frameIndex} saved`);

  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text: 'Extract all visible text and content from this screen capture. Include titles, headings, bullet points, and any other readable text. Format as clean structured text.' }
          ]
        }]
      });

      frameRecord.content = response.content[0].text;
      saveSlideContent(session);
      console.log(`[${session.id}] Frame ${frameIndex} content extracted`);
    } catch (err) {
      console.error(`[${session.id}] Vision API error for frame ${frameIndex}:`, err.message);
    }
  }
}

function saveTranscript(session) {
  const data = {
    sessionId: session.id,
    tabId: session.tabId,
    tabTitle: session.tabTitle,
    startTime: session.startTime,
    endTime: new Date().toISOString(),
    segments: session.transcript,
    fullText: session.transcript.map(s => s.text).join(' ')
  };
  fs.writeFileSync(
    path.join(session.dir, 'transcript.json'),
    JSON.stringify(data, null, 2)
  );
}

function saveSlideContent(session) {
  if (session.frames.length === 0) return;
  const data = {
    sessionId: session.id,
    frames: session.frames.map(f => ({
      index: f.index,
      filename: f.filename,
      timestamp: f.timestamp,
      content: f.content
    }))
  };
  fs.writeFileSync(
    path.join(session.dir, 'slide-content.json'),
    JSON.stringify(data, null, 2)
  );
}

function generateCombinedOutput(session) {
  if (session.transcript.length === 0 && session.frames.length === 0) return;

  const endTime = new Date().toISOString();

  const timeline = [];

  for (const frame of session.frames) {
    timeline.push({
      type: 'slide',
      time: new Date(frame.timestamp).getTime(),
      timestamp: frame.timestamp,
      data: frame
    });
  }

  for (const seg of session.transcript) {
    timeline.push({
      type: 'transcript',
      time: new Date(seg.timestamp).getTime(),
      timestamp: seg.timestamp,
      data: seg
    });
  }

  timeline.sort((a, b) => a.time - b.time);

  const lines = [];
  lines.push(`# ${session.tabTitle}`);
  lines.push('');
  lines.push(`**Session:** ${session.id}`);
  lines.push(`**Started:** ${session.startTime}`);
  lines.push(`**Ended:** ${endTime}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  let transcriptBuffer = [];

  for (const event of timeline) {
    if (event.type === 'slide') {
      if (transcriptBuffer.length > 0) {
        lines.push('**Transcript:**');
        lines.push(`> ${transcriptBuffer.join(' ')}`);
        lines.push('');
      }
      transcriptBuffer = [];

      lines.push(`## Slide ${event.data.index} — ${formatTime(event.timestamp)}`);
      lines.push('');
      if (event.data.content) {
        lines.push(event.data.content);
        lines.push('');
      }
    } else {
      transcriptBuffer.push(event.data.text);
    }
  }

  if (transcriptBuffer.length > 0) {
    lines.push('**Transcript:**');
    lines.push(`> ${transcriptBuffer.join(' ')}`);
    lines.push('');
  }

  fs.writeFileSync(
    path.join(session.dir, 'combined.md'),
    lines.join('\n')
  );

  const structuredOutput = {
    version: '1.0',
    session: {
      id: session.id,
      title: session.tabTitle,
      tabId: session.tabId,
      startTime: session.startTime,
      endTime
    },
    summary: {
      transcriptSegments: session.transcript.length,
      framesCaptured: session.frames.length,
      durationMs: new Date(endTime).getTime() - new Date(session.startTime).getTime(),
      fullTranscript: session.transcript.map(s => s.text).join(' ')
    },
    timeline: timeline.map(e => {
      if (e.type === 'slide') {
        return {
          type: 'slide',
          timestamp: e.timestamp,
          slideIndex: e.data.index,
          frameFile: `frames/${e.data.filename}`,
          content: e.data.content
        };
      }
      return {
        type: 'transcript',
        timestamp: e.timestamp,
        text: e.data.text,
        start: e.data.start,
        duration: e.data.duration,
        confidence: e.data.confidence
      };
    }),
    slides: session.frames.map(f => ({
      index: f.index,
      timestamp: f.timestamp,
      frameFile: `frames/${f.filename}`,
      content: f.content
    })),
    transcript: {
      segments: session.transcript,
      fullText: session.transcript.map(s => s.text).join(' ')
    }
  };

  fs.writeFileSync(
    path.join(session.dir, 'combined-output.json'),
    JSON.stringify(structuredOutput, null, 2)
  );

  console.log(`[${session.id}] Combined output written (md + json)`);
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

httpServer.listen(PORT, HOST, () => {
  console.log(`Scout companion server running on port ${PORT}`);
  console.log(`Dashboard: http://${HOST}:${PORT}/dashboard`);
  console.log(`Status API: http://${HOST}:${PORT}/status`);
  console.log(`Captures: ${CAPTURES_DIR}`);
  if (!DEEPGRAM_API_KEY) {
    console.warn('\nWARNING: DEEPGRAM_API_KEY not set — add it to .env');
  }
  if (!anthropic) {
    console.warn('WARNING: ANTHROPIC_API_KEY not set — slide content extraction disabled');
  }
  if (calendarManagers.size === 0) {
    console.warn('WARNING: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — calendar disabled');
    console.warn('  See README.md for Google Calendar setup instructions');
  } else {
    for (const [name, mgr] of calendarManagers) {
      if (mgr.isAuthenticated()) {
        console.log(`Google Calendar connected: ${name}`);
      } else {
        console.log(`Calendar not yet connected: ${name} — open the authenticated dashboard, then visit /auth/login?account=${name}`);
      }
    }
  }
});
