/**
 * Irrigation Schedule Card v0.2.0
 * https://github.com/mycrouch/irrigation-schedule-card
 * ----------------------------------------------------------------
 * A Lovelace card for weekly irrigation scheduling with rain smarts.
 *
 *  - Per-zone scheduling, front and centre: every zone is a self-contained,
 *    collapsible schedule editor. A collapsed row shows a plain-language
 *    summary ("3× a week — Mon, Wed, Fri at 5:30 am for 15 min" / "Off");
 *    tap to expand and set seven independent day chips (M T W T F S S),
 *    a start time, a run duration and the zone's enable toggle. Different
 *    zones on different days/times/durations is trivially obvious.
 *    Editing writes to a native HA `schedule` helper per zone via the
 *    schedule WebSocket API, and existing blocks are read back into the
 *    chips/time/minutes. A schedule the simple model can't represent
 *    (several different times in one day) is shown as a "Custom schedule"
 *    and is never overwritten unless the user edits it.
 *  - Plain-language rain status: the rain area reads as a sentence, e.g.
 *    "No recent rain (0 mm in last 48 h) — schedules will run",
 *    "14 mm in last 48 h — next runs will be skipped",
 *    "Raining hard (6 mm/h) — active zones stopped".
 *  - Rain controls: 24 h / 48 h / 72 h rain-delay buttons + clear, and
 *    a "Skip next run" button.
 *  - Missing helpers are offered a one-tap "Create" (admin) instead of a
 *    bare error, and the GUI editor's one-click "Set up schedule helpers"
 *    is idempotent — re-running fills gaps and never duplicates. It creates
 *    the per-zone schedule + timer + enable helpers, the control helpers,
 *    the daily rainfall utility meter + 48 h template sensor, and the
 *    dispatcher, rain-stop and safety automations — all server-side.
 *
 * Reliability model (all countdown / skip / stop logic lives in HA):
 *  - A dispatcher automation starts each zone's timer + switch when its
 *    schedule block begins, unless a skip condition is active.
 *  - Shared safety automations turn zones off when their timer ends, so
 *    manual and scheduled runs use one reliability model.
 *  - If rain data is unavailable or stale the schedule RUNS anyway and
 *    the card surfaces a warning — watering is never silently skipped.
 *  - The card is a viewer/editor only. Closing the app never breaks a
 *    schedule; everything runs server-side.
 */

