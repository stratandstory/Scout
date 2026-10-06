#!/usr/bin/env node

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Anthropic = require('@anthropic-ai/sdk').default;

const CAPTURES_DIR = path.join(os.homedir(), 'Scout-captures');
fs.mkdirSync(CAPTURES_DIR, { recursive: true });

async function replay(videoUrl, opts = {}) {
  const threshold = opts.threshold || 0.6;
  const interval = opts.interval || null;
  const keepVideo = opts.keepVideo || false;
  const skipVision = opts.noVision || false;
  const concurrency = opts.concurrency || 5;
  const resumeDir = opts.resume || null;

  // --- 1. Video metadata ---
  console.log('Fetching video info...');
  const meta = JSON.parse(
    execFileSync('yt-dlp', ['--dump-json', '--no-download', '--no-playlist', videoUrl], {
      maxBuffer: 50 * 1024 * 1024
    }).toString()
  );

  const title = meta.title || 'Untitled';
  const duration = meta.duration || 0;
  const videoId = meta.id;
  console.log(`  "${title}"`);
  console.log(`  ${Math.floor(duration / 60)}m ${duration % 60}s`);

  // --- 2. Session directory ---
  let sessionDir, sessionId, framesDir;
  if (resumeDir) {
    sessionDir = path.resolve(resumeDir);
    sessionId = path.basename(sessionDir);
    framesDir = path.join(sessionDir, 'frames');
    console.log(`Resuming from: ${sessionDir}`);
  } else {
    sessionId = `${Date.now()}-replay-${videoId}`;
    sessionDir = path.join(CAPTURES_DIR, sessionId);
    framesDir = path.join(sessionDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });
  }

  const startTime = new Date().toISOString();
  const sessionStartMs = new Date(startTime).getTime();

  // --- 3. Download captions ---
  console.log('Downloading captions...');
  const subsDir = path.join(sessionDir, '_subs');
  fs.mkdirSync(subsDir, { recursive: true });

  try {
    execFileSync('yt-dlp', [
      '--write-auto-subs', '--sub-format', 'json3', '--sub-langs', 'en.*,en',
      '--skip-download', '--no-playlist', '-o', path.join(subsDir, '%(id)s'), videoUrl
    ],
      { stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 }
    );
  } catch {
    console.warn('  No English auto-captions found. Transcript will be empty.');
  }

  const transcript = parseSubtitles(subsDir, sessionStartMs, duration);
  console.log(`  ${transcript.length} transcript segments`);

  fs.rmSync(subsDir, { recursive: true, force: true });

  // --- 4 & 5. Download video + extract frames (skip if resuming with existing frames) ---
  let frameTimestamps;
  const existingFrames = fs.existsSync(framesDir)
    ? fs.readdirSync(framesDir).filter(f => f.startsWith('frame-') && f.endsWith('.jpg')).sort()
    : [];

  if (resumeDir && existingFrames.length > 0) {
    console.log(`Using ${existingFrames.length} existing frames from previous run`);
    frameTimestamps = existingFrames.map((_, i) => (i / existingFrames.length) * duration);
  } else {
    console.log('Downloading video...');
    const videoPath = path.join(sessionDir, 'video.mp4');
    execFileSync('yt-dlp', [
      '-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]',
      '--merge-output-format', 'mp4', '--no-playlist', '-o', videoPath, videoUrl
    ],
      { stdio: 'inherit', timeout: 600000 }
    );

    if (interval) {
      console.log(`Sampling frames every ${interval}s...`);
      frameTimestamps = await extractFramesAtInterval(videoPath, framesDir, interval, duration);
      console.log(`  ${frameTimestamps.length} frames sampled`);
    } else {
      console.log(`Detecting slide changes (threshold: ${threshold})...`);
      frameTimestamps = await extractFramesByScene(videoPath, framesDir, threshold);
      console.log(`  ${frameTimestamps.length} slide changes detected`);
      if (frameTimestamps.length > 200) {
        console.log(`  Warning: many frames detected. Try --threshold 0.7 or --interval 30`);
      }
    }

    if (!keepVideo) {
      fs.unlinkSync(videoPath);
    }
  }

  // --- 6. Vision extraction (concurrent) ---
  const frames = [];
  let anthropic = null;
  if (process.env.ANTHROPIC_API_KEY && !skipVision) {
    anthropic = new Anthropic();
  }

  if (anthropic && frameTimestamps.length > 0) {
    console.log(`Extracting slide content (${frameTimestamps.length} frames, concurrency: ${concurrency})...`);

    async function processFrame(i) {
      const frameIndex = i + 1;
      const filename = `frame-${String(frameIndex).padStart(4, '0')}.jpg`;
      const filepath = path.join(framesDir, filename);
      const videoTimeSec = frameTimestamps[i];
      const timestamp = new Date(sessionStartMs + videoTimeSec * 1000).toISOString();

      let content = null;
      try {
        const imageData = fs.readFileSync(filepath).toString('base64');
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
              { type: 'text', text: 'Extract all visible text and content from this screen capture. Include titles, headings, bullet points, and any other readable text. Format as clean structured text.' }
            ]
          }]
        });
        content = response.content[0].text;
        console.log(`  [${frameIndex}/${frameTimestamps.length}] extracted`);
      } catch (err) {
        console.log(`  [${frameIndex}/${frameTimestamps.length}] FAILED: ${err.message}`);
      }

      return { index: frameIndex, filename, timestamp, content };
    }

    for (let batch = 0; batch < frameTimestamps.length; batch += concurrency) {
      const batchEnd = Math.min(batch + concurrency, frameTimestamps.length);
      const promises = [];
      for (let i = batch; i < batchEnd; i++) {
        promises.push(processFrame(i));
      }
      const results = await Promise.all(promises);
      frames.push(...results);
    }
    frames.sort((a, b) => a.index - b.index);
  } else {
    for (let i = 0; i < frameTimestamps.length; i++) {
      const frameIndex = i + 1;
      const filename = `frame-${String(frameIndex).padStart(4, '0')}.jpg`;
      const timestamp = new Date(sessionStartMs + frameTimestamps[i] * 1000).toISOString();
      frames.push({ index: frameIndex, filename, timestamp, content: null });
    }
    if (frameTimestamps.length > 0 && !anthropic) {
      console.log('  Skipping Vision extraction (no API key or --no-vision)');
    }
  }

  // --- 7. Generate output ---
  const endTime = new Date().toISOString();
  const session = {
    id: sessionId,
    tabTitle: title,
    startTime,
    transcript,
    frames,
    dir: sessionDir,
    source: { type: 'youtube-replay', url: videoUrl, videoId, duration }
  };

  saveTranscript(session, endTime);
  saveSlideContent(session);
  generateCombinedOutput(session, endTime);

  console.log(`\nDone: ${sessionDir}`);
  console.log(`  ${transcript.length} transcript segments, ${frames.length} slides`);
  return sessionDir;
}

