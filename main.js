'use strict';

const { Plugin, Modal, Setting, Notice, requestUrl, PluginSettingTab } = require('obsidian');

// ------------------------------------------------------------
// Constants
// ------------------------------------------------------------

const DEFAULT_SETTINGS = {
    icloudUsr: '',
    icloudPwd: '',
    icloudCal: '',
};

// WMO weather code → emoji (matches weather.json)
const WEATHER_ICONS = {
    0: '☀️', 1: '🌤', 2: '⛅️', 3: '☁️',
    45: '🌫', 48: '🌫',
    51: '☔️', 53: '☔️', 55: '☔️',
    56: '☔️', 57: '☔️', 61: '☔️',
    63: '☔️', 65: '☔️', 66: '☔️', 67: '☔️',
    71: '❄️', 73: '❄️', 75: '❄️', 77: '❄️',
    80: '☔️', 81: '☔️', 82: '☔️',
    85: '❄️', 86: '❄️',
    95: '⚡️', 96: '⚡️', 99: '⚡️',
};

// Mon=0 … Sun=6  (matches Python's datetime.weekday())
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function formatTime(hhmm) {
    return `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
}

// Mirrors the Python adjust_file_name()
function adjustFileName(day, name) {
    return day + '_' + name
        .replace(/: /g, '_')
        .replace(/:/g, '-')
        .replace(/：/g, '_')
        .replace(/\//g, '-')
        .replace(/ /g, '-');
}

// Return three-letter day abbreviation for a YYYY-MM-DD string
function dowFor(dateStr) {
    const d = new Date(`${dateStr}T12:00:00Z`);
    return DOW[(d.getUTCDay() + 6) % 7]; // JS Sun=0 → Mon=0
}

// ------------------------------------------------------------
// iCal parsing
// ------------------------------------------------------------

// Undo iCal line-folding (continuation lines start with SP or HT)
function unfoldLines(text) {
    return text.replace(/\r?\n[ \t]/g, '');
}

// Find the first occurrence of a property (handles PARAM=…;… prefixes)
// Returns { value, rawLine } or null
function getProp(lines, key) {
    const re = new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, 'i');
    for (const line of lines) {
        const m = line.match(re);
        if (m) return { value: m[1].trim(), rawLine: line };
    }
    return null;
}

// Extract TZID parameter from a raw property line
function getTzid(rawLine) {
    const m = rawLine.match(/TZID=([^;:]+)/i);
    return m ? m[1] : null;
}

// Convert a local datetime string (YYYY-MM-DDTHH:MM:SS) in a given IANA
// timezone to an equivalent UTC timestamp (ms since epoch).
function localToUtcMs(localStr, ianaTimezone) {
    // Strategy: interpret the local string as UTC (naive), then compute the
    // actual UTC offset by seeing what that UTC instant looks like in the tz.
    const naiveUtc = new Date(localStr + 'Z').getTime();
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: ianaTimezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(new Date(naiveUtc));
    const g = t => parts.find(p => p.type === t)?.value ?? '00';
    const localFromUtc = new Date(`${g('year')}-${g('month')}-${g('day')}T${g('hour').replace('24','00')}:${g('minute')}:${g('second')}Z`).getTime();
    return naiveUtc + (naiveUtc - localFromUtc);
}

// Parse an iCal DTSTART/DTEND value.
// Returns { dateStr: 'YYYY-MM-DD', timeStr: 'HHMM' | null, isDate: bool }
function parseICalDt(value, tzid, targetTz) {
    // All-day (DATE form): YYYYMMDD
    if (/^\d{8}$/.test(value)) {
        return {
            dateStr: `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`,
            timeStr: null,
            isDate: true,
        };
    }

    const localStr = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(9,11)}:${value.slice(11,13)}:${value.slice(13,15)}`;
    let utcMs;

    if (value.endsWith('Z')) {
        utcMs = new Date(localStr + 'Z').getTime();
    } else {
        const tz = (tzid || targetTz).replace(/%2F/g, '/');
        utcMs = localToUtcMs(localStr, tz);
    }

    // Project into the target timezone
    const tz = targetTz.replace(/%2F/g, '/');
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date(utcMs));
    const g = t => parts.find(p => p.type === t)?.value ?? '00';

    return {
        dateStr: `${g('year')}-${g('month')}-${g('day')}`,
        timeStr: g('hour').replace('24', '00').padStart(2, '0') + g('minute').padStart(2, '0'),
        isDate: false,
    };
}