(() => {
  "use strict";

  const CARD_TAG = "irrigation-schedule-card";
  const EDITOR_TAG = "irrigation-schedule-card-editor";
  const VERSION = "0.2.0";

  const MAX_ZONES = 8;
  const DEFAULT_MINUTES = 15;
  const DEFAULT_START = "05:00";
  const DEFAULT_ICON = "mdi:sprinkler-variant";
  const DEFAULT_RAIN_STOP = 4; // mm/h
  const DEFAULT_SKIP_48H = 10; // mm
  const STALE_HOURS = 6; // rain data older than this is treated as stale

  // Monday-first, matching Home Assistant's schedule week.
  const DAYS = [
    { key: "monday", short: "M", label: "Mon" },
    { key: "tuesday", short: "T", label: "Tue" },
    { key: "wednesday", short: "W", label: "Wed" },
    { key: "thursday", short: "T", label: "Thu" },
    { key: "friday", short: "F", label: "Fri" },
    { key: "saturday", short: "S", label: "Sat" },
    { key: "sunday", short: "S", label: "Sun" },
  ];

  /* ---------------------------------------------------------- helpers */

  const fmtClock = (secs) => {
    secs = Math.max(0, Math.round(secs));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  };

  const isOn = (stateObj) =>
    !!stateObj && ["on", "open", "running", "active"].includes(stateObj.state);

  const isUsable = (stateObj) =>
    !!stateObj &&
    stateObj.state !== "unavailable" &&
    stateObj.state !== "unknown" &&
    stateObj.state !== "" &&
    stateObj.state !== undefined;

  const durationToSecs = (d) => {
    if (!d) return null;
    const parts = String(d).split(":").map(Number);
    if (parts.some(Number.isNaN)) return null;
    return parts.reduce((acc, v) => acc * 60 + v, 0);
  };

  const pad2 = (n) => String(n).padStart(2, "0");

  // "05:00" or "05:00:00" -> minutes since midnight
  const timeToMin = (t) => {
    if (!t) return null;
    const p = String(t).split(":").map(Number);
    if (p.length < 2 || p.some(Number.isNaN)) return null;
    return p[0] * 60 + p[1];
  };

  const minToTime = (m) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;

  // "05:30" / "17:00" -> "5:30 am" / "5:00 pm" (Australian English)
  const fmt12 = (t) => {
    const m = timeToMin(t);
    if (m == null) return t || "";
    const h24 = Math.floor(m / 60) % 24;
    const mm = m % 60;
    const ap = h24 < 12 ? "am" : "pm";
    let h = h24 % 12;
    if (h === 0) h = 12;
    return `${h}:${pad2(mm)} ${ap}`;
  };

  // Turn an object_id back into a human name whose slug round-trips to it.
  // "irrigation_skip_next_run" -> "Irrigation Skip Next Run"
  const titleize = (objectId) =>
    String(objectId || "")
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

  // Ordered short day labels ("Mon, Wed, Fri") for a set of day indices.
  const daysList = (daySet) =>
    DAYS.filter((_, idx) => daySet.has(idx))
      .map((d) => d.label)
      .join(", ");

  // slug used when deriving an expected object_id from a helper name.
  const slugify = (text) =>
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

  const fireEvent = (node, type, detail) =>
    node.dispatchEvent(
      new CustomEvent(type, { detail, bubbles: true, composed: true })
    );

  const objectId = (entityId) => (entityId || "").split(".").slice(1).join(".");

  // linear RGB interpolation, per the shared palette helper
  const mixHex = (a, b, t) => {
    const pa = a.replace("#", "");
    const pb = b.replace("#", "");
    const ai = [0, 2, 4].map((i) => parseInt(pa.substr(i, 2), 16));
    const bi = [0, 2, 4].map((i) => parseInt(pb.substr(i, 2), 16));
    const ci = ai.map((v, i) => Math.round(v + (bi[i] - v) * t));
    return "#" + ci.map((v) => pad2(v.toString(16))).join("");
  };

  /* ============================================================ CARD */

  class IrrigationScheduleCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._schedules = {}; // schedule entity_id -> {days:Set, start, minutes, custom, summary}
      this._loadedSchedules = false;
      this._loadingSchedules = false;
      this._tick = null;
      this._stateKey = "";
      this._appliedThemeProps = [];
      this._expanded = new Set(); // zone indices currently expanded
      this._creating = new Set(); // entity ids mid-create
    }

    static getConfigElement() {
      return document.createElement(EDITOR_TAG);
    }

    static getStubConfig() {
      return {
        title: "Irrigation Schedule",
        global_enable: "input_boolean.irrigation_schedule_enabled",
        skip_next: "input_boolean.irrigation_skip_next_run",
        rain_delay: "input_datetime.irrigation_rain_delay_until",
        zones: [],
      };
    }

    setConfig(config) {
      if (!config || !Array.isArray(config.zones)) {
        throw new Error(`${CARD_TAG}: 'zones' must be a list`);
      }
      if (config.zones.length > MAX_ZONES) {
        throw new Error(`${CARD_TAG}: maximum ${MAX_ZONES} zones`);
      }
      this._config = config;
      this._loadedSchedules = false;
      this._stateKey = "";
      this._render();
    }

    set hass(hass) {
      const prev = this._hass;
      this._hass = hass;
      if (!this._loadedSchedules && !this._loadingSchedules) {
        this._loadSchedules();
      }
      // Cheap re-render guard: only rebuild when a watched state changed.
      const key = this._computeStateKey();
      if (key !== this._stateKey || !prev) {
        this._stateKey = key;
        // Don't yank the DOM out from under an active edit (time input etc.).
        const active = this.shadowRoot && this.shadowRoot.activeElement;
        if (active && active.tagName === "INPUT") return;
        this._render();
      }
    }

    _isAdmin() {
      return !!this._hass?.user?.is_admin;
    }

    getCardSize() {
      return 3 + (this._config?.zones?.length || 0);
    }

    disconnectedCallback() {
      if (this._tick) {
        clearInterval(this._tick);
        this._tick = null;
      }
    }

    /* ------------------------------------------------ watched state */

    _watchedEntities() {
      const c = this._config || {};
      const ids = [];
      (c.zones || []).forEach((z) => {
        if (z.entity) ids.push(z.entity);
        if (z.timer) ids.push(z.timer);
        if (z.schedule) ids.push(z.schedule);
        if (z.enable) ids.push(z.enable);
      });
      [
        c.global_enable,
        c.skip_next,
        c.rain_delay,
        c.rain_rate_sensor,
        c.rain_today_sensor,
        c.rain_48h_sensor,
        c.rain_stop_number,
        c.skip_48h_number,
      ].forEach((e) => e && ids.push(e));
      return ids;
    }

    _computeStateKey() {
      if (!this._hass) return "";
      return this._watchedEntities()
        .map((id) => {
          const s = this._hass.states[id];
          if (!s) return `${id}:∅`;
          return `${id}:${s.state}:${s.last_changed}:${
            s.attributes?.next_event || ""
          }`;
        })
        .join("|");
    }

    /* ------------------------------------------------ schedules */

    async _loadSchedules() {
      if (!this._hass || this._loadingSchedules) return;
      this._loadingSchedules = true;
      try {
        const list = await this._hass.callWS({ type: "schedule/list" });
        const byId = {};
        (list || []).forEach((s) => (byId[s.id] = s));
        (this._config.zones || []).forEach((z) => {
          if (!z.schedule) return;
          const cfg = byId[objectId(z.schedule)];
          this._schedules[z.schedule] = this._parseSchedule(cfg);
        });
        this._loadedSchedules = true;
      } catch (e) {
        // schedule/list unavailable — fall back to empty schedules
        this._loadedSchedules = true;
      } finally {
        this._loadingSchedules = false;
        this._stateKey = "";
        this._render();
      }
    }

    // Reduce a schedule helper config to {days:Set, start, minutes, custom}.
    // A schedule the simple model can't represent — more than one block in a
    // day, or different times on different days — is flagged `custom` so the
    // card shows it faithfully and never flattens it on an unrelated re-render.
    _parseSchedule(cfg) {
      const out = { days: new Set(), start: null, minutes: null, custom: false };
      if (!cfg) return out;
      let firstFrom = null;
      let firstTo = null;
      DAYS.forEach((d, idx) => {
        const blocks = cfg[d.key] || [];
        if (!blocks.length) return;
        out.days.add(idx);
        if (blocks.length > 1) out.custom = true;
        const from = timeToMin(blocks[0].from);
        const to = timeToMin(blocks[0].to);
        if (out.start == null && from != null) {
          out.start = minToTime(from);
          firstFrom = from;
          if (to != null) {
            firstTo = to;
            out.minutes = Math.max(1, (to > from ? to : to + 1440) - from);
          }
        } else {
          // subsequent day — must match the first block to stay "simple"
          if (from !== firstFrom || to !== firstTo) out.custom = true;
        }
      });
      if (out.custom) out.summary = this._customSummary(cfg);
      return out;
    }

    // Faithful plain-language description of an arbitrary schedule config.
    _customSummary(cfg) {
      const parts = [];
      DAYS.forEach((d) => {
        const blocks = cfg[d.key] || [];
        blocks.forEach((b) => {
          const f = timeToMin(b.from);
          const t = timeToMin(b.to);
          const mins = f != null && t != null ? Math.max(1, (t > f ? t : t + 1440) - f) : null;
          parts.push(`${d.label} ${fmt12(b.from)}${mins != null ? ` (${mins} min)` : ""}`);
        });
      });
      return parts.join(" · ");
    }

    _sched(zone) {
      const cur = this._schedules[zone.schedule] || {
        days: new Set(),
        start: null,
        minutes: null,
      };
      return {
        days: cur.days || new Set(),
        start: cur.start || DEFAULT_START,
        minutes: cur.minutes || zone.default_minutes || DEFAULT_MINUTES,
        custom: !!cur.custom,
        summary: cur.summary || "",
      };
    }

    async _writeSchedule(zone, days, start, minutes) {
      // optimistic local update
      this._schedules[zone.schedule] = {
        days: new Set(days),
        start,
        minutes,
      };
      this._stateKey = "";
      this._render();

      if (!zone.schedule || !this._hass) return;
      const startMin = timeToMin(start);
      let endMin = startMin + minutes;
      if (endMin >= 1440) endMin = 1439; // clamp, no cross-midnight blocks
      const from = `${minToTime(startMin)}:00`;
      const to = `${minToTime(endMin)}:00`;
      const payload = { type: "schedule/update", schedule_id: objectId(zone.schedule) };
      DAYS.forEach((d, idx) => {
        payload[d.key] = days.has(idx) ? [{ from, to }] : [];
      });
      try {
        await this._hass.callWS(payload);
      } catch (e) {
        console.error(`${CARD_TAG}: schedule update failed`, e);
      }
    }

    _toggleDay(zone, idx) {
      const s = this._sched(zone);
      const days = new Set(s.days);
      days.has(idx) ? days.delete(idx) : days.add(idx);
      this._writeSchedule(zone, days, s.start, s.minutes);
    }

    _setStart(zone, start) {
      const s = this._sched(zone);
      this._writeSchedule(zone, s.days, start, s.minutes);
    }

    _bumpMinutes(zone, delta) {
      const s = this._sched(zone);
      const step = s.minutes >= 10 ? 5 : 1;
      const minutes = Math.min(180, Math.max(1, s.minutes + delta * step));
      this._writeSchedule(zone, s.days, s.start, minutes);
    }

    /* ------------------------------------------------ control actions */

    _toggle(entity) {
      if (!entity || !this._hass) return;
      this._hass.callService("input_boolean", "toggle", { entity_id: entity });
    }

    _setDelayHours(hours) {
      const c = this._config;
      if (!c.rain_delay || !this._hass) return;
      const dt = new Date(Date.now() + hours * 3600 * 1000);
      const val = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(
        dt.getDate()
      )} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
      this._hass.callService("input_datetime", "set_datetime", {
        entity_id: c.rain_delay,
        datetime: val,
      });
    }

    _clearDelay() {
      const c = this._config;
      if (!c.rain_delay || !this._hass) return;
      const dt = new Date(Date.now() - 60000);
      const val = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(
        dt.getDate()
      )} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
      this._hass.callService("input_datetime", "set_datetime", {
        entity_id: c.rain_delay,
        datetime: val,
      });
    }

    _toggleExpand(idx) {
      this._expanded.has(idx)
        ? this._expanded.delete(idx)
        : this._expanded.add(idx);
      this._render();
    }

    // One-tap create for a configured helper that's missing from hass.states.
    // Uses the same WebSocket config APIs as the editor's one-click setup, and
    // names the helper so its object_id round-trips to the configured id — so
    // the existing card config resolves it with no further edits. Admin only.
    async _createMissing(entityId) {
      if (!entityId || !this._hass || this._creating.has(entityId)) return;
      const domain = entityId.split(".")[0];
      const oid = objectId(entityId);
      const name = titleize(oid);
      const creatable = {
        input_boolean: { type: "input_boolean/create", payload: { name, icon: "mdi:calendar-check" } },
        input_datetime: {
          type: "input_datetime/create",
          payload: { name, has_date: true, has_time: true, icon: "mdi:weather-pouring" },
        },
        input_number: {
          type: "input_number/create",
          payload: { name, min: 0, max: 100, step: 0.5, initial: 0, mode: "box" },
        },
        timer: { type: "timer/create", payload: { name, icon: DEFAULT_ICON, restore: true } },
        schedule: { type: "schedule/create", payload: { name, icon: "mdi:calendar-clock" } },
      }[domain];
      if (!creatable) return; // sensors etc. can't be created here
      this._creating.add(entityId);
      this._render();
      try {
        await this._hass.callWS({ type: creatable.type, ...creatable.payload });
        // force schedules + state to re-read
        this._loadedSchedules = false;
        this._stateKey = "";
      } catch (e) {
        console.error(`${CARD_TAG}: create ${entityId} failed`, e);
      } finally {
        this._creating.delete(entityId);
        this._render();
      }
    }

    /* ------------------------------------------------ derived status */

    _num(entity, fallback) {
      const s = this._hass?.states?.[entity];
      if (!isUsable(s)) return fallback;
      const v = parseFloat(s.state);
      return Number.isNaN(v) ? fallback : v;
    }

    _rainStopThreshold() {
      const c = this._config;
      if (c.rain_stop_number) return this._num(c.rain_stop_number, c.rain_stop_threshold ?? DEFAULT_RAIN_STOP);
      return c.rain_stop_threshold ?? DEFAULT_RAIN_STOP;
    }

    _skip48hThreshold() {
      const c = this._config;
      if (c.skip_48h_number) return this._num(c.skip_48h_number, c.skip_48h_threshold ?? DEFAULT_SKIP_48H);
      return c.skip_48h_threshold ?? DEFAULT_SKIP_48H;
    }

    _delayUntil() {
      const c = this._config;
      const s = c.rain_delay && this._hass?.states?.[c.rain_delay];
      if (!isUsable(s)) return null;
      const ts = s.attributes?.timestamp;
      if (ts == null) return null;
      const ms = ts * 1000;
      return ms > Date.now() ? new Date(ms) : null;
    }

    _rain48() {
      const c = this._config;
      if (!c.rain_48h_sensor) return { value: null, stale: false, missing: true };
      const s = this._hass?.states?.[c.rain_48h_sensor];
      if (!isUsable(s)) return { value: null, stale: true, missing: false };
      const v = parseFloat(s.state);
      const age = (Date.now() - new Date(s.last_updated || s.last_changed).getTime()) / 3600000;
      return { value: Number.isNaN(v) ? null : v, stale: age > STALE_HOURS, missing: false };
    }

    _rainDataStale() {
      const c = this._config;
      const check = (id) => {
        if (!id) return false;
        const s = this._hass?.states?.[id];
        if (!isUsable(s)) return true;
        const age = (Date.now() - new Date(s.last_updated || s.last_changed).getTime()) / 3600000;
        return age > STALE_HOURS;
      };
      // Only warn when the user has configured rain sensors at all.
      if (!c.rain_rate_sensor && !c.rain_48h_sensor) return false;
      return check(c.rain_rate_sensor) || check(c.rain_48h_sensor);
    }

    _dayLabel(date) {
      const today = new Date();
      const sameDay = date.toDateString() === today.toDateString();
      const tomorrow = new Date(today.getTime() + 86400000);
      const isTomorrow = date.toDateString() === tomorrow.toDateString();
      const t = `${date.getHours()}:${pad2(date.getMinutes())}`;
      if (sameDay) return `today ${t}`;
      if (isTomorrow) return `tomorrow ${t}`;
      return `${DAYS[(date.getDay() + 6) % 7].label} ${t}`;
    }

    _nextRun(infos) {
      let best = null;
      infos.forEach((i) => {
        const s = this._hass?.states?.[i.zone.schedule];
        if (!s || i.enabled === false) return;
        const ne = s.attributes?.next_event;
        if (!ne) return;
        const when = new Date(ne);
        // next_event when the schedule is off is the next block start
        if (s.state === "on") return; // currently in a block; running handled elsewhere
        if (when.getTime() <= Date.now()) return;
        if (!best || when < best.when) best = { when, name: i.name };
      });
      return best;
    }

    /* ------------------------------------------------ zone info */

    _zoneInfo(zone, idx) {
      const st = this._hass?.states?.[zone.entity];
      const running = isOn(st);
      const enSt = zone.enable ? this._hass?.states?.[zone.enable] : null;
      const enableMissing = !!zone.enable && !enSt;
      // A missing enable helper counts as "enabled" so the schedule still
      // shows; the missing helper is surfaced with a Create affordance.
      const enabled = zone.enable && enSt ? isOn(enSt) : true;
      const info = {
        idx,
        zone,
        running,
        missing: !st,
        enabled,
        enableMissing,
        name:
          zone.name ||
          st?.attributes?.friendly_name ||
          zone.entity ||
          `Zone ${idx + 1}`,
        icon: zone.icon || st?.attributes?.icon || DEFAULT_ICON,
        remaining: null,
        total: null,
        elapsed: null,
      };
      if (running) {
        info.elapsed = (Date.now() - new Date(st.last_changed).getTime()) / 1000;
        const timerSt = zone.timer ? this._hass.states[zone.timer] : null;
        if (timerSt?.state === "active" && timerSt.attributes.finishes_at) {
          info.remaining =
            (new Date(timerSt.attributes.finishes_at).getTime() - Date.now()) / 1000;
          info.total = durationToSecs(timerSt.attributes.duration);
        }
        if (info.total == null && info.remaining != null) {
          info.total = info.elapsed + info.remaining;
        }
      }
      return info;
    }

    /* ------------------------------------------------ plain language */

    // The rain area as a single sentence Gavin can read at a glance.
    _rainStatus() {
      const c = this._config;
      const delayUntil = this._delayUntil();
      const rate = c.rain_rate_sensor ? this._num(c.rain_rate_sensor, null) : null;
      const rateThresh = this._rainStopThreshold();
      const r48 = this._rain48();
      const skip48 = this._skip48hThreshold();
      const anyRunning = (c.zones || []).some((z) =>
        isOn(this._hass.states[z.entity])
      );
      const stale = this._rainDataStale();
      const mm = (v) => (v % 1 ? v.toFixed(1) : v.toFixed(0));

      if (rate != null && rateThresh != null && rate >= rateThresh) {
        return {
          icon: "mdi:weather-pouring",
          cls: "warn",
          text: anyRunning
            ? `Raining hard (${mm(rate)} mm/h) — active zones stopped.`
            : `Raining hard (${mm(rate)} mm/h) — scheduled runs paused.`,
        };
      }
      if (delayUntil) {
        return {
          icon: "mdi:weather-pouring",
          cls: "warn",
          text: `Rain delay until ${this._dayLabel(delayUntil)} — scheduled runs paused.`,
        };
      }
      if (!c.rain_rate_sensor && !c.rain_48h_sensor) return null;
      if (stale) {
        return {
          icon: "mdi:cloud-alert",
          cls: "warn",
          text: "Rain data unavailable or stale — schedules will run anyway (fail-safe).",
        };
      }
      if (r48.value != null && skip48 != null && r48.value >= skip48) {
        return {
          icon: "mdi:weather-rainy",
          cls: "warn",
          text: `${mm(r48.value)} mm in last 48 h — next scheduled runs will be skipped.`,
        };
      }
      const v = r48.value != null ? r48.value : 0;
      return {
        icon: "mdi:weather-partly-cloudy",
        cls: "ok",
        text: `No recent rain (${mm(v)} mm in last 48 h) — schedules will run.`,
      };
    }

    // Plain-language one-line summary of a zone's schedule.
    _zoneSummary(info, s) {
      if (info.running) {
        return info.remaining != null
          ? `Running now · ${fmtClock(info.remaining)} left`
          : "Running now";
      }
      if (info.enabled === false) return "Off";
      if (s.custom) return `Custom schedule — ${s.summary}`;
      if (!s.days.size) return "Not scheduled";
      return `${s.days.size}× a week — ${daysList(s.days)} at ${fmt12(
        s.start
      )} for ${s.minutes} min`;
    }

    /* ------------------------------------------------ styling */

    _applyStyle() {
      const host = this;
      const style = this._config.style || "default";
      // clean previously applied theme props
      this._appliedThemeProps.forEach((p) => host.style.removeProperty(p));
      this._appliedThemeProps = [];
      host.classList.remove("style-manual");
      if (style === "theme") {
        const themes = this._hass?.themes?.themes || {};
        const t = themes[this._config.theme];
        if (t) {
          const dark = this._hass?.themes?.darkMode;
          const apply = (obj) => {
            Object.entries(obj || {}).forEach(([k, v]) => {
              if (k === "modes") return;
              const prop = k.startsWith("--") ? k : `--${k}`;
              host.style.setProperty(prop, v);
              this._appliedThemeProps.push(prop);
            });
          };
          apply(t);
          apply(t.modes && (dark ? t.modes.dark : t.modes.light));
        }
      } else if (style === "manual") {
        host.classList.add("style-manual");
      }
    }

    _manualVars() {
      const c = this._config;
      const from = c.color_from || "#0f2f4a";
      const to = c.color_to || "#039be5";
      return `--isc-grad-from:${from};--isc-grad-to:${to};`;
    }

    /* ------------------------------------------------ rendering */

    _render() {
      if (!this._config || !this._hass) return;
      const c = this._config;
      const zones = c.zones || [];
      const infos = zones.map((z, i) => this._zoneInfo(z, i));
      const runningCount = infos.filter((i) => i.running).length;

      // ticking only while a zone is running (for the live countdown)
      if (runningCount && !this._tick) {
        this._tick = setInterval(() => this._render(), 1000);
      } else if (!runningCount && this._tick) {
        clearInterval(this._tick);
        this._tick = null;
      }

      this._applyStyle();

      const admin = this._isAdmin();
      const globalSt = c.global_enable && this._hass.states[c.global_enable];
      const globalMissing = !!c.global_enable && !globalSt;
      const globalOn = c.global_enable ? isOn(globalSt) : true;
      const skipMissing = !!c.skip_next && !this._hass.states[c.skip_next];
      const skipNextOn = c.skip_next && isOn(this._hass.states[c.skip_next]);
      const delayUntil = this._delayUntil();

      const running = infos.find((i) => i.running);
      const next = this._nextRun(infos);
      const rain = this._rainStatus();

      // -------- schedule-centric status line (rain reads as its own sentence)
      let statusIcon = "mdi:calendar-clock";
      let statusText;
      let statusClass = "";
      if (!globalOn) {
        statusIcon = "mdi:calendar-remove";
        statusText = "Whole schedule is off";
        statusClass = "muted";
      } else if (running) {
        statusIcon = "mdi:water";
        statusText =
          running.remaining != null
            ? `${running.name} running · ${fmtClock(running.remaining)} left`
            : `${running.name} running`;
        statusClass = "active";
      } else if (skipNextOn) {
        statusIcon = "mdi:skip-next-circle-outline";
        statusText = "Next scheduled run will be skipped";
        statusClass = "warn";
      } else if (next) {
        statusText = `Next run: ${next.name} · ${this._dayLabel(next.when)}`;
      } else {
        statusIcon = "mdi:calendar-blank";
        statusText = zones.length
          ? "No upcoming runs — open a zone below and pick its days"
          : "No zones configured yet";
        statusClass = "muted";
      }

      const hostVars = c.style === "manual" ? this._manualVars() : "";

      this.shadowRoot.innerHTML = `
        <style>${IrrigationScheduleCard.styles}</style>
        <ha-card style="${hostVars}">
          <div class="header">
            <ha-icon class="header-icon" icon="mdi:sprinkler-variant"></ha-icon>
            <div class="title">${c.title || "Irrigation Schedule"}</div>
            ${
              globalMissing
                ? admin
                  ? `<button class="pill-create" data-create="${c.global_enable}" title="Create the missing master switch helper">
                       <ha-icon icon="mdi:plus"></ha-icon>Create
                     </button>`
                  : ""
                : `<button class="master ${globalOn ? "on" : ""}" id="global"
                     title="${globalOn ? "Schedule on" : "Schedule off"}">
                     <ha-icon icon="${globalOn ? "mdi:calendar-check" : "mdi:calendar-remove"}"></ha-icon>
                   </button>`
            }
          </div>

          <div class="status ${statusClass}">
            <ha-icon icon="${statusIcon}"></ha-icon>
            <span>${statusText}</span>
          </div>

          ${
            rain
              ? `<div class="rain-status ${rain.cls}">
                   <ha-icon icon="${rain.icon}"></ha-icon>
                   <span>${rain.text}</span>
                 </div>`
              : ""
          }

          <div class="zones">
            ${
              zones.length
                ? infos.map((i) => this._zoneHtml(i)).join("")
                : `<div class="empty">No zones configured — open the card editor, add your zones and run “Set up schedule helpers”.</div>`
            }
          </div>

          <div class="controls">
            <div class="rain-bar">
              <span class="rain-label"><ha-icon icon="mdi:weather-pouring"></ha-icon>Rain delay</span>
              <div class="rain-btns">
                <button class="chip-btn" data-delay="24">24 h</button>
                <button class="chip-btn" data-delay="48">48 h</button>
                <button class="chip-btn" data-delay="72">72 h</button>
                <button class="chip-btn ghost" id="clear-delay" ${delayUntil ? "" : "disabled"}>Clear</button>
              </div>
            </div>
            <div class="skip-row">
              ${
                skipMissing
                  ? admin
                    ? `<button class="skip-btn create" data-create="${c.skip_next}">
                         <ha-icon icon="mdi:plus-circle-outline"></ha-icon>
                         Create “skip next run” helper
                       </button>`
                    : `<div class="mini-note"><ha-icon icon="mdi:alert-circle-outline"></ha-icon>“Skip next run” helper missing — ask an admin to run setup.</div>`
                  : `<button class="skip-btn ${skipNextOn ? "on" : ""}" id="skip-next">
                       <ha-icon icon="mdi:skip-next-circle-outline"></ha-icon>
                       ${skipNextOn ? "Skip armed — tap to cancel" : "Skip next run"}
                     </button>`
              }
            </div>
          </div>
        </ha-card>
      `;

      this._attach(infos);
    }

    _zoneHtml(i) {
      const zone = i.zone;
      const idx = i.idx;

      // Zone switch/valve entity missing — can't auto-create a device entity.
      if (i.missing) {
        return `
          <div class="zone missing">
            <div class="icon-wrap warn"><ha-icon icon="mdi:alert-circle-outline"></ha-icon></div>
            <div class="zinfo">
              <div class="zname">${i.name}</div>
              <div class="zsub">Zone entity not found: ${zone.entity || "(none set)"}</div>
            </div>
          </div>`;
      }

      const s = this._sched(zone);
      const expanded = this._expanded.has(idx);
      const summary = this._zoneSummary(i, s);
      const admin = this._isAdmin();
      const schedMissing = !!zone.schedule && !this._hass.states[zone.schedule];
      const creatingSched = this._creating.has(zone.schedule);

      // right-hand control in the header: enable toggle, or a Create for a
      // missing enable helper.
      let headCtl = "";
      if (i.enableMissing) {
        headCtl = admin
          ? `<button class="pill-create" data-create="${zone.enable}" title="Create the missing enable helper">
               <ha-icon icon="mdi:plus"></ha-icon>Create
             </button>`
          : "";
      } else if (zone.enable) {
        headCtl = `<button class="ztoggle ${i.enabled ? "on" : ""}" data-enable="${idx}"
             title="${i.enabled ? "Zone schedule enabled" : "Zone schedule off"}">
             <ha-icon icon="${i.enabled ? "mdi:toggle-switch" : "mdi:toggle-switch-off-outline"}"></ha-icon>
           </button>`;
      }

      const chips = DAYS.map(
        (d, di) =>
          `<button class="day ${s.days.has(di) ? "on" : ""}"
             data-idx="${idx}" data-day="${di}">${d.short}</button>`
      ).join("");

      // expanded editor body
      let body = "";
      if (expanded) {
        if (schedMissing) {
          body = `
            <div class="zbody">
              <div class="mini-note">
                <ha-icon icon="mdi:calendar-alert"></ha-icon>
                Schedule helper missing (${zone.schedule}).
              </div>
              ${
                admin
                  ? `<button class="mini-create" data-create="${zone.schedule}" ${creatingSched ? "disabled" : ""}>
                       <ha-icon icon="mdi:plus-circle-outline"></ha-icon>
                       ${creatingSched ? "Creating…" : "Create schedule helper"}
                     </button>`
                  : `<div class="mini-note sub">Ask an admin to run “Set up schedule helpers”.</div>`
              }
            </div>`;
        } else {
          body = `
            <div class="zbody">
              ${
                s.custom
                  ? `<div class="mini-note">
                       <ha-icon icon="mdi:information-outline"></ha-icon>
                       This zone has a custom schedule set outside the card. Editing the days or time below replaces it with a simple weekly one.
                     </div>`
                  : ""
              }
              <div class="days">${chips}</div>
              <div class="zctl">
                <label class="time">
                  <ha-icon icon="mdi:clock-outline"></ha-icon>
                  <input type="time" value="${s.start}" data-time="${idx}" />
                </label>
                <div class="stepper" data-idx="${idx}">
                  <button class="step minus" data-idx="${idx}">−</button>
                  <span class="mins">${s.minutes} min</span>
                  <button class="step plus" data-idx="${idx}">+</button>
                </div>
              </div>
            </div>`;
        }
      }

      return `
        <div class="zone ${i.running ? "running" : ""} ${i.enabled ? "" : "disabled"} ${expanded ? "expanded" : ""}">
          <div class="zhead" data-expand="${idx}">
            <div class="icon-wrap ${i.running ? "active" : ""}">
              <ha-icon icon="${i.icon}"></ha-icon>
            </div>
            <div class="zinfo">
              <div class="zname">${i.name}</div>
              <div class="zsub ${i.running ? "running" : ""} ${s.custom ? "custom" : ""}">${summary}</div>
            </div>
            ${headCtl}
            <ha-icon class="chevron" icon="${expanded ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon>
          </div>
          ${body}
        </div>`;
    }

    _attach(infos) {
      const root = this.shadowRoot;

      root.getElementById("global")?.addEventListener("click", () =>
        this._toggle(this._config.global_enable)
      );
      root.getElementById("skip-next")?.addEventListener("click", () =>
        this._toggle(this._config.skip_next)
      );
      root.querySelectorAll("[data-delay]").forEach((b) =>
        b.addEventListener("click", () =>
          this._setDelayHours(Number(b.dataset.delay))
        )
      );
      root.getElementById("clear-delay")?.addEventListener("click", () =>
        this._clearDelay()
      );

      // one-tap create for any missing helper
      root.querySelectorAll("[data-create]").forEach((b) =>
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._createMissing(b.dataset.create);
        })
      );

      // expand / collapse a zone (ignore taps on the enable toggle / create)
      root.querySelectorAll("[data-expand]").forEach((el) =>
        el.addEventListener("click", (ev) => {
          if (ev.target.closest("[data-enable],[data-create]")) return;
          this._toggleExpand(Number(el.dataset.expand));
        })
      );

      root.querySelectorAll(".day").forEach((b) =>
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const zone = this._config.zones[Number(b.dataset.idx)];
          this._toggleDay(zone, Number(b.dataset.day));
        })
      );
      root.querySelectorAll("[data-time]").forEach((inp) => {
        inp.addEventListener("click", (ev) => ev.stopPropagation());
        inp.addEventListener("change", () => {
          const zone = this._config.zones[Number(inp.dataset.time)];
          if (inp.value) this._setStart(zone, inp.value);
        });
      });
      root.querySelectorAll(".step").forEach((b) =>
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const zone = this._config.zones[Number(b.dataset.idx)];
          this._bumpMinutes(zone, b.classList.contains("plus") ? 1 : -1);
        })
      );
      root.querySelectorAll("[data-enable]").forEach((b) =>
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const zone = this._config.zones[Number(b.dataset.enable)];
          this._toggle(zone.enable);
        })
      );
    }
  }

  IrrigationScheduleCard.styles = `
    :host { display: block; }
    ha-card { overflow: hidden; padding-bottom: 6px; }

    :host(.style-manual) ha-card {
      background: linear-gradient(145deg, var(--isc-grad-from) 0%, var(--isc-grad-to) 135%);
      color: #fff;
    }
    :host(.style-manual) .title,
    :host(.style-manual) .zname,
    :host(.style-manual) .status span,
    :host(.style-manual) .rain-status span { color: #fff; }
    :host(.style-manual) .zsub,
    :host(.style-manual) .rain-label,
    :host(.style-manual) .chevron { color: rgba(255,255,255,0.75); }
    :host(.style-manual) .zone { border-color: rgba(255,255,255,0.18); }
    :host(.style-manual) .controls { border-top-color: rgba(255,255,255,0.18); }
    :host(.style-manual) .icon-wrap { background: rgba(255,255,255,0.14); color: #fff; }
    :host(.style-manual) .day,
    :host(.style-manual) .chip-btn,
    :host(.style-manual) .skip-btn,
    :host(.style-manual) .stepper { background: rgba(255,255,255,0.12); color: #fff; border-color: rgba(255,255,255,0.25); }
    :host(.style-manual) .day.on { background: #fff; color: var(--isc-grad-to); }

    .header {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px 8px;
    }
    .header-icon { color: var(--primary-color); }
    .title {
      flex: 1; font-size: 1.15rem; font-weight: 500;
      color: var(--primary-text-color);
    }
    .master {
      border: none; background: transparent; cursor: pointer;
      width: 40px; height: 40px; border-radius: 50%;
      color: var(--secondary-text-color);
      display: flex; align-items: center; justify-content: center;
    }
    .master.on { color: var(--primary-color); }
    .master:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.12); }

    .pill-create {
      border: 1px solid var(--primary-color); border-radius: 999px;
      background: transparent; color: var(--primary-color); cursor: pointer;
      padding: 5px 10px; font-size: 0.75rem; font-weight: 600; flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 3px;
    }
    .pill-create ha-icon { --mdc-icon-size: 16px; }
    .pill-create:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.12); }

    .rain-status {
      display: flex; align-items: center; gap: 8px;
      margin: 0 16px 10px; padding: 9px 12px; border-radius: 10px;
      font-size: 0.85rem; font-weight: 500;
    }
    .rain-status ha-icon { --mdc-icon-size: 20px; flex-shrink: 0; }
    .rain-status.ok {
      background: rgba(76,175,80,0.12); color: var(--primary-text-color);
    }
    .rain-status.ok ha-icon { color: var(--success-color, #43a047); }
    .rain-status.warn {
      background: rgba(255,152,0,0.14); color: var(--primary-text-color);
    }
    .rain-status.warn ha-icon { color: var(--warning-color, #ff9800); }

    .status {
      display: flex; align-items: center; gap: 8px;
      margin: 0 16px 10px; padding: 10px 12px; border-radius: 10px;
      background: rgba(var(--rgb-primary-color, 33,150,243), 0.08);
      color: var(--primary-text-color); font-size: 0.9rem; font-weight: 500;
    }
    .status ha-icon { color: var(--primary-color); --mdc-icon-size: 20px; }
    .status.active { background: rgba(var(--rgb-primary-color, 33,150,243), 0.14); }
    .status.warn { background: rgba(255,152,0,0.14); }
    .status.warn ha-icon { color: var(--warning-color, #ff9800); }
    .status.muted { background: rgba(127,127,127,0.10); }
    .status.muted ha-icon { color: var(--secondary-text-color); }

    .controls {
      margin-top: 6px; padding-top: 10px;
      border-top: 1px solid var(--divider-color);
    }

    .rain-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 0 16px 8px; flex-wrap: wrap;
    }
    .rain-label {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 0.8rem; color: var(--secondary-text-color); flex: 1;
    }
    .rain-label ha-icon { --mdc-icon-size: 18px; }
    .rain-btns { display: flex; gap: 6px; }
    .chip-btn {
      border: 1px solid var(--divider-color); border-radius: 999px;
      background: var(--secondary-background-color);
      color: var(--primary-text-color); cursor: pointer;
      padding: 5px 12px; font-size: 0.78rem; font-weight: 600;
    }
    .chip-btn:hover { border-color: var(--primary-color); color: var(--primary-color); }
    .chip-btn.ghost { background: transparent; color: var(--secondary-text-color); }
    .chip-btn:disabled { opacity: 0.4; cursor: default; }

    .skip-row { padding: 0 16px 10px; }
    .skip-btn {
      width: 100%; border: 1px solid var(--divider-color); border-radius: 10px;
      background: var(--secondary-background-color);
      color: var(--primary-text-color); cursor: pointer;
      padding: 9px; font-size: 0.85rem; font-weight: 600;
      display: flex; align-items: center; justify-content: center; gap: 6px;
    }
    .skip-btn:hover { border-color: var(--primary-color); }
    .skip-btn.on {
      background: rgba(255,152,0,0.18);
      border-color: var(--warning-color, #ff9800);
      color: var(--warning-color, #ff9800);
    }
    .skip-btn.create { border-style: dashed; color: var(--primary-color); }
    .skip-btn ha-icon { --mdc-icon-size: 20px; }

    .mini-note {
      display: flex; align-items: flex-start; gap: 6px;
      font-size: 0.78rem; color: var(--secondary-text-color);
      padding: 2px 0 6px;
    }
    .mini-note ha-icon { --mdc-icon-size: 18px; flex-shrink: 0; color: var(--warning-color, #ff9800); }
    .mini-note.sub { color: var(--secondary-text-color); }
    .mini-create {
      width: 100%; border: 1px dashed var(--primary-color); border-radius: 8px;
      background: transparent; color: var(--primary-color); cursor: pointer;
      padding: 8px; font-size: 0.8rem; font-weight: 600;
      display: flex; align-items: center; justify-content: center; gap: 6px;
    }
    .mini-create:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.08); }
    .mini-create:disabled { opacity: 0.6; cursor: default; }

    .zones { padding: 2px 8px; }
    .empty {
      padding: 22px 16px; text-align: center;
      color: var(--secondary-text-color); font-size: 0.9rem;
    }

    .zone {
      border-radius: 12px; margin: 6px 4px;
      border: 1px solid var(--divider-color);
      transition: border-color 0.15s ease;
    }
    .zone.running { border-color: var(--primary-color); background: rgba(var(--rgb-primary-color, 33,150,243), 0.06); }
    .zone.disabled .icon-wrap { opacity: 0.55; }
    .zone.disabled .zname { opacity: 0.7; }
    .zone.expanded { border-color: var(--primary-color); }
    .zone.missing { display: flex; align-items: center; gap: 10px; opacity: 0.7; padding: 10px; }

    .zhead {
      display: flex; align-items: center; gap: 10px;
      padding: 10px; cursor: pointer; border-radius: 12px;
    }
    .zhead:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.04); }
    .chevron { color: var(--secondary-text-color); --mdc-icon-size: 22px; flex-shrink: 0; }
    .icon-wrap {
      width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      background: var(--secondary-background-color);
      color: var(--secondary-text-color);
    }
    .icon-wrap.active {
      background: var(--primary-color); color: var(--text-primary-color, #fff);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(var(--rgb-primary-color, 33,150,243), 0.4); }
      50% { box-shadow: 0 0 0 8px rgba(var(--rgb-primary-color, 33,150,243), 0); }
    }
    .zinfo { flex: 1; min-width: 0; }
    .zname {
      font-weight: 500; color: var(--primary-text-color);
      display: flex; align-items: center; gap: 8px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .zsub {
      font-size: 0.78rem; color: var(--secondary-text-color);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .zsub.running { color: var(--primary-color); font-weight: 600; }
    .zsub.custom { font-style: italic; }

    .zbody { padding: 0 10px 12px; }

    .ztoggle {
      border: none; background: transparent; cursor: pointer;
      color: var(--secondary-text-color);
      width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .ztoggle.on { color: var(--primary-color); }
    .ztoggle:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.10); }

    .days { display: flex; gap: 5px; margin: 10px 0 8px; }
    .day {
      flex: 1; border: 1px solid var(--divider-color); border-radius: 8px;
      background: transparent; color: var(--secondary-text-color);
      cursor: pointer; padding: 7px 0; font-size: 0.8rem; font-weight: 600;
    }
    .day:hover { border-color: var(--primary-color); }
    .day.on {
      background: var(--primary-color); color: var(--text-primary-color, #fff);
      border-color: var(--primary-color);
    }

    .zctl { display: flex; align-items: center; gap: 10px; }
    .time {
      display: inline-flex; align-items: center; gap: 6px;
      border: 1px solid var(--divider-color); border-radius: 8px;
      padding: 4px 8px; color: var(--secondary-text-color); flex: 1;
    }
    .time ha-icon { --mdc-icon-size: 18px; }
    .time input {
      border: none; background: transparent; color: var(--primary-text-color);
      font-size: 0.9rem; font-family: inherit; width: 100%; outline: none;
    }
    .stepper {
      display: flex; align-items: center; gap: 4px; flex-shrink: 0;
      background: var(--secondary-background-color);
      border-radius: 999px; padding: 2px;
    }
    .step {
      width: 30px; height: 30px; border: none; border-radius: 50%;
      background: transparent; color: var(--primary-text-color);
      font-size: 1.1rem; cursor: pointer; line-height: 1;
    }
    .step:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.15); }
    .mins {
      min-width: 52px; text-align: center;
      font-size: 0.82rem; font-weight: 600; color: var(--primary-text-color);
    }
  `;

  /* ========================================================== EDITOR */

  class IrrigationScheduleCardEditor extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._rendered = false;
      this._settingUp = false;
    }

    connectedCallback() {
      this._ensureComponents();
    }

    async _ensureComponents() {
      if (customElements.get("ha-form")) {
        this._render();
        return;
      }
      try {
        const helpers = await window.loadCardHelpers?.();
        const card = await helpers?.createCardElement({ type: "entities", entities: [] });
        await card?.constructor?.getConfigElement?.();
      } catch (e) {
        /* selectors usually still present */
      }
      this._render();
    }

    setConfig(config) {
      const prev = this._config;
      this._config = { title: "Irrigation Schedule", zones: [], ...config };
      this._config.zones = [...(this._config.zones || [])];
      const structureChanged =
        !this._rendered ||
        !prev ||
        (prev.zones || []).length !== this._config.zones.length ||
        prev.device !== this._config.device ||
        prev.style !== this._config.style;
      if (structureChanged) this._render();
      else this._sync();
    }

    _sync() {
      const top = this.shadowRoot.getElementById("top");
      if (top) top.data = this._topData();
      this.shadowRoot
        .querySelectorAll("#zones ha-form")
        .forEach((f, i) => (f.data = this._config.zones[i] || {}));
    }

    set hass(hass) {
      this._hass = hass;
      this.shadowRoot?.querySelectorAll("ha-form").forEach((f) => (f.hass = hass));
      if (!this._rendered) this._render();
    }

    _topData() {
      return {
        title: this._config.title,
        style: this._config.style || "default",
        theme: this._config.theme,
        color_from: this._config.color_from,
        color_to: this._config.color_to,
        device: this._config.device,
        global_enable: this._config.global_enable,
        skip_next: this._config.skip_next,
        rain_delay: this._config.rain_delay,
        rain_rate_sensor: this._config.rain_rate_sensor,
        rain_today_sensor: this._config.rain_today_sensor,
        rain_48h_sensor: this._config.rain_48h_sensor,
        rain_stop_number: this._config.rain_stop_number,
        skip_48h_number: this._config.skip_48h_number,
      };
    }

    _themeOptions() {
      const themes = this._hass?.themes?.themes || {};
      return Object.keys(themes)
        .sort((a, b) => a.localeCompare(b))
        .map((t) => ({ value: t, label: t }));
    }

    _topSchema() {
      const style = this._config.style || "default";
      const schema = [
        { name: "title", selector: { text: {} } },
        {
          name: "style",
          selector: {
            select: {
              mode: "dropdown",
              options: [
                { value: "default", label: "Default (theme-native)" },
                { value: "theme", label: "Theme (per-card)" },
                { value: "manual", label: "Manual gradient" },
              ],
            },
          },
        },
      ];
      if (style === "theme") {
        schema.push({
          name: "theme",
          selector: { select: { mode: "dropdown", options: this._themeOptions() } },
        });
      }
      if (style === "manual") {
        schema.push({ name: "color_from", selector: { text: {} } });
        schema.push({ name: "color_to", selector: { text: {} } });
      }
      schema.push(
        { name: "device", selector: { device: {} } },
        {
          name: "controls",
          type: "expandable",
          flatten: true,
          schema: [
            { name: "global_enable", selector: { entity: { domain: "input_boolean" } } },
            { name: "skip_next", selector: { entity: { domain: "input_boolean" } } },
            { name: "rain_delay", selector: { entity: { domain: "input_datetime" } } },
          ],
        },
        {
          name: "rain",
          type: "expandable",
          flatten: true,
          schema: [
            { name: "rain_rate_sensor", selector: { entity: { domain: "sensor" } } },
            { name: "rain_today_sensor", selector: { entity: { domain: "sensor" } } },
            { name: "rain_48h_sensor", selector: { entity: { domain: "sensor" } } },
            { name: "rain_stop_number", selector: { entity: { domain: "input_number" } } },
            { name: "skip_48h_number", selector: { entity: { domain: "input_number" } } },
          ],
        }
      );
      return schema;
    }

    _deviceEntities(domains) {
      if (!this._config?.device || !this._hass?.entities) return null;
      const list = Object.values(this._hass.entities)
        .filter((e) => e.device_id === this._config.device)
        .map((e) => e.entity_id)
        .filter((id) => domains.includes(id.split(".")[0]));
      return list.length ? list : null;
    }

    _zoneSchema() {
      const include = this._deviceEntities(["switch", "valve", "light", "input_boolean"]);
      return [
        {
          name: "entity",
          required: true,
          selector: include
            ? { entity: { include_entities: include } }
            : { entity: { domain: ["switch", "valve", "light", "input_boolean"] } },
        },
        { name: "schedule", selector: { entity: { domain: "schedule" } } },
        { name: "timer", selector: { entity: { domain: "timer" } } },
        { name: "enable", selector: { entity: { domain: "input_boolean" } } },
        { name: "name", selector: { text: {} } },
        { name: "icon", selector: { icon: {} } },
        {
          name: "default_minutes",
          selector: { number: { min: 1, max: 180, step: 1, mode: "box", unit_of_measurement: "min" } },
        },
      ];
    }

    _label = (schema) =>
      ({
        title: "Card title",
        style: "Style",
        theme: "Theme",
        color_from: "Gradient from (hex)",
        color_to: "Gradient to (hex)",
        device: "Irrigation device (optional — filters the zone entity pickers)",
        controls: "Control helpers",
        rain: "Rain smarts",
        global_enable: "Master schedule switch (input_boolean)",
        skip_next: "Skip-next-run (input_boolean)",
        rain_delay: "Rain delay until (input_datetime)",
        rain_rate_sensor: "Live rain-rate sensor (mm/h)",
        rain_today_sensor: "Rain-today sensor (mm)",
        rain_48h_sensor: "48 h rainfall sensor (mm)",
        rain_stop_number: "Rain-stop threshold (mm/h)",
        skip_48h_number: "48 h skip threshold (mm)",
        entity: "Zone entity (switch / valve)",
        schedule: "Schedule helper (created by Set up helpers)",
        timer: "Timer helper (created by Set up helpers)",
        enable: "Zone enable (input_boolean, created by Set up helpers)",
        name: "Display name",
        icon: "Icon",
        default_minutes: "Default run duration",
      }[schema.name] || schema.name);

    // Inline explanations shown under each field, with live current readings
    // from the configured sensors so Gavin can sanity-check the thresholds.
    _helper = (schema) => {
      const c = this._config;
      const reading = (id, unit) => {
        if (!id) return "no sensor configured";
        const s = this._hass?.states?.[id];
        if (!s || ["unknown", "unavailable", ""].includes(s.state))
          return `no reading from ${id}`;
        return `${s.state}${unit ? " " + unit : ""} from ${id}`;
      };
      return {
        global_enable:
          "Master on/off for the whole programme. When off, no zone runs on schedule.",
        skip_next:
          "When armed, the next scheduled run is skipped once, then it clears itself.",
        rain_delay:
          "Holds a “don’t water until” time — set by the rain-delay buttons on the card face.",
        rain_rate_sensor:
          `Live rain intensity. A running zone is stopped when this stays above the rain-stop threshold. Current reading: ${reading(c.rain_rate_sensor, "mm/h")}.`,
        rain_today_sensor:
          `Rain so far today — the source for the rolling 48-hour total. Current reading: ${reading(c.rain_today_sensor, "mm")}.`,
        rain_48h_sensor:
          `Rain over the last two days. A scheduled run is skipped when this is at or above the 48 h threshold. Current reading: ${reading(c.rain_48h_sensor, "mm")}.`,
        rain_stop_number:
          `Stop watering when rain is heavier than this (mm/h). Current reading: ${reading(c.rain_rate_sensor, "mm/h")}.`,
        skip_48h_number:
          `Skip a scheduled run when more than this much rain (mm) fell over the last two days. Currently: ${reading(c.rain_48h_sensor, "mm")}.`,
      }[schema.name];
    };

    _fire() {
      fireEvent(this, "config-changed", { config: this._config });
    }

    _slug(text) {
      return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    }

    /* ---------------------------------------- one-click helper setup */

    async _wsCreateIfMissing(type, existsEntity, payload) {
      // returns the entity_id (existing or created)
      if (existsEntity && this._hass.states[existsEntity]) return existsEntity;
      const resp = await this._hass.callWS({ type: `${type}/create`, ...payload });
      return `${type}.${resp.id}`;
    }

    // Idempotent helper create. Returns the existing entity when the config
    // already points at one, OR when a helper whose name slug matches already
    // exists (so a re-run with a reset config reuses it instead of creating a
    // duplicate), otherwise creates it. `name` is chosen so its slug is the
    // stable object_id.
    async _ensureHelper(domain, currentId, name, extra = {}) {
      const hass = this._hass;
      if (currentId && hass.states[currentId]) return currentId;
      const expected = `${domain}.${this._slug(name)}`;
      if (hass.states[expected]) return expected;
      const r = await hass.callWS({ type: `${domain}/create`, name, ...extra });
      return `${domain}.${r.id}`;
    }

    async _flowCreate(handler, steps) {
      // steps: array of data dicts submitted in order (first may advance a menu)
      const start = await this._hass.callWS({
        type: "config_entries/flow",
        handler,
        show_advanced_options: false,
      });
      let flowId = start.flow_id;
      for (const data of steps) {
        const res = await this._hass.callWS({
          type: "config_entries/flow/handle",
          flow_id: flowId,
          data,
        });
        flowId = res.flow_id || flowId;
        if (res.type === "create_entry" || res.type === "abort") break;
      }
    }

    async _setupHelpers() {
      if (this._settingUp) return;
      const statusEl = this.shadowRoot.getElementById("setup-status");
      const say = (t) => statusEl && (statusEl.textContent = t);
      const hass = this._hass;
      const zones = this._config.zones.filter((z) => z?.entity);
      if (!zones.length) {
        say("Add at least one zone (with an entity) first.");
        return;
      }
      this._settingUp = true;
      try {
        const newZones = [...this._config.zones];

        // 1. per-zone schedule, timer and enable helpers (idempotent)
        say("Creating schedule / timer / enable helpers…");
        for (let i = 0; i < newZones.length; i++) {
          const z = newZones[i];
          if (!z?.entity) continue;
          const base = z.name || hass.states[z.entity]?.attributes?.friendly_name || `Zone ${i + 1}`;
          const patch = { ...z };
          patch.schedule = await this._ensureHelper("schedule", z.schedule, `Irrigation ${base} Schedule`, { icon: "mdi:calendar-clock" });
          patch.timer = await this._ensureHelper("timer", z.timer, `Irrigation ${base}`, { icon: DEFAULT_ICON, restore: true });
          patch.enable = await this._ensureHelper("input_boolean", z.enable, `Irrigation ${base} Scheduled`, { icon: "mdi:calendar-check" });
          if (!patch.default_minutes) patch.default_minutes = DEFAULT_MINUTES;
          newZones[i] = patch;
        }

        // 2. global control helpers (idempotent)
        say("Creating control helpers…");
        const cfg = { ...this._config };
        cfg.global_enable = await this._ensureHelper("input_boolean", cfg.global_enable, "Irrigation Schedule Enabled", { icon: "mdi:calendar-check" });
        cfg.skip_next = await this._ensureHelper("input_boolean", cfg.skip_next, "Irrigation Skip Next Run", { icon: "mdi:skip-next-circle-outline" });
        cfg.rain_delay = await this._ensureHelper("input_datetime", cfg.rain_delay, "Irrigation Rain Delay Until", { has_date: true, has_time: true, icon: "mdi:weather-pouring" });
        cfg.rain_stop_number = await this._ensureHelper("input_number", cfg.rain_stop_number, "Irrigation Rain Stop Rate", { min: 0, max: 50, step: 0.5, initial: DEFAULT_RAIN_STOP, unit_of_measurement: "mm/h", mode: "box", icon: "mdi:weather-pouring" });
        cfg.skip_48h_number = await this._ensureHelper("input_number", cfg.skip_48h_number, "Irrigation Skip Rain 48h", { min: 0, max: 100, step: 1, initial: DEFAULT_SKIP_48H, unit_of_measurement: "mm", mode: "box", icon: "mdi:weather-rainy" });

        // 3. rain measure: daily utility_meter + 48 h template sensor (best
        // effort, idempotent — skip when the 48 h sensor already exists)
        if (hass.states["sensor.irrigation_rain_48h"] && !cfg.rain_48h_sensor) {
          cfg.rain_48h_sensor = "sensor.irrigation_rain_48h";
        }
        if (cfg.rain_today_sensor && !cfg.rain_48h_sensor) {
          say("Creating rain utility meter + 48 h sensor…");
          try {
            await this._flowCreate("utility_meter", [
              { name: "Irrigation Rain Daily", source: cfg.rain_today_sensor, cycle: "daily" },
            ]);
            await this._flowCreate("template", [
              { next_step_id: "sensor" },
              {
                name: "Irrigation Rain 48h",
                state:
                  "{{ (states('sensor.irrigation_rain_daily') | float(0)) + (state_attr('sensor.irrigation_rain_daily','last_period') | float(0)) }}",
                unit_of_measurement: "mm",
                device_class: "precipitation",
                state_class: "measurement",
              },
            ]);
            cfg.rain_48h_sensor = "sensor.irrigation_rain_48h";
          } catch (e) {
            say("Rain sensor auto-setup skipped (create the utility meter + 48 h template manually — see README).");
          }
        }

        // 4. automations (REST config API)
        say("Creating automations…");
        const switchMap = {}, timerMap = {}, enableMap = {}, offZoneMap = {}, offTimerMap = {};
        const scheduleIds = [], switchIds = [], timerIds = [];
        newZones.forEach((z) => {
          if (!z.entity || !z.schedule || !z.timer) return;
          switchMap[z.schedule] = z.entity;
          timerMap[z.schedule] = z.timer;
          enableMap[z.schedule] = z.enable || "";
          offZoneMap[z.timer] = z.entity;
          offTimerMap[z.entity] = z.timer;
          scheduleIds.push(z.schedule);
          switchIds.push(z.entity);
          timerIds.push(z.timer);
        });

        await hass.callApi("post", "config/automation/config/irrigation_schedule_dispatcher",
          this._dispatcherConfig(cfg, scheduleIds, switchMap, timerMap, enableMap));
        await hass.callApi("post", "config/automation/config/irrigation_schedule_rain_stop",
          this._rainStopConfig(cfg, switchIds, timerIds));
        await hass.callApi("post", "config/automation/config/irrigation_zone_timer_finished",
          this._timerFinishedConfig(offZoneMap));
        await hass.callApi("post", "config/automation/config/irrigation_zone_external_off",
          this._externalOffConfig(offTimerMap));

        // 5. persist resolved config
        this._config = { ...cfg, zones: newZones };
        this._fire();
        say("Done — helpers and automations created. Enable zones on the card face to start scheduling.");
        this._render();
      } catch (err) {
        console.error(`${CARD_TAG} setup failed`, err);
        say(`Setup failed: ${err?.message || err?.error || "check you're an admin user"}. See the README for manual setup.`);
      } finally {
        this._settingUp = false;
      }
    }

    _dispatcherConfig(cfg, scheduleIds, switchMap, timerMap, enableMap) {
      return {
        alias: "Irrigation Schedule - dispatcher",
        description: "Created by irrigation-schedule-card. Starts a zone when its schedule block begins, unless a skip condition is active.",
        mode: "parallel",
        max: MAX_ZONES,
        trigger: [{ platform: "state", entity_id: scheduleIds, to: "on" }],
        variables: {
          switch_map: switchMap,
          timer_map: timerMap,
          enable_map: enableMap,
          sched: "{{ trigger.entity_id }}",
          zone_switch: "{{ switch_map[trigger.entity_id] }}",
          zone_timer: "{{ timer_map[trigger.entity_id] }}",
          zone_enable: "{{ enable_map[trigger.entity_id] }}",
          block_end: "{{ state_attr(trigger.entity_id, 'next_event') }}",
          run_seconds: "{{ [ ((as_timestamp(block_end) - as_timestamp(now())) | int(900)), 60 ] | max if block_end else 900 }}",
          rain48: "{{ states(" + JSON.stringify(cfg.rain_48h_sensor || "") + ") | float(-1) }}",
          skip_threshold: "{{ states(" + JSON.stringify(cfg.skip_48h_number || "") + ") | float(" + DEFAULT_SKIP_48H + ") }}",
          delay_until: "{{ state_attr(" + JSON.stringify(cfg.rain_delay || "") + ", 'timestamp') }}",
        },
        condition: [
          { condition: "state", entity_id: cfg.global_enable, state: "on" },
          { condition: "template", value_template: "{{ zone_enable == '' or is_state(zone_enable, 'on') }}" },
          { condition: "template", value_template: "{{ not is_state(zone_switch, 'on') }}" },
        ],
        action: [
          {
            choose: [
              {
                conditions: [{ condition: "template", value_template: "{{ is_state(" + JSON.stringify(cfg.skip_next || "") + ", 'on') }}" }],
                sequence: [
                  { service: "input_boolean.turn_off", target: { entity_id: cfg.skip_next } },
                  { stop: "Skipped — skip-next was armed" },
                ],
              },
              {
                conditions: [{ condition: "template", value_template: "{{ delay_until != none and now().timestamp() < delay_until | float(0) }}" }],
                sequence: [{ stop: "Skipped — rain delay active" }],
              },
              {
                conditions: [{ condition: "template", value_template: "{{ rain48 >= 0 and rain48 >= skip_threshold }}" }],
                sequence: [{ stop: "Skipped — rain in last 48 h at or above threshold" }],
              },
            ],
            default: [
              { service: "timer.start", target: { entity_id: "{{ zone_timer }}" }, data: { duration: "{{ run_seconds | int }}" } },
              { service: "homeassistant.turn_on", target: { entity_id: "{{ zone_switch }}" } },
            ],
          },
        ],
      };
    }

    _rainStopConfig(cfg, switchIds, timerIds) {
      return {
        alias: "Irrigation Schedule - rain stop",
        description: "Created by irrigation-schedule-card. Stops all zones when live rainfall rate stays above the threshold.",
        mode: "single",
        trigger: [
          {
            platform: "numeric_state",
            entity_id: cfg.rain_rate_sensor,
            above: cfg.rain_stop_number || DEFAULT_RAIN_STOP,
            for: { minutes: 5 },
          },
        ],
        condition: [
          { condition: "template", value_template: "{{ expand(" + JSON.stringify(switchIds) + ") | selectattr('state','eq','on') | list | count > 0 }}" },
        ],
        action: [
          { service: "homeassistant.turn_off", target: { entity_id: switchIds } },
          { service: "timer.cancel", target: { entity_id: timerIds } },
        ],
      };
    }

    _timerFinishedConfig(zoneMap) {
      return {
        alias: "Irrigation - turn zone off when timer ends",
        description: "Created by irrigation-schedule-card (shared with manual-irrigation-zone-card).",
        mode: "parallel",
        max: MAX_ZONES,
        trigger: [
          { platform: "event", event_type: "timer.finished" },
          { platform: "event", event_type: "timer.cancelled" },
        ],
        variables: { zone_map: zoneMap },
        condition: [{ condition: "template", value_template: "{{ trigger.event.data.entity_id in zone_map.keys() }}" }],
        action: [{ service: "homeassistant.turn_off", target: { entity_id: "{{ zone_map[trigger.event.data.entity_id] }}" } }],
      };
    }

    _externalOffConfig(timerMap) {
      return {
        alias: "Irrigation - cancel timer if zone turned off externally",
        description: "Created by irrigation-schedule-card (shared with manual-irrigation-zone-card).",
        mode: "parallel",
        max: MAX_ZONES,
        trigger: [{ platform: "state", entity_id: Object.keys(timerMap), to: "off" }],
        variables: { timer_map: timerMap },
        condition: [{ condition: "template", value_template: "{{ states(timer_map[trigger.entity_id]) == 'active' }}" }],
        action: [{ service: "timer.cancel", target: { entity_id: "{{ timer_map[trigger.entity_id] }}" } }],
      };
    }

    /* ---------------------------------------------------- render */

    _render() {
      if (!this._config) return;
      this._rendered = true;
      const zones = this._config.zones;
      const zonesNeedingSetup = zones.filter(
        (z) => z?.entity && !(z.schedule && z.timer && z.enable && this._hass?.states?.[z.schedule])
      ).length;

      this.shadowRoot.innerHTML = `
        <style>
          .wrap { display: flex; flex-direction: column; gap: 16px; }
          .zone-box { border: 1px solid var(--divider-color); border-radius: 10px; padding: 12px; }
          .zone-head { display: flex; align-items: center; margin-bottom: 8px; }
          .zone-head span { flex: 1; font-weight: 600; font-size: 0.9rem; color: var(--primary-text-color); }
          .del { border: none; background: transparent; cursor: pointer; color: var(--secondary-text-color); padding: 4px; }
          .del:hover { color: var(--error-color, #db4437); }
          .add, .setup { border: 1px dashed var(--divider-color); border-radius: 10px; background: transparent; padding: 12px; cursor: pointer; color: var(--primary-color); font-weight: 600; font-size: 0.9rem; width: 100%; }
          .add:hover, .setup:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.06); }
          .setup { border-style: solid; }
          .setup.ready { border-color: var(--primary-color); }
          .hint { font-size: 0.8rem; color: var(--secondary-text-color); }
          .status { font-size: 0.8rem; color: var(--primary-color); min-height: 1em; }
        </style>
        <div class="wrap">
          <ha-form id="top"></ha-form>
          <div id="zones"></div>
          ${
            zones.length < MAX_ZONES
              ? `<button class="add" id="add">＋ Add zone (${zones.length}/${MAX_ZONES})</button>`
              : `<div class="hint">Maximum of ${MAX_ZONES} zones reached.</div>`
          }
          <button class="setup ${zonesNeedingSetup ? "ready" : ""}" id="setup">
            ⚙ Set up schedule helpers${zonesNeedingSetup ? ` (${zonesNeedingSetup} zone${zonesNeedingSetup === 1 ? "" : "s"} need helpers)` : " — re-run to update"}
          </button>
          <div class="status" id="setup-status"></div>
          <div class="hint">
            “Set up schedule helpers” creates a schedule, timer and enable helper per zone, the
            control helpers (global enable, skip-next, rain delay, thresholds), a daily rainfall
            utility meter + 48 h template sensor, and the dispatcher / rain-stop / safety
            automations — all server-side (admin required). After setup, edit days and times on the
            card face and enable the zones you want.
          </div>
        </div>
      `;

      const top = this.shadowRoot.getElementById("top");
      top.hass = this._hass;
      top.schema = this._topSchema();
      top.data = this._topData();
      top.computeLabel = this._label;
      top.computeHelper = this._helper;
      top.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const v = { ...ev.detail.value, ...(ev.detail.value.controls || {}), ...(ev.detail.value.rain || {}) };
        const styleChanged = v.style !== this._config.style;
        this._config = {
          ...this._config,
          title: v.title,
          style: v.style,
          theme: v.theme,
          color_from: v.color_from,
          color_to: v.color_to,
          device: v.device,
          global_enable: v.global_enable,
          skip_next: v.skip_next,
          rain_delay: v.rain_delay,
          rain_rate_sensor: v.rain_rate_sensor,
          rain_today_sensor: v.rain_today_sensor,
          rain_48h_sensor: v.rain_48h_sensor,
          rain_stop_number: v.rain_stop_number,
          skip_48h_number: v.skip_48h_number,
        };
        this._fire();
        if (styleChanged || v.device !== this._config.device) this._render();
      });

      const zonesEl = this.shadowRoot.getElementById("zones");
      zonesEl.style.display = "flex";
      zonesEl.style.flexDirection = "column";
      zonesEl.style.gap = "12px";

      zones.forEach((zone, idx) => {
        const box = document.createElement("div");
        box.className = "zone-box";
        box.innerHTML = `<div class="zone-head"><span>Zone ${idx + 1}</span><button class="del" title="Remove zone">✕</button></div>`;
        const form = document.createElement("ha-form");
        form.hass = this._hass;
        form.schema = this._zoneSchema();
        form.data = zone;
        form.computeLabel = this._label;
        form.addEventListener("value-changed", (ev) => {
          ev.stopPropagation();
          const newZones = [...this._config.zones];
          newZones[idx] = { ...ev.detail.value };
          this._config = { ...this._config, zones: newZones };
          this._fire();
        });
        box.appendChild(form);
        box.querySelector(".del").addEventListener("click", () => {
          const newZones = this._config.zones.filter((_, i) => i !== idx);
          this._config = { ...this._config, zones: newZones };
          this._fire();
          this._render();
        });
        zonesEl.appendChild(box);
      });

      this.shadowRoot.getElementById("add")?.addEventListener("click", () => {
        const newZones = [...this._config.zones, { default_minutes: DEFAULT_MINUTES }];
        this._config = { ...this._config, zones: newZones };
        this._fire();
        this._render();
      });
      this.shadowRoot.getElementById("setup")?.addEventListener("click", () => this._setupHelpers());
    }
  }

  /* ------------------------------------------------------ register */

  if (!customElements.get(CARD_TAG)) {
    customElements.define(CARD_TAG, IrrigationScheduleCard);
  }
  if (!customElements.get(EDITOR_TAG)) {
    customElements.define(EDITOR_TAG, IrrigationScheduleCardEditor);
  }

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: CARD_TAG,
    name: "Irrigation Schedule Card",
    description:
      "Per-zone weekly irrigation scheduler with rain smarts — each zone its own collapsible day/time/duration editor, plain-language rain status, rain-delay and skip controls, and one-click server-side setup.",
    preview: true,
    documentationURL: "https://github.com/mycrouch/irrigation-schedule-card",
  });

  console.info(
    `%c IRRIGATION-SCHEDULE-CARD %c v${VERSION} `,
    "background:#0f2f4a;color:#fff;padding:2px 6px;border-radius:4px 0 0 4px;",
    "background:#039be5;color:#fff;padding:2px 6px;border-radius:0 4px 4px 0;"
  );
})();