// --- Subtitle parsing ---

function parseSubtitles(subsDir, sessionStartMs, videoDuration) {
  const files = fs.existsSync(subsDir)
    ? fs.readdirSync(subsDir).filter(f => f.endsWith('.json3'))
    : [];

  if (files.length === 0) return [];

  const json3 = JSON.parse(fs.readFileSync(path.join(subsDir, files[0]), 'utf-8'));
  const events = (json3.events || []).filter(e => e.segs && e.segs.length > 0);

  const segments = [];
  let chunkWords = [];
  let chunkStartMs = 0;
  let lastEventEndMs = 0;

  for (const event of events) {
    const text = event.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
    if (!text) continue;

    const eventStartMs = event.tStartMs || 0;
    const eventDurationMs = event.dDurationMs || 0;

    if (chunkWords.length === 0) {
      chunkStartMs = eventStartMs;
    }

    const gap = eventStartMs - lastEventEndMs;
    const chunkDuration = eventStartMs - chunkStartMs;

    if (chunkWords.length > 0 && (gap > 2000 || chunkDuration > 15000 || chunkWords.join(' ').length > 200)) {
      segments.push({
        text: chunkWords.join(' '),
        timestamp: new Date(sessionStartMs + chunkStartMs).toISOString(),
        start: chunkStartMs / 1000,
        duration: (eventStartMs - chunkStartMs) / 1000,
        confidence: 1.0
      });
      chunkWords = [];
      chunkStartMs = eventStartMs;
    }

    chunkWords.push(text);
    lastEventEndMs = eventStartMs + eventDurationMs;
  }

  if (chunkWords.length > 0) {
    segments.push({
      text: chunkWords.join(' '),
      timestamp: new Date(sessionStartMs + chunkStartMs).toISOString(),
      start: chunkStartMs / 1000,
      duration: Math.max(0, (videoDuration * 1000 - chunkStartMs) / 1000),
      confidence: 1.0
    });
  }

  return segments;
}

// --- Frame extraction ---

function extractFramesAtInterval(videoPath, framesDir, intervalSec, duration) {
  return new Promise((resolve, reject) => {
    let stderrBuf = '';

    const proc = spawn('ffmpeg', [
      '-i', videoPath,
      '-vf', `fps=1/${intervalSec},showinfo`,
      '-q:v', '2',
      path.join(framesDir, 'frame-%04d.jpg')
    ]);

    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
    });

    proc.on('close', (code) => {
      const frameFiles = fs.readdirSync(framesDir).filter(f => f.startsWith('frame-')).sort();
      if (frameFiles.length === 0 && code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
        return;
      }
      const timestamps = [];
      for (const line of stderrBuf.split('\n')) {
        const match = line.match(/\[Parsed_showinfo.*\].*pts_time:([\d.]+)/);
        if (match) {
          timestamps.push(parseFloat(match[1]));
        }
      }
      while (timestamps.length < frameFiles.length) {
        timestamps.push(timestamps.length * intervalSec);
      }
      resolve(timestamps.slice(0, frameFiles.length));
    });

    proc.on('error', reject);
  });
}