// Unescape common iCal text escapes
function unescape(s) {
    return s.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// Parse all VEVENTs from a raw iCal/CalDAV response body.
// Returns array of plain objects suitable for the OTEvent constructor.
function parseICalEvents(icalText, targetTz) {
    const events = [];
    const blocks = icalText.split(/BEGIN:VEVENT/i).slice(1);

    for (const block of blocks) {
        const text = unfoldLines(block);
        const lines = text.split(/\r?\n/).filter(Boolean);

        const summaryProp  = getProp(lines, 'SUMMARY');
        const dtstartProp  = getProp(lines, 'DTSTART');
        const dtendProp    = getProp(lines, 'DTEND');
        const locationProp = getProp(lines, 'LOCATION');
        const descProp     = getProp(lines, 'DESCRIPTION');

        if (!summaryProp || !dtstartProp) continue;

        const tzid  = getTzid(dtstartProp.rawLine);
        const start = parseICalDt(dtstartProp.value, tzid, targetTz);

        let end = start;
        if (dtendProp) {
            const etzid = getTzid(dtendProp.rawLine);
            end = parseICalDt(dtendProp.value, etzid, targetTz);
        }

        events.push({
            summary:     unescape(summaryProp.value),
            start,
            end,
            location:    locationProp ? unescape(locationProp.value) : '',
            description: descProp     ? unescape(descProp.value)     : '',
        });
    }

    return events;
}

// ------------------------------------------------------------
// OTEvent  —  mirrors the Python Event class
// ------------------------------------------------------------

class OTEvent {
    constructor(raw) {
        this.validEvent = true;
        this.mtgNote    = true;
        this.name       = raw.summary;

        // Name-convention decoding (matches Python logic exactly)
        if (/^\(.*\)$/.test(this.name)) {
            // (name) → skip entirely
            this.validEvent = false;
            this.mtgNote    = false;
            this.name       = this.name.slice(1, -1);
        } else if (/^\[.*\]$/.test(this.name)) {
            // [name] → show with wiki link, create meeting note
            this.name = this.name.slice(1, -1);
        } else if (/^<.*>$/.test(this.name)) {
            // <name> → show as plain text, no meeting note
            this.mtgNote = false;
            this.name    = this.name.slice(1, -1);
        }

        // All-day events (no time) are skipped
        if (raw.start.isDate) {
            this.validEvent = false;
            this.mtgNote    = false;
        }

        this.day       = raw.start.dateStr;
        this.timeStart = raw.start.timeStr ?? '0000';
        this.timeEnd   = raw.end.timeStr   ?? '0000';
        this.location  = raw.location;

        // Split DESCRIPTION into participants and tags (#tag lines)
        this.tags         = '';
        this.participants = '';
        if (raw.description) {
            for (const line of raw.description.split('\n')) {
                if (/^#\S+/.test(line.trim())) {
                    this.tags += line.trim().replace(/#/g, '') + ' ';
                } else if (line.trim()) {
                    this.participants += line + '\n';
                }
            }
            this.participants = this.participants.trimEnd();
            this.tags         = this.tags.trim();
        }
    }

    // Format one agenda line for the daily note
    formatEvent() {
        const range = `- ${formatTime(this.timeStart)}-${formatTime(this.timeEnd)}`;
        if (this.mtgNote) {
            const fname = adjustFileName(this.day, this.name);
            return `${range} [[${fname}|${this.day} ${this.name}]]`;
        }
        return `${range} ${this.name}`;
    }

    // Populate meeting_template.md and return the filled string
    buildMtgNote(template) {
        const dow = dowFor(this.day);
        return template
            .replace(/\{\{date:YYYY-MM-DD\}\}/g, this.day)
            .replace(/\{\{title\}\}/g, this.name)
            .replace(
                /\{\{date:\[\[\[\]YYYY-MM-DD\[\]\]\] \[\(\]ddd\[\)\] HH:mm\}\}/g,
                `[[${this.day}]] (${dow}) ${formatTime(this.timeStart)}-${formatTime(this.timeEnd)}`
            )
            .replace(/\{\{location\}\}/g, this.location)
            .replace(/\{\{participants\}\}/g, this.participants)
            .replace(/\{\{tags\}\}/g, this.tags);
    }
}

// ------------------------------------------------------------
// CalDAV client  —  replaces the Python caldav library
// ------------------------------------------------------------

class CalDAVClient {
    constructor(baseUrl, username, password) {
        this.baseUrl = baseUrl;
        this.auth    = 'Basic ' + btoa(`${username}:${password}`);
    }

    async req(method, url, body, extra = {}) {
        return requestUrl({
            url,
            method,
            headers: {
                Authorization: this.auth,
                'Content-Type': 'application/xml; charset=utf-8',
                ...extra,
            },
            body,
        });
    }

    // Pull the first <href> that lives inside a named element
    extractHref(xml, elementName) {
        const re = new RegExp(
            `<[^>]*:?${elementName}[^>]*>[\\s\\S]*?<[^>]*:?href[^>]*>(.*?)<\\/[^>]*:?href`,
            'i'
        );
        const m = xml.match(re);
        return m ? m[1].trim() : null;
    }

    resolve(path) {
        return path.startsWith('http') ? path : `https://caldav.icloud.com${path}`;
    }

    // Step 1: discover the user's principal URL
    async getPrincipalUrl() {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:">
  <A:prop><A:current-user-principal/></A:prop>
</A:propfind>`;
        const res = await this.req('PROPFIND', this.baseUrl, xml, { Depth: '0' });
        const path = this.extractHref(res.text, 'current-user-principal');
        if (!path) throw new Error('iCloud CalDAV: could not resolve principal URL');
        return this.resolve(path);
    }

    // Step 2: find the calendar home set
    async getCalendarHome(principalUrl) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <A:prop><C:calendar-home-set/></A:prop>
</A:propfind>`;
        const res = await this.req('PROPFIND', principalUrl, xml, { Depth: '0' });
        const path = this.extractHref(res.text, 'calendar-home-set');
        if (!path) throw new Error('iCloud CalDAV: could not resolve calendar home set');
        return this.resolve(path);
    }

    // Step 3: find the URL of a calendar by display name
    async findCalendar(homeUrl, calendarName) {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<A:propfind xmlns:A="DAV:">
  <A:prop><A:displayname/></A:prop>
</A:propfind>`;
        const res = await this.req('PROPFIND', homeUrl, xml, { Depth: '1' });

        const responseRe = /<[^>]*:?response[^>]*>([\s\S]*?)<\/[^>]*:?response>/gi;
        let m;
        while ((m = responseRe.exec(res.text)) !== null) {
            const block = m[1];
            const nameM = block.match(/<[^>]*:?displayname[^>]*>(.*?)<\/[^>]*:?displayname>/i);
            const hrefM = block.match(/<[^>]*:?href[^>]*>(.*?)<\/[^>]*:?href>/i);
            if (nameM && nameM[1].trim() === calendarName && hrefM) {
                return this.resolve(hrefM[1].trim());
            }
        }
        throw new Error(`iCloud CalDAV: calendar "${calendarName}" not found`);
    }

    // Step 4: fetch events in a time window (server-side expand for recurrences)
    async fetchEvents(calendarUrl, start, end) {
        const fmt = d => d.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
        const s = fmt(start);
        const e = fmt(end);
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="DAV:">
  <A:prop>
    <A:getetag/>
    <C:calendar-data>
      <C:expand start="${s}" end="${e}"/>
    </C:calendar-data>
  </A:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${s}" end="${e}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
        const res = await this.req('REPORT', calendarUrl, xml, { Depth: '1' });
        return res.text;
    }
}

// ------------------------------------------------------------
// Plugin
// ------------------------------------------------------------

class OTPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'ot-create-daily',
            name: 'Create Daily Note from Calendar',
            callback: () => new CreateDailyModal(this.app, this).open(),
        });

        this.addCommand({
            id: 'ot-select-event',
            name: 'Create Meeting Note (select event)',
            callback: () => new SelectEventModal(this.app, this).open(),
        });

        this.addSettingTab(new OTSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // ---- Vault helpers ----

    async loadGeoData() {
        const file = this.app.vault.getAbstractFileByPath('geo_data.json');
        if (!file) throw new Error('geo_data.json not found in vault root');
        return JSON.parse(await this.app.vault.read(file));
    }

    async saveGeoData(geo) {
        const file = this.app.vault.getAbstractFileByPath('geo_data.json');
        await this.app.vault.modify(file, JSON.stringify(geo, null, 4));
    }

    async readTemplate(name) {
        const file = this.app.vault.getAbstractFileByPath(`template/${name}`);
        if (!file) throw new Error(`template/${name} not found`);
        return this.app.vault.read(file);
    }

    // Write a file; returns 'created' | 'overwritten' | 'skipped'
    async writeFile(path, content, overwrite) {
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing) {
            if (overwrite) {
                await this.app.vault.modify(existing, content);
                return 'overwritten';
            }
            return 'skipped';
        }
        const dir = path.split('/').slice(0, -1).join('/');
        if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
            await this.app.vault.createFolder(dir);
        }
        await this.app.vault.create(path, content);
        return 'created';
    }

    // ---- Core logic (mirrors Python ot script) ----

    async getWeather(dateStr, place) {
        const url =
            `https://api.open-meteo.com/v1/forecast` +
            `?latitude=${place.lat}&longitude=${place.lon}` +
            `&hourly=weather_code&daily=temperature_2m_max,temperature_2m_min` +
            `&timezone=${place.tz}&past_days=7`;
        try {
            const res  = await requestUrl({ url });
            const data = res.json;
            const i    = data.daily.time.indexOf(dateStr);
            if (i === -1) return '';

            const maxC = Math.round(data.daily.temperature_2m_max[i]);
            const minC = Math.round(data.daily.temperature_2m_min[i]);
            const maxF = Math.round(maxC * 9 / 5 + 32);
            const minF = Math.round(minC * 9 / 5 + 32);
            const icn  = h => WEATHER_ICONS[Math.round(data.hourly.weather_code[i * 24 + h])] ?? '';

            return `${maxC}°C/${minC}°C (${maxF}°F/${minF}°F) ${icn(9)}/${icn(15)}/${icn(21)}`;
        } catch (e) {
            console.warn('OT: weather fetch failed', e);
            return '';
        }
    }

    async fetchEvents(dateStr, place) {
        const { icloudUsr, icloudPwd, icloudCal } = this.settings;
        if (!icloudUsr || !icloudPwd || !icloudCal) {
            throw new Error('iCloud credentials not configured — open Settings → OT.');
        }

        const client    = new CalDAVClient('https://caldav.icloud.com/', icloudUsr, icloudPwd);
        const principal = await client.getPrincipalUrl();
        const home      = await client.getCalendarHome(principal);
        const calUrl    = await client.findCalendar(home, icloudCal);

        // Expand window by ±1 day to cover any timezone offset
        const start = new Date(`${dateStr}T00:00:00Z`);
        start.setUTCDate(start.getUTCDate() - 1);
        const end = new Date(`${dateStr}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() + 2);

        const tz      = place.tz.replace(/%2F/g, '/');
        const icalRaw = await client.fetchEvents(calUrl, start, end);

        return parseICalEvents(icalRaw, tz)
            .filter(e => e.start.dateStr === dateStr)
            .sort((a, b) => (a.start.timeStr ?? '').localeCompare(b.start.timeStr ?? ''))
            .map(e => new OTEvent(e));
    }
}

// ------------------------------------------------------------
// Modal — Create Daily Note
// ------------------------------------------------------------

class CreateDailyModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin   = plugin;
        const _d1 = new Date(); this.dateStr = `${_d1.getFullYear()}-${String(_d1.getMonth()+1).padStart(2,'0')}-${String(_d1.getDate()).padStart(2,'0')}`;
        this.placeKey = null;
        this.overwrite = false;
        this.geo      = null;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Create Daily Note from Calendar' });

        try {
            this.geo      = await this.plugin.loadGeoData();
            this.placeKey = this.geo.default;
        } catch (e) {
            contentEl.createEl('p', { text: `Error: ${e.message}` });
            return;
        }

        new Setting(contentEl)
            .setName('Date')
            .addText(t => t.setValue(this.dateStr).onChange(v => this.dateStr = v));

        new Setting(contentEl)
            .setName('Location')
            .addDropdown(dd => {
                for (const [key, loc] of Object.entries(this.geo.location)) {
                    dd.addOption(key, loc.name);
                }
                dd.setValue(this.placeKey).onChange(v => this.placeKey = v);
            });

        new Setting(contentEl)
            .setName('Overwrite existing files')
            .addToggle(t => t.setValue(false).onChange(v => this.overwrite = v));

        this.statusEl = contentEl.createEl('p', { cls: 'ot-status' });

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Create').setCta().onClick(() => this.run()))
            .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()));
    }

    async run() {
        this.statusEl.setText('Fetching calendar events…');
        try {
            // Persist new default location if changed
            if (this.placeKey !== this.geo.default) {
                this.geo.default = this.placeKey;
                await this.plugin.saveGeoData(this.geo);
            }

            const place  = this.geo.location[this.placeKey];
            const events = await this.plugin.fetchEvents(this.dateStr, place);
            this.statusEl.setText(`Found ${events.length} event(s). Fetching weather…`);

            const weather = await this.plugin.getWeather(this.dateStr, place);
            this.statusEl.setText('Creating files…');

            // Build agenda sections
            let morning = '', lunch = '', afternoon = '', evening = '';
            for (const ev of events) {
                if (!ev.validEvent) continue;
                const t    = parseInt(ev.timeStart, 10);
                const line = `\n${ev.formatEvent()}`;
                if      (t < 1200) morning   += line;
                else if (t < 1300) lunch      += line;
                else if (t < 1700) afternoon  += line;
                else               evening    += line;
            }

            // Fill daily template
            let body = await this.plugin.readTemplate('daily_template.md');
            body = body
                .replace('%WEATHER%',   weather)
                .replace('%MORNING%',   morning)
                .replace('%LUNCH%',     lunch)
                .replace('%AFTERNOON%', afternoon)
                .replace('%EVENING%',   evening);

            const dailyResult = await this.plugin.writeFile(
                `calendar/${this.dateStr}.md`, body, this.overwrite
            );

            // Create meeting notes
            const mtgTemplate = await this.plugin.readTemplate('meeting_template.md');
            let created = 0, skipped = 0;
            for (const ev of events) {
                if (!ev.mtgNote) continue;
                const path    = `${adjustFileName(ev.day, ev.name)}.md`;
                const content = ev.buildMtgNote(mtgTemplate);
                const result  = await this.plugin.writeFile(path, content, this.overwrite);
                result === 'skipped' ? skipped++ : created++;
            }

            const summary = `Daily note: ${dailyResult}. Meeting notes: ${created} created, ${skipped} skipped.`;
            this.statusEl.setText(summary);
            new Notice(`OT: ${summary}`);
            setTimeout(() => this.close(), 2000);
        } catch (e) {
            this.statusEl.setText(`Error: ${e.message}`);
            console.error('OT plugin error:', e);
        }
    }

    onClose() { this.contentEl.empty(); }
}

// ------------------------------------------------------------
// Modal — Select event to create meeting note  (-s mode)
// ------------------------------------------------------------

class SelectEventModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin   = plugin;
        const _d2 = new Date(); this.dateStr = `${_d2.getFullYear()}-${String(_d2.getMonth()+1).padStart(2,'0')}-${String(_d2.getDate()).padStart(2,'0')}`;
        this.placeKey  = null;
        this.geo       = null;
        this.overwrite = false;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Create Meeting Note — Select Event' });

        try {
            this.geo      = await this.plugin.loadGeoData();
            this.placeKey = this.geo.default;
        } catch (e) {
            contentEl.createEl('p', { text: `Error: ${e.message}` });
            return;
        }

        new Setting(contentEl)
            .setName('Date')
            .addText(t => t.setValue(this.dateStr).onChange(v => this.dateStr = v));

        new Setting(contentEl)
            .setName('Location')
            .addDropdown(dd => {
                for (const [key, loc] of Object.entries(this.geo.location)) {
                    dd.addOption(key, loc.name);
                }
                dd.setValue(this.placeKey).onChange(v => this.placeKey = v);
            });

        new Setting(contentEl)
            .setName('Overwrite existing files')
            .addToggle(t => t.setValue(this.overwrite).onChange(v => this.overwrite = v));

        this.statusEl = contentEl.createEl('p', { cls: 'ot-status' });
        this.listEl   = contentEl.createEl('div');

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Fetch Events').setCta().onClick(() => this.fetchAndShow()))
            .addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()));
    }

    async fetchAndShow() {
        this.statusEl.setText('Fetching events…');
        this.listEl.empty();
        try {
            const place  = this.geo.location[this.placeKey];
            const events = (await this.plugin.fetchEvents(this.dateStr, place))
                .filter(ev => ev.validEvent);

            if (events.length === 0) {
                this.statusEl.setText('No valid events found.');
                return;
            }

            this.statusEl.setText('Click a button to create that meeting note:');

            for (const ev of events) {
                new Setting(this.listEl)
                    .setName(`${formatTime(ev.timeStart)}–${formatTime(ev.timeEnd)}  ${ev.name}`)
                    .addButton(btn => btn
                        .setButtonText(ev.mtgNote ? 'Create Note' : '(no note)')
                        .setDisabled(!ev.mtgNote)
                        .onClick(async () => {
                            try {
                                const template = await this.plugin.readTemplate('meeting_template.md');
                                const path     = `${adjustFileName(ev.day, ev.name)}.md`;
                                const content  = ev.buildMtgNote(template);
                                const result   = await this.plugin.writeFile(path, content, this.overwrite);
                                new Notice(`OT: ${path} — ${result}`);
                                this.statusEl.setText(`${path} — ${result}`);
                            } catch (e) {
                                this.statusEl.setText(`Error: ${e.message}`);
                            }
                        })
                    );
            }
        } catch (e) {
            this.statusEl.setText(`Error: ${e.message}`);
            console.error('OT plugin error:', e);
        }
    }

    onClose() { this.contentEl.empty(); }
}

// ------------------------------------------------------------
// Settings tab
// ------------------------------------------------------------

class OTSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'OT Settings' });

        new Setting(containerEl)
            .setName('iCloud Username')
            .setDesc('Your iCloud email address')
            .addText(t => t
                .setPlaceholder('user@icloud.com')
                .setValue(this.plugin.settings.icloudUsr)
                .onChange(async v => {
                    this.plugin.settings.icloudUsr = v;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('iCloud App-Specific Password')
            .setDesc('Generate at appleid.apple.com → Sign-In & Security → App-Specific Passwords')
            .addText(t => {
                t.inputEl.type = 'password';
                t.setValue(this.plugin.settings.icloudPwd)
                    .onChange(async v => {
                        this.plugin.settings.icloudPwd = v;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('Calendar Name')
            .setDesc('Exact display name of the iCloud calendar to use (e.g. "Kuni Higashi")')
            .addText(t => t
                .setValue(this.plugin.settings.icloudCal)
                .onChange(async v => {
                    this.plugin.settings.icloudCal = v;
                    await this.plugin.saveSettings();
                })
            );
    }
}

module.exports = OTPlugin;
