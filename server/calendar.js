const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.scout');

class CalendarManager {
  constructor({ name, clientId, clientSecret, redirectUri }) {
    this.name = name;
    this.tokensPath = path.join(CONFIG_DIR, `tokens-${name}.json`);
    this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    this.calendar = null;

    this.oauth2Client.on('tokens', (tokens) => {
      const existing = this.loadTokensRaw();
      this.saveTokens({ ...existing, ...tokens });
    });

    this.loadTokens();
  }

  loadTokensRaw() {
    try {
      return JSON.parse(fs.readFileSync(this.tokensPath, 'utf8'));
    } catch {
      return {};
    }
  }

  loadTokens() {
    const tokens = this.loadTokensRaw();
    if (tokens.refresh_token) {
      this.oauth2Client.setCredentials(tokens);
      this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
    }
  }

  saveTokens(tokens) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.tokensPath, JSON.stringify(tokens, null, 2));
    this.oauth2Client.setCredentials(tokens);
    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
  }

  getAuthUrl() {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar.events'],
      prompt: 'consent',
      state: this.name
    });
  }

  async handleCallback(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.saveTokens(tokens);
  }

  isAuthenticated() {
    return !!this.calendar;
  }

  async getTodayEvents(days = 1) {
    if (!this.calendar) return [];

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + days);

    const res = await this.calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    return (res.data.items || [])
      .map(e => {
        const url = extractMeetingUrl(e);
        return {
          id: `${this.name}:${e.id}`,
          account: this.name,
          summary: e.summary || '(no title)',
          description: cleanDescription(e.description),
          location: e.location || null,
          calendarLink: e.htmlLink || null,
          start: e.start.dateTime || e.start.date,
          end: e.end.dateTime || e.end.date,
          meetingUrl: url,
          platform: url ? detectPlatform(url) : null
        };
      });
  }

  async searchEvents({ query, daysAhead = 14 }) {
    if (!this.calendar) return [];

    const now = new Date();
    const future = new Date(now);
    future.setDate(future.getDate() + daysAhead);

    const res = await this.calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: future.toISOString(),
      q: query,
      singleEvents: true,
      orderBy: 'startTime'
    });

    return (res.data.items || []).map(e => {
      const url = extractMeetingUrl(e);
      return {
        id: `${this.name}:${e.id}`,
        account: this.name,
        summary: e.summary || '(no title)',
        description: cleanDescription(e.description),
        location: e.location || null,
        calendarLink: e.htmlLink || null,
        start: e.start.dateTime || e.start.date,
        end: e.end.dateTime || e.end.date,
        meetingUrl: url,
        platform: url ? detectPlatform(url) : null
      };
    });
  }
}