function extractFramesByScene(videoPath, framesDir, threshold) {
  return new Promise((resolve, reject) => {
    let stderrBuf = '';
    const proc = spawn('ffmpeg', [
      '-i', videoPath,
      '-vf', `select='gt(scene,${threshold})',showinfo`,
      '-fps_mode', 'vfr',
      '-q:v', '2',
      path.join(framesDir, 'frame-%04d.jpg')
    ]);

    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
    });

    proc.on('close', (code) => {
      const frameFiles = fs.readdirSync(framesDir).filter(f => f.startsWith('frame-')).sort();
      if (frameFiles.length === 0 && code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code} and produced no frames. Try a lower --threshold.`));
        return;
      }
      const timestamps = [];
      for (const line of stderrBuf.split('\n')) {
        const match = line.match(/\[Parsed_showinfo.*\].*pts_time:([\d.]+)/);
        if (match) {
          timestamps.push(parseFloat(match[1]));
        }
      }
      while (timestamps.length < frameFiles.length) {
        const last = timestamps.length > 0 ? timestamps[timestamps.length - 1] : 0;
        timestamps.push(last + 30);
      }
      resolve(timestamps.slice(0, frameFiles.length));
    });

    proc.on('error', reject);
  });
}

// --- Output generation (matches live capture format from index.js) ---

function saveTranscript(session, endTime) {
  const data = {
    sessionId: session.id,
    source: session.source,
    tabTitle: session.tabTitle,
    startTime: session.startTime,
    endTime,
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

function generateCombinedOutput(session, endTime) {
  if (session.transcript.length === 0 && session.frames.length === 0) return;

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

  // --- Markdown ---
  const sessionStartMs = new Date(session.startTime).getTime();
  const lines = [];
  lines.push(`# ${session.tabTitle}`);
  lines.push('');
  if (session.source) {
    lines.push(`**Source:** [YouTube replay](${session.source.url})`);
    lines.push(`**Duration:** ${formatVideoDuration(session.source.duration)}`);
  }
  lines.push(`**Session:** ${session.id}`);
  lines.push(`**Captured:** ${session.startTime}`);
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

      const videoTime = formatVideoTime(event.time - sessionStartMs);
      lines.push(`## Slide ${event.data.index} — ${videoTime}`);
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

  fs.writeFileSync(path.join(session.dir, 'combined.md'), lines.join('\n'));

  // --- Structured JSON ---
  const structuredOutput = {
    version: '1.0',
    source: session.source || null,
    session: {
      id: session.id,
      title: session.tabTitle,
      startTime: session.startTime,
      endTime
    },
    summary: {
      transcriptSegments: session.transcript.length,
      framesCaptured: session.frames.length,
      durationMs: session.source ? session.source.duration * 1000 : (new Date(endTime).getTime() - new Date(session.startTime).getTime()),
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

  console.log(`  Output written: combined.md + combined-output.json`);
}

function formatVideoTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatVideoDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

// --- CLI ---

if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = {};
  let videoUrl = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keep-video') flags.keepVideo = true;
    else if (args[i] === '--no-vision') flags.noVision = true;
    else if (args[i] === '--threshold' && args[i + 1]) flags.threshold = parseFloat(args[++i]);
    else if (args[i] === '--interval' && args[i + 1]) flags.interval = parseInt(args[++i]);
    else if (args[i] === '--concurrency' && args[i + 1]) flags.concurrency = parseInt(args[++i]);
    else if (args[i] === '--resume' && args[i + 1]) flags.resume = args[++i];
    else if (!args[i].startsWith('--')) videoUrl = args[i];
  }

  if (!videoUrl) {
    console.log('Scout Replay Capture');
    console.log('');
    console.log('Usage: node replay.js <youtube-url> [options]');
    console.log('');
    console.log('Frame extraction (pick one):');
    console.log('  --threshold N    Scene detection sensitivity (default: 0.6, lower = more frames)');
    console.log('  --interval N     Sample one frame every N seconds instead of scene detection');
    console.log('');
    console.log('Other:');
    console.log('  --keep-video     Keep the downloaded video file');
    console.log('  --no-vision      Skip Claude Vision slide extraction');
    console.log('  --concurrency N  Parallel Vision API calls (default: 5)');
    console.log('  --resume <dir>   Resume from an existing session directory (reuse frames)');
    console.log('');
    console.log('Output: ~/Scout-captures/<session-id>/');
    process.exit(1);
  }

  replay(videoUrl, flags).catch(err => {
    console.error('\nFailed:', err.message);
    process.exit(1);
  });
}

module.exports = { replay };
