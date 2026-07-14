# Irrigation Schedule Card

A Lovelace card for **weekly irrigation scheduling with rain smarts**. Give each zone the days it should run, a start time and a run duration; the card writes those to a native Home Assistant `schedule` helper per zone. All the countdown, skip and stop logic lives **server-side** in Home Assistant — the card is a viewer/editor, so closing the app never breaks a schedule.

It is the companion to [manual-irrigation-zone-card](https://github.com/mycrouch/manual-irrigation-zone-card): the manual card handles ad-hoc runs, this one handles the weekly programme. Both share the same timers and safety automations, so manual and scheduled runs use one reliability model.

<p align="center">
  <img src="images/wide.png" alt="Irrigation Schedule Card — wide layout with a populated schedule" width="540">
  &nbsp;
  <img src="images/narrow.png" alt="Irrigation Schedule Card — narrow layout showing an active rain skip" width="300">
</p>

## Features

- **Per-zone weekly schedule.** Day-of-week chips (M T W T F S S), a start time and a run duration for each of up to 8 zones, plus an enable toggle per zone and a global enable. Editing writes straight to a native `schedule` helper via the schedule WebSocket API — the block length is the run duration.
- **Rain intelligence.** A live precipitation-rate sensor stops watering mid-run when it rains hard; a rolling 48-hour rainfall figure skips a scheduled run when the ground is already wet.
- **Rain-delay and skip controls.** One-tap 24 h / 48 h / 72 h rain delays with a clear button, plus a "Skip next run" button that self-clears after one cycle.
- **Clear status strip.** Shows the next scheduled run (zone + day/time), the zone currently running with time remaining, and the active skip reason when one applies — *"Rain delay until Thu 6:00"*, *"Rain skip — 14.0 mm in last 48 h"*.
- **Fail-safe by design.** If the rain data is missing or stale, the schedule **runs anyway** and the card shows a warning — watering is never silently skipped.
- **One-click server-side setup.** The GUI editor creates every helper and automation it needs (schedule + timer + enable per zone, the control helpers, the daily rainfall utility meter + 48 h template sensor, and the dispatcher / rain-stop / safety automations). No YAML editing required.
- **GUI editor** with a device picker to filter the zone entity pickers, rain-sensor and threshold pickers, and a per-card style option (default / theme / manual gradient).

## How it works

The card never runs a timer in the browser. Setup creates:

1. **A `schedule` helper per zone** (`schedule.irrigation_zone_N_schedule`). The card edits its weekly blocks; a block's length is the zone's run duration.
2. **A dispatcher automation** — when a zone's schedule block starts, it starts that zone's `timer` (duration = block length) and turns the zone switch on, *unless* a skip condition is active (global/zone disabled, zone already running, skip-next armed, rain delay active, or 48 h rainfall at/above the threshold).
3. **A rain-stop automation** — if the live precipitation rate stays above the rain-stop threshold for 5 minutes while any zone is on, it turns every zone off and cancels the timers.
4. **Shared safety automations** — turn a zone off when its timer ends, and cancel a zone's timer if the zone is switched off elsewhere. These are shared with `manual-irrigation-zone-card`.
5. **A daily rainfall utility meter + a 48 h template sensor** — the utility meter tracks today's rain from your "precipitation today" sensor; the template sensor sums today + yesterday for the rolling 48 h figure used by the skip logic.

## Installation

### HACS (recommended)

1. HACS → three-dot menu → **Custom repositories**.
2. Add `https://github.com/mycrouch/irrigation-schedule-card` with category **Lovelace**.
3. Install **Irrigation Schedule Card**, then hard-refresh the browser (Cmd/Ctrl + Shift + R).

### Manual

1. Copy `irrigation-schedule-card.js` to `/config/www/`.
2. Add the resource: Settings → Dashboards → three-dot menu → Resources → Add, URL `/local/irrigation-schedule-card.js`, type **JavaScript Module**.

## Configuration

Add the card from the dashboard's card picker ("Irrigation Schedule Card") and use the **GUI editor** — it is the intended way to configure this card:

1. Pick your irrigation device (optional — it filters the zone entity pickers).
2. Add a zone and choose its switch/valve entity. Repeat for each zone.
3. Choose your rain sensors under **Rain sensors & thresholds** (precipitation rate and precipitation today).
4. Click **⚙ Set up schedule helpers** (admin user required). The card creates every helper and automation and fills the config in for you.
5. On the card face, set each zone's days, start time and duration, then enable the zones you want.

### YAML example

```yaml
type: custom:irrigation-schedule-card
title: Holman Watering System
style: default
global_enable: input_boolean.irrigation_schedule_enabled
skip_next: input_boolean.irrigation_skip_next
rain_delay: input_datetime.irrigation_rain_delay_until
rain_rate_sensor: sensor.ibrisb3665_precipitation_rate
rain_today_sensor: sensor.ibrisb3665_precipitation_today
rain_48h_sensor: sensor.irrigation_rain_48h
rain_stop_number: input_number.irrigation_rain_stop_rate
skip_48h_number: input_number.irrigation_skip_rain_48h
zones:
  - entity: switch.irrigation_zone_1_front_lawn
    schedule: schedule.irrigation_zone_1_schedule
    timer: timer.irrigation_zone_1
    enable: input_boolean.irrigation_zone_1_schedule_enabled
    name: Front Lawn
    default_minutes: 15
  - entity: switch.irrigation_zone_2_front_weepers
    schedule: schedule.irrigation_zone_2_schedule
    timer: timer.irrigation_zone_2
    enable: input_boolean.irrigation_zone_2_schedule_enabled
    name: Front Weepers
    default_minutes: 15
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `title` | string | `Irrigation Schedule` | Card title. |
| `style` | string | `default` | `default` (theme-native), `theme` (apply an installed theme to this card), or `manual` (custom gradient). |
| `theme` | string | — | Installed theme name, when `style: theme`. |
| `color_from` / `color_to` | hex | `#0f2f4a` / `#039be5` | Gradient colours, when `style: manual`. |
| `device` | string | — | Irrigation device id — filters the zone entity pickers in the editor. |
| `global_enable` | entity | — | `input_boolean` master switch for the whole schedule. |
| `skip_next` | entity | — | `input_boolean` that skips the next scheduled run (self-clears). |
| `rain_delay` | entity | — | `input_datetime` holding the "delay until" time. |
| `rain_rate_sensor` | entity | — | Live precipitation-rate sensor (mm/h) used for rain-stop. |
| `rain_today_sensor` | entity | — | Precipitation-today sensor (mm) — source for the utility meter. |
| `rain_48h_sensor` | entity | — | 48 h rainfall sensor (mm) used for the skip check. |
| `rain_stop_number` | entity | — | `input_number` rain-stop threshold (mm/h, default 4). |
| `skip_48h_number` | entity | — | `input_number` 48 h skip threshold (mm, default 10). |
| `zones[]` | list | `[]` | Up to 8 zones (see below). |

Per zone:

| Option | Type | Default | Description |
|---|---|---|---|
| `entity` | entity | — | Zone switch / valve (required). |
| `schedule` | entity | — | The zone's `schedule` helper. |
| `timer` | entity | — | The zone's `timer` helper. |
| `enable` | entity | — | `input_boolean` enabling this zone's schedule. |
| `name` | string | friendly name | Display name. |
| `icon` | string | `mdi:sprinkler-variant` | Zone icon. |
| `default_minutes` | number | `15` | Default run duration for a new schedule. |

## Notes & caveats

- **Admin required** for one-click setup — it creates helpers and automations through Home Assistant's config API.
- Schedule blocks do not cross midnight; a run that would spill past 23:59 is clamped.
- The rain sensors are only as reliable as their source. If yours is cloud-sourced (e.g. Weather Underground) it can go stale — that is exactly why this card fails safe and keeps watering, with a warning, when the data is missing.

## Related projects

| Project | What it does |
|---|---|
| [manual-irrigation-zone-card](https://github.com/mycrouch/manual-irrigation-zone-card) | Companion card for ad-hoc zone runs — together or in sequence, with live countdowns. |
| [airtouch-card](https://github.com/mycrouch/airtouch-card) | Console-style AirTouch 4/5 climate card. |
| [gradient-themes](https://github.com/mycrouch/gradient-themes) | 40 gradient dashboard themes sharing this card's palette. |
| [ecovacs-vacuum-card](https://github.com/mycrouch/ecovacs-vacuum-card) | Ecovacs robot vacuum card with a per-card theme picker. |

## License

MIT © Jason Crouch. Icons are [Material Design Icons](https://pictogrammers.com/library/mdi/) (Apache 2.0).