const JOIN_NOISE = [
  /join zoom meeting/i, /join with google meet/i, /join microsoft teams/i,
  /meeting id\s*[:=]/i, /passcode\s*[:=]/i, /password\s*[:=]/i,
  /one.tap\s*(mobile)?/i, /phone one.tap/i,
  /dial by your location/i, /find your local number/i,
  /join via (audio|phone|computer)/i, /join (by|from) (a )?(pc|mac|phone|computer)/i,
  /https?:\/\/\S+/g, /^\s*[-–—]+\s*$/,
  /^\s*_{3,}\s*$/, /^\s*\*{3,}\s*$/,
  /telephone\s*[:=]/i, /participant\s*(id|code)\s*[:=]/i,
  /tap to join/i, /click here to join/i, /join the meeting/i,
  /webinar id\s*[:=]/i, /access code\s*[:=]/i,
  /do not share this link/i, /this link is unique/i,
  /you('re| are) invited to/i, /calendar event/i,
  /\+?\d[\d\s,#*()-]{8,}/,
  /^\s*\d{9,11}\s*$/,
  /^\s*US\s*(\(|$)/i,
  /\(washington|new york|chicago|los angeles|san jose/i,
  /h\.323|sip\s*:/i, /room system/i,
  /^\s*\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\s/,
  /\(us west\)|\(us east\)|\(india|\(europe|\(asia|\(australia/i,
  /join from an? /i,
];

function cleanDescription(raw) {
  if (!raw) return null;

  let text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, '')
    .replace(/&\w+;/g, '');

  const lines = text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !JOIN_NOISE.some(pattern => pattern.test(l)));

  text = lines.join(' ').replace(/\s{2,}/g, ' ').trim();

  if (text.length < 5) return null;
  if (text.length > 200) text = text.slice(0, 200).replace(/\s\S*$/, '…');

  return text;
}

const MEETING_DOMAINS = [
  'zoom.us', 'meet.google.com', 'teams.microsoft.com', 'teams.live.com',
  'webex.com', 'goldcast.io', 'cvent.com', 'cvent.me', 'on24.com',
  'gotomeeting.com', 'whereby.com', 'livestorm.co', 'hopin.com',
  'bigmarker.com', 'crowdcast.io', 'demio.com', 'streamyard.com',
  'hardskill.exchange'
];

function isMeetingUrl(url) {
  return MEETING_DOMAINS.some(domain => url.includes(domain));
}

const EVENT_PATH_PATTERNS = [
  /\/(join|watch|live|stream|webinar|event|session|attend|experience|broadcast|keynote|summit)\b/i,
  /\/(register|rsvp|signup|sign-up)\b/i,
  /\/plus\//i,
];

const NOT_EVENT_PATTERNS = [
  /\/(unsubscribe|privacy|terms|help|support|feedback|settings|profile|account|legal|cookie|opt-out)\b/i,
  /google\.com\/(calendar|docs|drive|sheets|forms)/i,
  /github\.com/i, /wikipedia\.org/i, /linkedin\.com\/(in|company)\//i,
];

function isLikelyEventUrl(value) {
  const lower = value.toLowerCase();
  return !NOT_EVENT_PATTERNS.some(p => p.test(lower)) && EVENT_PATH_PATTERNS.some(p => p.test(lower));
}

function extractDescriptionUrls(description) {
  if (!description) return [];
  return (description.match(/https?:\/\/[^\s<>")\]]+/g) || []).map(value => value.replace(/[.,;:!?]+$/, ''));
}

function extractMeetingUrl(event) {
  if (event.hangoutLink) return event.hangoutLink;

  if (event.conferenceData?.entryPoints) {
    const videoEntry = event.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
    if (videoEntry) return videoEntry.uri;
  }

  if (event.location && /^https?:\/\//.test(event.location.trim())) {
    const loc = event.location.trim();
    if (isMeetingUrl(loc)) return loc;
  }

  const urls = extractDescriptionUrls(event.description);
  for (const value of urls) if (isMeetingUrl(value)) return value;
  for (const value of urls) if (isLikelyEventUrl(value)) return value;
  if (event.location && /^https?:\/\//.test(event.location.trim()) && isLikelyEventUrl(event.location.trim())) return event.location.trim();
  const nonTrivial = urls.filter(value => !NOT_EVENT_PATTERNS.some(p => p.test(value)));
  if (nonTrivial.length === 1) return nonTrivial[0];

  return null;
}

function detectPlatform(url) {
  if (!url) return 'unknown';
  if (url.includes('zoom.us')) return 'zoom';
  if (url.includes('meet.google.com')) return 'google-meet';
  if (url.includes('teams.microsoft.com') || url.includes('teams.live.com')) return 'teams';
  if (url.includes('goldcast.io')) return 'goldcast';
  if (url.includes('cvent.com') || url.includes('cvent.me')) return 'cvent';
  if (url.includes('webex.com')) return 'webex';
  if (url.includes('on24.com')) return 'on24';
  if (url.includes('salesforce.com/plus')) return 'salesforce-plus';
  return 'generic';
}

CalendarManager.prototype.createEvent = async function({ summary, description, start, end, location, colorId }) {
  if (!this.calendar) throw new Error(`Calendar account "${this.name}" not authenticated`);

  const event = {
    summary,
    description: description || '',
    start: { dateTime: start },
    end: { dateTime: end },
  };
  if (location) event.location = location;
  if (colorId) event.colorId = colorId;

  const res = await this.calendar.events.insert({
    calendarId: 'primary',
    requestBody: event,
  });

  return { id: res.data.id, htmlLink: res.data.htmlLink, summary: res.data.summary };
};

module.exports = CalendarManager;
