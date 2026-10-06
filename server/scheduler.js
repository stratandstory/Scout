const fs = require('fs');
const path = require('path');
const os = require('os');

const QUEUE_PATH = path.join(os.homedir(), '.scout', 'queued-events.json');

class EventQueue {
  constructor(options = {}) {
    this.leadTimeMs = (options.leadTimeMinutes || 2) * 60 * 1000;
    const loaded = this.load();
    this.events = loaded.events;
    this.ackedIds = new Set(loaded.ackedIds);
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
      return { events: data.events || [], ackedIds: data.ackedIds || [] };
    } catch {
      return { events: [], ackedIds: [] };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(QUEUE_PATH, JSON.stringify({
      events: this.events,
      ackedIds: [...this.ackedIds]
    }, null, 2));
  }

  add(event) {
    this.events = this.events.filter(e => e.id !== event.id);
    this.events.push({ ...event, queuedAt: new Date().toISOString() });
    this.events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    this.save();
    return event;
  }

  update(eventId, fields) {
    const event = this.events.find(e => e.id === eventId);
    if (!event) return null;
    Object.assign(event, fields);
    this.save();
    return event;
  }

  remove(eventId) {
    const existed = this.events.some(e => e.id === eventId);
    this.events = this.events.filter(e => e.id !== eventId);
    this.ackedIds.delete(eventId);
    this.save();
    return existed;
  }

  ack(eventId) {
    const exists = this.events.some(e => e.id === eventId);
    if (!exists) return false;
    this.ackedIds.add(eventId);
    this.save();
    return true;
  }

  list() {
    const now = Date.now();
    return this.events.map(e => {
      const startTime = new Date(e.start).getTime();
      const endTime = new Date(e.end).getTime();
      let status = 'queued';
      if (this.ackedIds.has(e.id)) status = 'opened';
      else if (now > endTime) status = 'missed';
      else if (now >= startTime) status = 'in-progress';
      return { ...e, status, minutesUntilStart: Math.round((startTime - now) / 60000) };
    });
  }

  getReady() {
    const now = Date.now();
    const ready = [];
    for (const event of this.events) {
      if (this.ackedIds.has(event.id)) continue;
      const startTime = new Date(event.start).getTime();
      const endTime = new Date(event.end).getTime();
      const joinTime = startTime - this.leadTimeMs;
      if (now >= joinTime && now < endTime) {
        ready.push(event);
      }
    }
    return ready;
  }

  prune() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    const pruned = this.events.filter(e => new Date(e.end).getTime() <= cutoff);
    for (const e of pruned) {
      this.ackedIds.delete(e.id);
    }
    this.events = this.events.filter(e => new Date(e.end).getTime() > cutoff);
    this.save();
  }
}

module.exports = EventQueue;
