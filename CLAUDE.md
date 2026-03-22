# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is an Obsidian desktop-only plugin (`obsidian-ot`) that creates daily notes and meeting notes from Apple iCloud Calendar (iCloud CalDAV) events. It is a single-file JavaScript plugin with no build step.

## Development

There is no build system — `main.js` is loaded directly by Obsidian. To test changes, install the plugin in an Obsidian vault (copy `main.js` and `manifest.json` to `.obsidian/plugins/obsidian-ot/`) and reload the plugin.

No package manager, no TypeScript compilation, no linting setup.

## Architecture

Everything lives in `main.js` (single file, ~750 lines). Key sections in order:

1. **Constants & helpers** — `DEFAULT_SETTINGS`, weather icon map, iCal parsing utilities (`unfoldLines`, `getProp`, `parseICalDt`, `localToUtcMs`)
2. **`parseICalEvents()`** — Converts raw iCal text into plain event objects
3. **`OTEvent` class** — Wraps a raw event, decodes the name convention (see below), generates agenda lines and meeting note content
4. **`CalDAVClient` class** — WebDAV/CalDAV client for iCloud; discovers principal URL → calendar home → named calendar → fetches events
5. **`OTPlugin` class** — Main Obsidian plugin; registers two commands, handles vault I/O, fetches weather from Open-Meteo
6. **`CreateDailyModal`** — Modal UI for creating a daily note; reads `template/daily_template.md`, substitutes `%WEATHER%`, `%MORNING%`, `%LUNCH%`, `%AFTERNOON%`, `%EVENING%`
7. **`SelectEventModal`** — Modal UI for creating a single meeting note for a chosen event
8. **`OTSettingTab`** — Plugin settings (iCloud username, app-specific password, calendar name)

## Event Name Convention

Calendar event titles control how they appear in notes:

| Title format | Behavior |
|---|---|
| `(name)` | Skipped entirely |
| `[name]` | Shown with wiki link; meeting note created |
| `<name>` | Shown as plain text; no meeting note |
| `plain name` | Default behavior |

All-day events are skipped automatically.

## Vault Files Required (not in repo)

The plugin expects these files to exist in the user's Obsidian vault:
- `geo_data.json` — Array of location objects with `name`, `lat`, `lon`, `timezone` fields
- `template/daily_template.md` — Daily note template with `%WEATHER%`, `%MORNING%`, `%LUNCH%`, `%AFTERNOON%`, `%EVENING%` placeholders
- `template/meeting_template.md` — Meeting note template

Daily notes are written to `calendar/{YYYY-MM-DD}.md`. Meeting notes go to a path derived from the event name.

## External APIs

- **iCloud CalDAV**: `caldav.icloud.com` — authenticated with iCloud username + app-specific password (Basic auth, Base64)
- **Open-Meteo**: Weather data fetched by lat/lon from `geo_data.json`
