/**
 * Irrigation Schedule Card v0.1.0
 * https://github.com/mycrouch/irrigation-schedule-card
 * ----------------------------------------------------------------
 * A Lovelace card for weekly irrigation scheduling with rain smarts.
 *
 *  - Per-zone weekly schedule: day-of-week chips (M T W T F S S),
 *    a start time and a run duration, plus an enable toggle per zone
 *    and a global enable. Editing writes to a native HA `schedule`
 *    helper per zone via the schedule WebSocket API.
 *  - Status strip: the next scheduled run (zone + day/time), the zone
 *    currently running with time remaining, and any active skip reason
 *    ("Skipped — 14 mm rain in last 48 h", "Rain delay until Thu 6:00").
 *  - Rain controls: 24 h / 48 h / 72 h rain-delay buttons + clear, and
 *    a "Skip next run" button.
 *  - GUI editor with one-click "Set up schedule helpers": creates the
 *    per-zone schedule + timer helpers, the control helpers, the daily
 *    rainfall utility meter + 48 h template sensor, and the dispatcher,
 *    rain-stop and safety automations — all server-side.
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
  const VERSION = "0.1.0";

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
      this._schedules = {}; // schedule entity_id -> {days:Set, start, minutes, blocks}
      this._loadedSchedules = false;
      this._loadingSchedules = false;
      this._tick = null;
      this._stateKey = "";
      this._appliedThemeProps = [];
    }

    static getConfigElement() {
      return document.createElement(EDITOR_TAG);
    }

    static getStubConfig() {
      return {
        title: "Irrigation Schedule",
        global_enable: "input_boolean.irrigation_schedule_enabled",
        skip_next: "input_boolean.irrigation_skip_next",
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
        this._render();
      }
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

    // Reduce a schedule helper config to {days:Set, start, minutes}.
    _parseSchedule(cfg) {
      const out = { days: new Set(), start: null, minutes: null };
      if (!cfg) return out;
      DAYS.forEach((d, idx) => {
        const blocks = cfg[d.key] || [];
        if (blocks.length) {
          out.days.add(idx);
          if (out.start == null) {
            const from = timeToMin(blocks[0].from);
            const to = timeToMin(blocks[0].to);
            if (from != null) out.start = minToTime(from);
            if (from != null && to != null) {
              out.minutes = Math.max(1, (to > from ? to : to + 1440) - from);
            }
          }
        }
      });
      return out;
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
      const enabled = zone.enable ? isOn(enSt) : true;
      const info = {
        idx,
        zone,
        running,
        missing: !st,
        enabled,
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

      const globalSt = c.global_enable && this._hass.states[c.global_enable];
      const globalOn = c.global_enable ? isOn(globalSt) : true;
      const skipNextOn = c.skip_next && isOn(this._hass.states[c.skip_next]);
      const delayUntil = this._delayUntil();
      const rain48 = this._rain48();
      const skip48Threshold = this._skip48hThreshold();
      const rainSkipActive =
        rain48.value != null && !rain48.stale && rain48.value >= skip48Threshold;
      const dataStale = this._rainDataStale();

      const running = infos.find((i) => i.running);
      const next = this._nextRun(infos);

      // -------- status line
      let statusIcon = "mdi:calendar-clock";
      let statusText;
      let statusClass = "";
      if (!globalOn) {
        statusIcon = "mdi:calendar-remove";
        statusText = "Schedule disabled";
        statusClass = "muted";
      } else if (running) {
        statusIcon = "mdi:water";
        statusText = running.remaining != null
          ? `${running.name} running · ${fmtClock(running.remaining)} left`
          : `${running.name} running`;
        statusClass = "active";
      } else if (delayUntil) {
        statusIcon = "mdi:weather-pouring";
        statusText = `Rain delay until ${this._dayLabel(delayUntil)}`;
        statusClass = "warn";
      } else if (rainSkipActive) {
        statusIcon = "mdi:weather-rainy";
        statusText = `Rain skip — ${rain48.value.toFixed(1)} mm in last 48 h`;
        statusClass = "warn";
      } else if (skipNextOn) {
        statusIcon = "mdi:skip-next-circle-outline";
        statusText = "Next scheduled run will be skipped";
        statusClass = "warn";
      } else if (next) {
        statusText = `Next: ${next.name} · ${this._dayLabel(next.when)}`;
      } else {
        statusIcon = "mdi:calendar-blank";
        statusText = zones.length
          ? "No upcoming runs — pick days below"
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
            <button class="master ${globalOn ? "on" : ""}" id="global"
              title="${globalOn ? "Schedule on" : "Schedule off"}">
              <ha-icon icon="${globalOn ? "mdi:calendar-check" : "mdi:calendar-remove"}"></ha-icon>
            </button>
          </div>

          ${
            dataStale
              ? `<div class="warning">
                   <ha-icon icon="mdi:cloud-alert"></ha-icon>
                   <span>Rain data unavailable or stale — schedule will run without rain checks.</span>
                 </div>`
              : ""
          }

          <div class="status ${statusClass}">
            <ha-icon icon="${statusIcon}"></ha-icon>
            <span>${statusText}</span>
          </div>

          <div class="rain-bar">
            <span class="rain-label"><ha-icon icon="mdi:weather-pouring"></ha-icon>Rain delay</span>
            <div class="rain-btns">
              <button class="chip-btn ${delayUntil ? "" : ""}" data-delay="24">24 h</button>
              <button class="chip-btn" data-delay="48">48 h</button>
              <button class="chip-btn" data-delay="72">72 h</button>
              <button class="chip-btn ghost" id="clear-delay" ${delayUntil ? "" : "disabled"}>Clear</button>
            </div>
          </div>
          <div class="skip-row">
            <button class="skip-btn ${skipNextOn ? "on" : ""}" id="skip-next">
              <ha-icon icon="mdi:skip-next-circle-outline"></ha-icon>
              ${skipNextOn ? "Skip armed — tap to cancel" : "Skip next run"}
            </button>
          </div>

          <div class="zones">
            ${
              zones.length
                ? infos.map((i) => this._zoneHtml(i)).join("")
                : `<div class="empty">No zones configured — open the card editor, add your zones and run “Set up schedule helpers”.</div>`
            }
          </div>

          <div class="foot">
            ${rain48.missing ? "" : `<span>48 h rain: ${
              rain48.value != null ? rain48.value.toFixed(1) + " mm" : "—"
            } · skip ≥ ${skip48Threshold} mm</span>`}
          </div>
        </ha-card>
      `;

      this._attach(infos);
    }

    _zoneHtml(i) {
      const zone = i.zone;
      if (i.missing) {
        return `
          <div class="zone missing">
            <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
            <div class="zinfo">
              <div class="zname">${i.name}</div>
              <div class="zsub">Entity not found: ${zone.entity || "(none set)"}</div>
            </div>
          </div>`;
      }
      const s = this._sched(zone);
      const chips = DAYS.map(
        (d, idx) =>
          `<button class="day ${s.days.has(idx) ? "on" : ""}"
             data-idx="${i.idx}" data-day="${idx}">${d.short}</button>`
      ).join("");

      const runBadge = i.running
        ? `<span class="run-badge"><span class="dot"></span>${
            i.remaining != null ? fmtClock(i.remaining) + " left" : "running"
          }</span>`
        : "";

      return `
        <div class="zone ${i.running ? "running" : ""} ${i.enabled ? "" : "disabled"}">
          <div class="zhead">
            <div class="icon-wrap ${i.running ? "active" : ""}">
              <ha-icon icon="${i.icon}"></ha-icon>
            </div>
            <div class="zinfo">
              <div class="zname">${i.name} ${runBadge}</div>
              <div class="zsub">${
                s.days.size
                  ? `${s.days.size} day${s.days.size > 1 ? "s" : ""} · ${s.start} · ${s.minutes} min`
                  : "Not scheduled"
              }</div>
            </div>
            ${
              zone.enable
                ? `<button class="ztoggle ${i.enabled ? "on" : ""}" data-enable="${i.idx}"
                     title="${i.enabled ? "Zone enabled" : "Zone disabled"}">
                     <ha-icon icon="${i.enabled ? "mdi:toggle-switch" : "mdi:toggle-switch-off-outline"}"></ha-icon>
                   </button>`
                : ""
            }
          </div>
          <div class="days">${chips}</div>
          <div class="zctl">
            <label class="time">
              <ha-icon icon="mdi:clock-outline"></ha-icon>
              <input type="time" value="${s.start}" data-time="${i.idx}" />
            </label>
            <div class="stepper" data-idx="${i.idx}">
              <button class="step minus" data-idx="${i.idx}">−</button>
              <span class="mins">${s.minutes} min</span>
              <button class="step plus" data-idx="${i.idx}">+</button>
            </div>
          </div>
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

      root.querySelectorAll(".day").forEach((b) =>
        b.addEventListener("click", () => {
          const zone = this._config.zones[Number(b.dataset.idx)];
          this._toggleDay(zone, Number(b.dataset.day));
        })
      );
      root.querySelectorAll("[data-time]").forEach((inp) =>
        inp.addEventListener("change", () => {
          const zone = this._config.zones[Number(inp.dataset.time)];
          if (inp.value) this._setStart(zone, inp.value);
        })
      );
      root.querySelectorAll(".step").forEach((b) =>
        b.addEventListener("click", () => {
          const zone = this._config.zones[Number(b.dataset.idx)];
          this._bumpMinutes(zone, b.classList.contains("plus") ? 1 : -1);
        })
      );
      root.querySelectorAll("[data-enable]").forEach((b) =>
        b.addEventListener("click", () => {
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
    :host(.style-manual) .status span { color: #fff; }
    :host(.style-manual) .zsub,
    :host(.style-manual) .foot,
    :host(.style-manual) .rain-label { color: rgba(255,255,255,0.75); }
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

    .warning {
      display: flex; align-items: center; gap: 8px;
      margin: 0 16px 8px; padding: 8px 12px; border-radius: 10px;
      background: rgba(255,152,0,0.14);
      color: var(--warning-color, #ff9800);
      font-size: 0.8rem;
    }
    .warning ha-icon { --mdc-icon-size: 20px; flex-shrink: 0; }

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

    .zones { padding: 2px 8px; }
    .empty {
      padding: 22px 16px; text-align: center;
      color: var(--secondary-text-color); font-size: 0.9rem;
    }

    .zone {
      border-radius: 12px; margin: 6px 4px; padding: 10px 10px 12px;
      border: 1px solid var(--divider-color);
    }
    .zone.running { border-color: var(--primary-color); background: rgba(var(--rgb-primary-color, 33,150,243), 0.06); }
    .zone.disabled { opacity: 0.55; }
    .zone.missing { display: flex; align-items: center; gap: 10px; opacity: 0.7; }

    .zhead { display: flex; align-items: center; gap: 10px; }
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
    .zsub { font-size: 0.78rem; color: var(--secondary-text-color); }
    .run-badge {
      font-size: 0.72rem; font-weight: 600; color: var(--primary-color);
      display: inline-flex; align-items: center; gap: 5px;
    }
    .dot {
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--primary-color); display: inline-block;
      animation: blink 1.2s ease-in-out infinite;
    }
    @keyframes blink { 50% { opacity: 0.25; } }

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

    .foot {
      padding: 4px 16px 6px; text-align: right;
      font-size: 0.72rem; color: var(--secondary-text-color);
    }
    .foot:empty { display: none; }
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
        rain: "Rain sensors & thresholds",
        global_enable: "Global enable (input_boolean)",
        skip_next: "Skip-next-run (input_boolean)",
        rain_delay: "Rain delay until (input_datetime)",
        rain_rate_sensor: "Live precipitation rate (mm/h) sensor",
        rain_today_sensor: "Precipitation today (mm) sensor",
        rain_48h_sensor: "48 h rainfall (mm) sensor",
        rain_stop_number: "Rain-stop threshold (input_number, mm/h)",
        skip_48h_number: "48 h skip threshold (input_number, mm)",
        entity: "Zone entity (switch / valve)",
        schedule: "Schedule helper (created by Set up helpers)",
        timer: "Timer helper (created by Set up helpers)",
        enable: "Zone enable (input_boolean, created by Set up helpers)",
        name: "Display name",
        icon: "Icon",
        default_minutes: "Default run duration",
      }[schema.name] || schema.name);

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

        // 1. per-zone schedule, timer and enable helpers
        say("Creating schedule / timer / enable helpers…");
        for (let i = 0; i < newZones.length; i++) {
          const z = newZones[i];
          if (!z?.entity) continue;
          const base = z.name || hass.states[z.entity]?.attributes?.friendly_name || `Zone ${i + 1}`;
          const patch = { ...z };
          if (!(z.schedule && hass.states[z.schedule])) {
            const r = await hass.callWS({ type: "schedule/create", name: `Irrigation ${base} Schedule`, icon: "mdi:calendar-clock" });
            patch.schedule = `schedule.${r.id}`;
          }
          if (!(z.timer && hass.states[z.timer])) {
            const r = await hass.callWS({ type: "timer/create", name: `Irrigation ${base}`, icon: DEFAULT_ICON, restore: true });
            patch.timer = `timer.${r.id}`;
          }
          if (!(z.enable && hass.states[z.enable])) {
            const r = await hass.callWS({ type: "input_boolean/create", name: `Irrigation ${base} Scheduled`, icon: "mdi:calendar-check" });
            patch.enable = `input_boolean.${r.id}`;
          }
          if (!patch.default_minutes) patch.default_minutes = DEFAULT_MINUTES;
          newZones[i] = patch;
        }

        // 2. global control helpers
        say("Creating control helpers…");
        const cfg = { ...this._config };
        if (!(cfg.global_enable && hass.states[cfg.global_enable])) {
          const r = await hass.callWS({ type: "input_boolean/create", name: "Irrigation Schedule Enabled", icon: "mdi:calendar-check" });
          cfg.global_enable = `input_boolean.${r.id}`;
        }
        if (!(cfg.skip_next && hass.states[cfg.skip_next])) {
          const r = await hass.callWS({ type: "input_boolean/create", name: "Irrigation Skip Next Run", icon: "mdi:skip-next-circle-outline" });
          cfg.skip_next = `input_boolean.${r.id}`;
        }
        if (!(cfg.rain_delay && hass.states[cfg.rain_delay])) {
          const r = await hass.callWS({ type: "input_datetime/create", name: "Irrigation Rain Delay Until", has_date: true, has_time: true, icon: "mdi:weather-pouring" });
          cfg.rain_delay = `input_datetime.${r.id}`;
        }
        if (!(cfg.rain_stop_number && hass.states[cfg.rain_stop_number])) {
          const r = await hass.callWS({ type: "input_number/create", name: "Irrigation Rain Stop Rate", min: 0, max: 50, step: 0.5, initial: DEFAULT_RAIN_STOP, unit_of_measurement: "mm/h", mode: "box", icon: "mdi:weather-pouring" });
          cfg.rain_stop_number = `input_number.${r.id}`;
        }
        if (!(cfg.skip_48h_number && hass.states[cfg.skip_48h_number])) {
          const r = await hass.callWS({ type: "input_number/create", name: "Irrigation Skip Rain 48h", min: 0, max: 100, step: 1, initial: DEFAULT_SKIP_48H, unit_of_measurement: "mm", mode: "box", icon: "mdi:weather-rainy" });
          cfg.skip_48h_number = `input_number.${r.id}`;
        }

        // 3. rain measure: daily utility_meter + 48 h template sensor (best effort)
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
      "Weekly irrigation scheduler with rain smarts — per-zone day/time/duration, rain-delay and skip controls, and one-click server-side setup.",
    preview: true,
    documentationURL: "https://github.com/mycrouch/irrigation-schedule-card",
  });

  console.info(
    `%c IRRIGATION-SCHEDULE-CARD %c v${VERSION} `,
    "background:#0f2f4a;color:#fff;padding:2px 6px;border-radius:4px 0 0 4px;",
    "background:#039be5;color:#fff;padding:2px 6px;border-radius:0 4px 4px 0;"
  );
})();
