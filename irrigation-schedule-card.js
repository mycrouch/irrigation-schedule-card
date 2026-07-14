/**
 * Irrigation Schedule Card v0.3.0
 * https://github.com/mycrouch/irrigation-schedule-card
 * ----------------------------------------------------------------
 * A Lovelace card for weekly irrigation scheduling with rain smarts.
 *
 * Schedule-centric model (v0.3.0):
 *  - Schedules are the first-class object. A schedule is a display name, one
 *    physical zone, a set of day chips, a start time, a run duration and an
 *    enable toggle. The same zone can appear in as many schedules as you like —
 *    "Veggie Pods Mon/Wed/Fri 10 min" and "Veggie Pods Sun 30 min deep soak"
 *    coexist, each with its own days/time/duration.
 *  - The card face lists schedules with plain-language summaries
 *    ("Mon, Wed, Fri at 5:30 am for 10 min"), an enable toggle each, and
 *    tap-to-expand day/time/duration editors. Rain sentence, rain delay,
 *    skip-next and the global master switch are unchanged.
 *  - The editor is two steps: first "Zones in your system" (a zone count and
 *    each zone's physical switch/valve, with a one-click "Set up helpers" that
 *    creates the per-zone timer / schedule / enable helpers and the control
 *    helpers + automations); then a "Schedules" list you add to and delete
 *    from, each schedule bound to one of the defined zones.
 *
 * Server-side design:
 *  - Each physical zone keeps exactly ONE native HA `schedule` helper
 *    (`schedule.irrigation_zone_N_schedule`). Card-level schedules are groups
 *    of day/time blocks; a zone's helper is regenerated as the union of the
 *    blocks contributed by every enabled schedule on that zone (each schedule
 *    writes {from: start, to: start+minutes} on its days). This is the sync
 *    mechanism — schedule definitions are the source of truth (they live in the
 *    card config, saved to the Lovelace config via WebSocket), and the helper
 *    is a derived cache the dispatcher automation reads. The dispatcher is
 *    untouched: it starts a zone when its helper block begins and runs it for
 *    the block's own length (next_event − now), so per-schedule durations are
 *    honoured even when several schedules share a zone.
 *  - Overlap: if a schedule fires for a zone that's already running, the
 *    dispatcher never double-starts; it extends the running timer only when the
 *    new block ends later than the current finish.
 *  - Back-compat: a v0.2 config (zones with per-zone schedule/timer/enable) is
 *    read as-is; if it has no `schedules` array, one schedule per zone is
 *    derived on load from that zone's existing helper blocks, so no watering
 *    plan is lost. Legacy helper blocks are never discarded on load.
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
  const VERSION = "0.3.0";

  const MAX_ZONES = 8;
  const MAX_SCHEDULES = 24;
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

  const slugify = (text) =>
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

  let SCHED_SEQ = 0;
  const newScheduleId = () =>
    `s${Date.now().toString(36)}${(SCHED_SEQ++).toString(36)}`;

  /* ============================================================ CARD */

  class IrrigationScheduleCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      this._helperBlocks = {}; // zone schedule entity_id -> parsed block map
      this._loadedSchedules = false;
      this._loadingSchedules = false;
      this._migrated = false;
      this._tick = null;
      this._stateKey = "";
      this._appliedThemeProps = [];
      this._expanded = new Set(); // schedule ids currently expanded
      this._creating = new Set(); // entity ids mid-create
      this._syncing = new Set(); // zone entity ids mid-sync
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
        default_minutes: DEFAULT_MINUTES,
        zones: [],
        schedules: [],
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
      // Working copy of schedules the face edits and persists. Back-compat: a
      // v0.2 config has no `schedules`; we derive one per zone once helpers load.
      this._schedules = Array.isArray(config.schedules)
        ? config.schedules.map((s) => ({ ...s }))
        : null;
      this._loadedSchedules = false;
      this._migrated = false;
      this._stateKey = "";
      this._render();
    }

    set hass(hass) {
      const prev = this._hass;
      this._hass = hass;
      if (!this._loadedSchedules && !this._loadingSchedules) {
        this._loadSchedules();
      }
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
      return 3 + (this._effectiveSchedules().length || 0);
    }

    disconnectedCallback() {
      if (this._tick) {
        clearInterval(this._tick);
        this._tick = null;
      }
    }

    /* ------------------------------------------------ zone resolution */

    _zones() {
      return this._config?.zones || [];
    }

    // Find the zone config for a schedule (by entity id).
    _zoneFor(schedule) {
      const zid = schedule?.zone;
      return this._zones().find((z) => z.entity === zid) || null;
    }

    _zoneLabel(zone, idx) {
      if (!zone) return `Zone ${idx + 1}`;
      return (
        zone.name ||
        this._hass?.states?.[zone.entity]?.attributes?.friendly_name ||
        zone.entity ||
        `Zone ${idx + 1}`
      );
    }

    _defaultMinutes() {
      const d = Number(this._config?.default_minutes);
      return Number.isFinite(d) && d > 0 ? d : DEFAULT_MINUTES;
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

    /* ------------------------------------------------ schedule loading */

    async _loadSchedules() {
      if (!this._hass || this._loadingSchedules) return;
      this._loadingSchedules = true;
      try {
        const list = await this._hass.callWS({ type: "schedule/list" });
        const byId = {};
        (list || []).forEach((s) => (byId[s.id] = s));
        this._zones().forEach((z) => {
          if (!z.schedule) return;
          this._helperBlocks[z.schedule] = byId[objectId(z.schedule)] || null;
        });
        this._loadedSchedules = true;
        this._maybeMigrate();
      } catch (e) {
        // schedule/list unavailable — fall back to config-only schedules
        this._loadedSchedules = true;
        this._maybeMigrate();
      } finally {
        this._loadingSchedules = false;
        this._stateKey = "";
        this._render();
      }
    }

    // Back-compat: a v0.2 config has no `schedules`. Derive one schedule per
    // legacy zone from that zone's existing helper blocks so no plan is lost.
    _maybeMigrate() {
      if (this._migrated) return;
      if (Array.isArray(this._schedules)) {
        this._migrated = true;
        return;
      }
      const derived = [];
      this._zones().forEach((z, idx) => {
        const parsed = this._parseHelper(this._helperBlocks[z.schedule]);
        const enSt = z.enable ? this._hass?.states?.[z.enable] : null;
        const enabled = z.enable && enSt ? isOn(enSt) : true;
        derived.push({
          id: newScheduleId(),
          name: this._zoneLabel(z, idx),
          zone: z.entity,
          days: parsed.custom ? [] : [...parsed.days],
          start: parsed.start || DEFAULT_START,
          minutes: parsed.minutes || this._defaultMinutes(),
          enabled,
          // A schedule the simple model can't represent is preserved verbatim
          // and flagged so we never flatten it on an unrelated re-render.
          custom: parsed.custom || false,
          customSummary: parsed.summary || "",
        });
      });
      this._schedules = derived;
      this._migrated = true;
    }

    _effectiveSchedules() {
      return Array.isArray(this._schedules) ? this._schedules : [];
    }

    // Reduce a native schedule helper config to {days:Set, start, minutes,
    // custom, summary}. Used only for migration / display of legacy helpers.
    _parseHelper(cfg) {
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
          if (from !== firstFrom || to !== firstTo) out.custom = true;
        }
      });
      if (out.custom) out.summary = this._customSummary(cfg);
      return out;
    }

    _customSummary(cfg) {
      const parts = [];
      DAYS.forEach((d) => {
        const blocks = cfg[d.key] || [];
        blocks.forEach((b) => {
          const f = timeToMin(b.from);
          const t = timeToMin(b.to);
          const mins =
            f != null && t != null
              ? Math.max(1, (t > f ? t : t + 1440) - f)
              : null;
          parts.push(
            `${d.label} ${fmt12(b.from)}${mins != null ? ` (${mins} min)` : ""}`
          );
        });
      });
      return parts.join(" · ");
    }

    /* ------------------------------------------------ schedule editing */

    _normSchedule(s) {
      return {
        id: s.id || newScheduleId(),
        name: s.name || "Schedule",
        zone: s.zone || this._zones()[0]?.entity || "",
        days: Array.isArray(s.days) ? [...s.days] : [],
        start: s.start || DEFAULT_START,
        minutes: Number(s.minutes) > 0 ? Number(s.minutes) : this._defaultMinutes(),
        enabled: s.enabled !== false,
        custom: !!s.custom,
        customSummary: s.customSummary || "",
      };
    }

    // Persist schedules into the Lovelace config so face edits survive reloads.
    // We emit config-changed AND, when the card is not inside the GUI editor,
    // write straight to the Lovelace storage config over WS so a plain view
    // (no editor mounted) still saves. Both paths carry the same schedules
    // array, so config and helpers can never silently drift.
    _persistSchedules() {
      const next = {
        ...this._config,
        schedules: this._effectiveSchedules().map((s) => this._normSchedule(s)),
      };
      this._config = next;
      // Lovelace listens for this to write storage when an editor context owns
      // the card; harmless otherwise.
      fireEvent(this, "config-changed", { config: next });
      this._saveLovelaceConfig(next);
    }

    // Robust persistence for face edits: locate this card in the active
    // Lovelace storage dashboard and rewrite just this card's config via the
    // config/save WebSocket, so edits made on the card face (no editor open)
    // are not lost on refresh. Best-effort and idempotent.
    async _saveLovelaceConfig(cardConfig) {
      const hass = this._hass;
      if (!hass?.callWS) return;
      try {
        const urlPath = this._dashboardUrlPath();
        const req = { type: "lovelace/config", force: false };
        if (urlPath) req.url_path = urlPath;
        const lovelace = await hass.callWS(req);
        if (!lovelace || !Array.isArray(lovelace.views)) return;
        let changed = false;
        const matches = (card) =>
          card &&
          (card.type === `custom:${CARD_TAG}` || card.type === CARD_TAG) &&
          (card.title || "") === (cardConfig.title || "") &&
          this._sameZones(card.zones, cardConfig.zones);
        const walk = (cards) => {
          if (!Array.isArray(cards)) return;
          for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            if (matches(card)) {
              cards[i] = { ...card, schedules: cardConfig.schedules };
              changed = true;
            } else if (card && Array.isArray(card.cards)) {
              walk(card.cards);
            }
          }
        };
        (lovelace.views || []).forEach((v) => {
          walk(v.cards);
          (v.sections || []).forEach((sec) => walk(sec.cards));
        });
        if (!changed) return;
        const save = { type: "lovelace/config/save", config: lovelace };
        if (urlPath) save.url_path = urlPath;
        await hass.callWS(save);
      } catch (e) {
        // Non-admin users or YAML-mode dashboards can't save this way; the
        // config-changed event still covers the editor path.
        console.debug(`${CARD_TAG}: lovelace save skipped`, e);
      }
    }

    _dashboardUrlPath() {
      // Derive the dashboard url_path from the current location, e.g.
      // /dashboard-mobile/irrigation -> "dashboard-mobile". "lovelace" (the
      // default dashboard) is passed as undefined per the WS API.
      const seg = (location.pathname || "").split("/").filter(Boolean);
      const first = seg[0];
      if (!first || first === "lovelace") return undefined;
      return first;
    }

    _sameZones(a, b) {
      const ea = (a || []).map((z) => z.entity).join(",");
      const eb = (b || []).map((z) => z.entity).join(",");
      return ea === eb;
    }

    _sched(id) {
      const s = this._effectiveSchedules().find((x) => x.id === id);
      return s ? this._normSchedule(s) : null;
    }

    _updateSchedule(id, patch) {
      const list = this._effectiveSchedules();
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) return null;
      const merged = this._normSchedule({ ...list[i], ...patch });
      list[i] = merged;
      this._schedules = list;
      this._stateKey = "";
      this._render();
      this._persistSchedules();
      return merged;
    }

    _toggleDay(id, idx) {
      const s = this._sched(id);
      if (!s) return;
      const set = new Set(s.days);
      set.has(idx) ? set.delete(idx) : set.add(idx);
      const patch = { days: [...set].sort((a, b) => a - b) };
      if (s.custom) {
        // Editing a preserved custom schedule collapses it to the simple model.
        patch.custom = false;
        patch.customSummary = "";
      }
      this._updateSchedule(id, patch);
      this._syncZoneFor(id);
    }

    _setStart(id, start) {
      const s = this._sched(id);
      if (!s) return;
      const patch = { start };
      if (s.custom) {
        patch.custom = false;
        patch.customSummary = "";
      }
      this._updateSchedule(id, patch);
      this._syncZoneFor(id);
    }

    _bumpMinutes(id, delta) {
      const s = this._sched(id);
      if (!s) return;
      const step = s.minutes >= 10 ? 5 : 1;
      const minutes = Math.min(180, Math.max(1, s.minutes + delta * step));
      const patch = { minutes };
      if (s.custom) {
        patch.custom = false;
        patch.customSummary = "";
      }
      this._updateSchedule(id, patch);
      this._syncZoneFor(id);
    }

    _toggleScheduleEnabled(id) {
      const s = this._sched(id);
      if (!s) return;
      this._updateSchedule(id, { enabled: !s.enabled });
      this._syncZoneFor(id);
    }

    _toggleExpand(id) {
      this._expanded.has(id)
        ? this._expanded.delete(id)
        : this._expanded.add(id);
      this._render();
    }

    /* ------------------------------------------------ helper sync */

    _syncZoneFor(scheduleId) {
      const s = this._sched(scheduleId);
      if (!s) return;
      this._syncZone(s.zone);
    }

    // Regenerate a zone's native schedule helper as the union of the blocks
    // from every ENABLED, non-custom schedule bound to that zone. Custom
    // schedules are preserved verbatim (their raw helper blocks are re-emitted
    // untouched). This is the single sync path — config drives helper.
    async _syncZone(zoneEntity) {
      if (!zoneEntity || !this._hass || this._syncing.has(zoneEntity)) return;
      const zone = this._zones().find((z) => z.entity === zoneEntity);
      if (!zone?.schedule) return;
      this._syncing.add(zoneEntity);
      try {
        // Start from any preserved custom blocks so we never lose them.
        const dayBlocks = {};
        DAYS.forEach((d) => (dayBlocks[d.key] = []));
        const raw = this._helperBlocks[zone.schedule];
        this._effectiveSchedules()
          .filter((s) => s.zone === zoneEntity)
          .forEach((s) => {
            const n = this._normSchedule(s);
            if (!n.enabled) return;
            if (n.custom && raw) {
              DAYS.forEach((d) => {
                (raw[d.key] || []).forEach((b) => dayBlocks[d.key].push(b));
              });
              return;
            }
            const startMin = timeToMin(n.start);
            if (startMin == null) return;
            let endMin = startMin + n.minutes;
            if (endMin >= 1440) endMin = 1439; // clamp, no cross-midnight
            const from = `${minToTime(startMin)}:00`;
            const to = `${minToTime(endMin)}:00`;
            n.days.forEach((di) => {
              const key = DAYS[di]?.key;
              if (key) dayBlocks[key].push({ from, to });
            });
          });
        // Sort + dedupe each day's blocks so the helper is tidy.
        DAYS.forEach((d) => {
          const seen = new Set();
          dayBlocks[d.key] = dayBlocks[d.key]
            .filter((b) => {
              const k = `${b.from}|${b.to}`;
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            })
            .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
        });
        const payload = {
          type: "schedule/update",
          schedule_id: objectId(zone.schedule),
        };
        DAYS.forEach((d) => (payload[d.key] = dayBlocks[d.key]));
        await this._hass.callWS(payload);
        this._helperBlocks[zone.schedule] = { ...payload };
      } catch (e) {
        console.error(`${CARD_TAG}: zone sync failed for ${zoneEntity}`, e);
      } finally {
        this._syncing.delete(zoneEntity);
      }
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

    // One-tap create for a configured helper that's missing from hass.states.
    async _createMissing(entityId) {
      if (!entityId || !this._hass || this._creating.has(entityId)) return;
      const domain = entityId.split(".")[0];
      const oid = objectId(entityId);
      const name = titleize(oid);
      const creatable = {
        input_boolean: {
          type: "input_boolean/create",
          payload: { name, icon: "mdi:calendar-check" },
        },
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
      if (!creatable) return;
      this._creating.add(entityId);
      this._render();
      try {
        await this._hass.callWS({ type: creatable.type, ...creatable.payload });
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
      if (c.rain_stop_number)
        return this._num(c.rain_stop_number, c.rain_stop_threshold ?? DEFAULT_RAIN_STOP);
      return c.rain_stop_threshold ?? DEFAULT_RAIN_STOP;
    }

    _skip48hThreshold() {
      const c = this._config;
      if (c.skip_48h_number)
        return this._num(c.skip_48h_number, c.skip_48h_threshold ?? DEFAULT_SKIP_48H);
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
      const age =
        (Date.now() - new Date(s.last_updated || s.last_changed).getTime()) / 3600000;
      return { value: Number.isNaN(v) ? null : v, stale: age > STALE_HOURS, missing: false };
    }

    _rainDataStale() {
      const c = this._config;
      const check = (id) => {
        if (!id) return false;
        const s = this._hass?.states?.[id];
        if (!isUsable(s)) return true;
        const age =
          (Date.now() - new Date(s.last_updated || s.last_changed).getTime()) / 3600000;
        return age > STALE_HOURS;
      };
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

    // Next scheduled run across all zones, using each zone helper's next_event.
    // Names come from the enabled schedule whose block matches, so the label is
    // the schedule name, not "Zone N".
    _nextRun() {
      let best = null;
      this._zones().forEach((z, idx) => {
        const s = this._hass?.states?.[z.schedule];
        if (!s) return;
        const ne = s.attributes?.next_event;
        if (!ne) return;
        const when = new Date(ne);
        if (s.state === "on") return; // in a block; handled as running
        if (when.getTime() <= Date.now()) return;
        // Zone must have at least one enabled schedule on it.
        const enabledHere = this._effectiveSchedules().some(
          (sc) => sc.zone === z.entity && sc.enabled !== false
        );
        if (!enabledHere) return;
        const name = this._nameForRunAt(z.entity, when) || this._zoneLabel(z, idx);
        if (!best || when < best.when) best = { when, name };
      });
      return best;
    }

    // Given a zone and a block start time, find the schedule whose start/day
    // best matches so we can label the run with the schedule's name.
    _nameForRunAt(zoneEntity, when) {
      const di = (when.getDay() + 6) % 7;
      const hhmm = `${pad2(when.getHours())}:${pad2(when.getMinutes())}`;
      const candidates = this._effectiveSchedules().filter(
        (s) =>
          s.zone === zoneEntity &&
          s.enabled !== false &&
          (s.days || []).includes(di)
      );
      const exact = candidates.find((s) => (s.start || "").slice(0, 5) === hhmm);
      return (exact || candidates[0])?.name || null;
    }

    /* ------------------------------------------------ schedule info */

    _scheduleInfo(sched, idx) {
      const s = this._normSchedule(sched);
      const zone = this._zoneFor(s);
      const st = zone ? this._hass?.states?.[zone.entity] : null;
      const running = isOn(st);
      const info = {
        idx,
        schedule: s,
        zone,
        running,
        zoneMissing: !!zone && !st,
        noZone: !zone,
        enabled: s.enabled,
        name: s.name,
        zoneName: this._zoneLabel(zone, this._zones().indexOf(zone)),
        icon: zone?.icon || st?.attributes?.icon || DEFAULT_ICON,
        remaining: null,
        total: null,
        elapsed: null,
      };
      if (running && zone) {
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

    _rainStatus() {
      const c = this._config;
      const delayUntil = this._delayUntil();
      const rate = c.rain_rate_sensor ? this._num(c.rain_rate_sensor, null) : null;
      const rateThresh = this._rainStopThreshold();
      const r48 = this._rain48();
      const skip48 = this._skip48hThreshold();
      const anyRunning = this._zones().some((z) =>
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

    // Plain-language one-line summary of a schedule.
    _scheduleSummary(info) {
      const s = info.schedule;
      if (info.running) {
        return info.remaining != null
          ? `Running now · ${fmtClock(info.remaining)} left`
          : "Running now";
      }
      if (info.enabled === false) return "Off";
      if (s.custom)
        return `Custom schedule — ${s.customSummary || "set outside the card"}`;
      if (!s.days.length) return "Not scheduled — pick some days";
      const days = new Set(s.days);
      return `${s.days.length}× a week — ${daysList(days)} at ${fmt12(
        s.start
      )} for ${s.minutes} min`;
    }

    /* ------------------------------------------------ styling */

    _applyStyle() {
      const host = this;
      const style = this._config.style || "default";
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
      const schedules = this._effectiveSchedules();
      const infos = schedules.map((s, i) => this._scheduleInfo(s, i));
      const runningCount = infos.filter((i) => i.running).length;

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
      const next = this._nextRun();
      const rain = this._rainStatus();

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
        statusText = schedules.length
          ? "No upcoming runs — open a schedule below and pick its days"
          : "No schedules yet — add one in the card editor";
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

          <div class="schedules">
            ${
              schedules.length
                ? infos.map((i) => this._scheduleHtml(i)).join("")
                : `<div class="empty">No schedules yet — open the card editor, define your zones and add a schedule for each watering you want.</div>`
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

      this._attach();
    }

    _scheduleHtml(i) {
      const s = i.schedule;
      const id = s.id;

      if (i.noZone) {
        return `
          <div class="sched missing">
            <div class="icon-wrap warn"><ha-icon icon="mdi:alert-circle-outline"></ha-icon></div>
            <div class="sinfo">
              <div class="sname">${s.name}</div>
              <div class="ssub">No zone assigned — open the editor and pick a zone.</div>
            </div>
          </div>`;
      }
      if (i.zoneMissing) {
        return `
          <div class="sched missing">
            <div class="icon-wrap warn"><ha-icon icon="mdi:alert-circle-outline"></ha-icon></div>
            <div class="sinfo">
              <div class="sname">${s.name}</div>
              <div class="ssub">Zone entity not found: ${i.zone.entity || "(none set)"}</div>
            </div>
          </div>`;
      }

      const expanded = this._expanded.has(id);
      const summary = this._scheduleSummary(i);

      const headCtl = `<button class="stoggle ${i.enabled ? "on" : ""}" data-enable="${id}"
             title="${i.enabled ? "Schedule enabled" : "Schedule off"}">
             <ha-icon icon="${i.enabled ? "mdi:toggle-switch" : "mdi:toggle-switch-off-outline"}"></ha-icon>
           </button>`;

      const chips = DAYS.map(
        (d, di) =>
          `<button class="day ${s.days.includes(di) ? "on" : ""}"
             data-id="${id}" data-day="${di}">${d.short}</button>`
      ).join("");

      let body = "";
      if (expanded) {
        body = `
          <div class="sbody">
            ${
              s.custom
                ? `<div class="mini-note">
                     <ha-icon icon="mdi:information-outline"></ha-icon>
                     This schedule was set outside the card. Editing the days, time or duration below replaces it with a simple weekly one.
                   </div>`
                : ""
            }
            <div class="zone-line">
              <ha-icon icon="mdi:water"></ha-icon>
              <span>Waters <strong>${i.zoneName}</strong></span>
            </div>
            <div class="days">${chips}</div>
            <div class="sctl">
              <label class="time">
                <ha-icon icon="mdi:clock-outline"></ha-icon>
                <input type="time" value="${s.start}" data-time="${id}" />
              </label>
              <div class="stepper">
                <button class="step minus" data-mins="${id}" data-dir="-1">−</button>
                <span class="mins">${s.minutes} min</span>
                <button class="step plus" data-mins="${id}" data-dir="1">+</button>
              </div>
            </div>
          </div>`;
      }

      return `
        <div class="sched ${i.running ? "running" : ""} ${i.enabled ? "" : "disabled"} ${expanded ? "expanded" : ""}">
          <div class="shead" data-expand="${id}">
            <div class="icon-wrap ${i.running ? "active" : ""}">
              <ha-icon icon="${i.icon}"></ha-icon>
            </div>
            <div class="sinfo">
              <div class="sname">${s.name}</div>
              <div class="ssub ${i.running ? "running" : ""} ${s.custom ? "custom" : ""}">${summary}</div>
            </div>
            ${headCtl}
            <ha-icon class="chevron" icon="${expanded ? "mdi:chevron-up" : "mdi:chevron-down"}"></ha-icon>
          </div>
          ${body}
        </div>`;
    }

    _attach() {
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

      root.querySelectorAll("[data-create]").forEach((b) =>
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._createMissing(b.dataset.create);
        })
      );

      root.querySelectorAll("[data-expand]").forEach((el) =>
        el.addEventListener("click", (ev) => {
          if (ev.target.closest("[data-enable],[data-create]")) return;
          this._toggleExpand(el.dataset.expand);
        })
      );

      root.querySelectorAll(".day").forEach((b) =>
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._toggleDay(b.dataset.id, Number(b.dataset.day));
        })
      );
      root.querySelectorAll("[data-time]").forEach((inp) => {
        inp.addEventListener("click", (ev) => ev.stopPropagation());
        inp.addEventListener("change", () => {
          if (inp.value) this._setStart(inp.dataset.time, inp.value);
        });
      });
      root.querySelectorAll("[data-mins]").forEach((b) =>
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._bumpMinutes(b.dataset.mins, Number(b.dataset.dir));
        })
      );
      root.querySelectorAll("[data-enable]").forEach((b) =>
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this._toggleScheduleEnabled(b.dataset.enable);
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
    :host(.style-manual) .sname,
    :host(.style-manual) .status span,
    :host(.style-manual) .rain-status span { color: #fff; }
    :host(.style-manual) .ssub,
    :host(.style-manual) .rain-label,
    :host(.style-manual) .zone-line,
    :host(.style-manual) .chevron { color: rgba(255,255,255,0.75); }
    :host(.style-manual) .sched { border-color: rgba(255,255,255,0.18); }
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

    .schedules { padding: 2px 8px; }
    .empty {
      padding: 22px 16px; text-align: center;
      color: var(--secondary-text-color); font-size: 0.9rem;
    }

    .sched {
      border-radius: 12px; margin: 6px 4px;
      border: 1px solid var(--divider-color);
      transition: border-color 0.15s ease;
    }
    .sched.running { border-color: var(--primary-color); background: rgba(var(--rgb-primary-color, 33,150,243), 0.06); }
    .sched.disabled .icon-wrap { opacity: 0.55; }
    .sched.disabled .sname { opacity: 0.7; }
    .sched.expanded { border-color: var(--primary-color); }
    .sched.missing { display: flex; align-items: center; gap: 10px; opacity: 0.8; padding: 10px; }

    .shead {
      display: flex; align-items: center; gap: 10px;
      padding: 10px; cursor: pointer; border-radius: 12px;
    }
    .shead:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.04); }
    .chevron { color: var(--secondary-text-color); --mdc-icon-size: 22px; flex-shrink: 0; }
    .icon-wrap {
      width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      background: var(--secondary-background-color);
      color: var(--secondary-text-color);
    }
    .icon-wrap.warn { color: var(--warning-color, #ff9800); }
    .icon-wrap.active {
      background: var(--primary-color); color: var(--text-primary-color, #fff);
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(var(--rgb-primary-color, 33,150,243), 0.4); }
      50% { box-shadow: 0 0 0 8px rgba(var(--rgb-primary-color, 33,150,243), 0); }
    }
    .sinfo { flex: 1; min-width: 0; }
    .sname {
      font-weight: 500; color: var(--primary-text-color);
      display: flex; align-items: center; gap: 8px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ssub {
      font-size: 0.78rem; color: var(--secondary-text-color);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .ssub.running { color: var(--primary-color); font-weight: 600; }
    .ssub.custom { font-style: italic; }

    .sbody { padding: 0 10px 12px; }
    .zone-line {
      display: flex; align-items: center; gap: 6px;
      font-size: 0.8rem; color: var(--secondary-text-color);
      padding: 8px 2px 2px;
    }
    .zone-line ha-icon { --mdc-icon-size: 18px; color: var(--primary-color); }
    .zone-line strong { color: var(--primary-text-color); font-weight: 600; }

    .stoggle {
      border: none; background: transparent; cursor: pointer;
      color: var(--secondary-text-color);
      width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
    }
    .stoggle.on { color: var(--primary-color); }
    .stoggle:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.10); }

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

    .sctl { display: flex; align-items: center; gap: 10px; }
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
      this._config = {
        title: "Irrigation Schedule",
        default_minutes: DEFAULT_MINUTES,
        zones: [],
        schedules: [],
        ...config,
      };
      this._config.zones = [...(this._config.zones || [])];
      this._config.schedules = [...(this._config.schedules || [])];
      const structureChanged =
        !this._rendered ||
        !prev ||
        (prev.zones || []).length !== this._config.zones.length ||
        (prev.schedules || []).length !== this._config.schedules.length ||
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
      this.shadowRoot
        .querySelectorAll("#schedules ha-form")
        .forEach((f, i) => (f.data = this._scheduleData(this._config.schedules[i] || {})));
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
        default_minutes: this._config.default_minutes ?? DEFAULT_MINUTES,
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
        {
          name: "default_minutes",
          selector: { number: { min: 1, max: 180, step: 1, mode: "box", unit_of_measurement: "min" } },
        },
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
        { name: "name", selector: { text: {} } },
        { name: "icon", selector: { icon: {} } },
        { name: "schedule", selector: { entity: { domain: "schedule" } } },
        { name: "timer", selector: { entity: { domain: "timer" } } },
        { name: "enable", selector: { entity: { domain: "input_boolean" } } },
      ];
    }

    // Options for the schedule's zone picker: one per defined zone.
    _zoneOptions() {
      return (this._config.zones || [])
        .filter((z) => z?.entity)
        .map((z, i) => ({
          value: z.entity,
          label:
            z.name ||
            this._hass?.states?.[z.entity]?.attributes?.friendly_name ||
            z.entity ||
            `Zone ${i + 1}`,
        }));
    }

    _scheduleSchema() {
      return [
        { name: "name", required: true, selector: { text: {} } },
        {
          name: "zone",
          required: true,
          selector: { select: { mode: "dropdown", options: this._zoneOptions() } },
        },
        {
          name: "days",
          selector: {
            select: {
              multiple: true,
              mode: "list",
              options: DAYS.map((d, i) => ({ value: String(i), label: d.label })),
            },
          },
        },
        { name: "start", selector: { time: {} } },
        {
          name: "minutes",
          selector: { number: { min: 1, max: 180, step: 1, mode: "box", unit_of_measurement: "min" } },
        },
        { name: "enabled", selector: { boolean: {} } },
      ];
    }

    // Map a stored schedule to ha-form data (days as string indices, time full).
    _scheduleData(s) {
      return {
        name: s.name ?? "",
        zone: s.zone ?? this._zoneOptions()[0]?.value ?? "",
        days: (s.days || []).map((d) => String(d)),
        start: (s.start || DEFAULT_START).length === 5 ? `${s.start}:00` : s.start || `${DEFAULT_START}:00`,
        minutes: s.minutes ?? this._config.default_minutes ?? DEFAULT_MINUTES,
        enabled: s.enabled !== false,
      };
    }

    // Map ha-form data back to a stored schedule.
    _scheduleFromData(prev, v) {
      return {
        ...prev,
        id: prev.id || newScheduleId(),
        name: v.name,
        zone: v.zone,
        days: (v.days || []).map((d) => Number(d)).sort((a, b) => a - b),
        start: (v.start || DEFAULT_START).slice(0, 5),
        minutes: Number(v.minutes) > 0 ? Number(v.minutes) : (this._config.default_minutes ?? DEFAULT_MINUTES),
        enabled: v.enabled !== false,
      };
    }

    _label = (schema) =>
      ({
        title: "Card title",
        style: "Style",
        theme: "Theme",
        color_from: "Gradient from (hex)",
        color_to: "Gradient to (hex)",
        default_minutes: "Default run duration (new schedules)",
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
        entity: "Zone switch / valve entity",
        schedule: "Schedule helper (created by Set up helpers)",
        timer: "Timer helper (created by Set up helpers)",
        enable: "Zone enable (input_boolean, created by Set up helpers)",
        name: "Display name",
        icon: "Icon",
        zone: "Zone",
        days: "Days",
        start: "Start time",
        minutes: "Run duration",
        enabled: "Enabled",
      }[schema.name] || schema.name);

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
        default_minutes:
          "Seeds the run duration when you add a new schedule. Each schedule keeps its own duration after that — change it per schedule on the card face.",
        global_enable:
          "Master on/off for the whole programme. When off, nothing runs on schedule.",
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
        zone: "The physical zone this schedule waters. The same zone can appear in several schedules (e.g. a short weekday run and a long weekend soak).",
      }[schema.name];
    };

    _fire() {
      fireEvent(this, "config-changed", { config: this._config });
    }

    _slug(text) {
      return slugify(text);
    }

    /* ---------------------------------------- one-click helper setup */

    async _ensureHelper(domain, currentId, name, extra = {}) {
      const hass = this._hass;
      if (currentId && hass.states[currentId]) return currentId;
      const expected = `${domain}.${this._slug(name)}`;
      if (hass.states[expected]) return expected;
      const r = await hass.callWS({ type: `${domain}/create`, name, ...extra });
      return `${domain}.${r.id}`;
    }

    async _flowCreate(handler, steps) {
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
          const base =
            z.name || hass.states[z.entity]?.attributes?.friendly_name || `Zone ${i + 1}`;
          const patch = { ...z };
          patch.schedule = await this._ensureHelper("schedule", z.schedule, `Irrigation ${base} Schedule`, { icon: "mdi:calendar-clock" });
          patch.timer = await this._ensureHelper("timer", z.timer, `Irrigation ${base}`, { icon: DEFAULT_ICON, restore: true });
          patch.enable = await this._ensureHelper("input_boolean", z.enable, `Irrigation ${base} Scheduled`, { icon: "mdi:calendar-check" });
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

        // 3. rain measure: daily utility_meter + 48 h template sensor
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

        // 5. seed a schedule per zone if none defined yet, then persist config
        let schedules = [...(this._config.schedules || [])];
        if (!schedules.length) {
          schedules = newZones
            .filter((z) => z?.entity)
            .map((z, i) => ({
              id: newScheduleId(),
              name: z.name || hass.states[z.entity]?.attributes?.friendly_name || `Zone ${i + 1}`,
              zone: z.entity,
              days: [],
              start: DEFAULT_START,
              minutes: cfg.default_minutes ?? DEFAULT_MINUTES,
              enabled: false,
            }));
        }

        this._config = { ...cfg, zones: newZones, schedules };
        this._fire();
        say("Done — helpers and automations created. Add or edit schedules above, then enable the ones you want.");
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
        description: "Created by irrigation-schedule-card. Starts a zone when its schedule block begins, unless a skip condition is active. Overlapping runs on the same zone extend the timer instead of double-starting.",
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
          already_running: "{{ is_state(zone_switch, 'on') }}",
          timer_finishes: "{{ state_attr(zone_timer, 'finishes_at') }}",
          new_end_later: "{{ (not timer_finishes) or (block_end and as_timestamp(block_end) > as_timestamp(timer_finishes)) }}",
          rain48: "{{ states(" + JSON.stringify(cfg.rain_48h_sensor || "") + ") | float(-1) }}",
          skip_threshold: "{{ states(" + JSON.stringify(cfg.skip_48h_number || "") + ") | float(" + DEFAULT_SKIP_48H + ") }}",
          delay_until: "{{ state_attr(" + JSON.stringify(cfg.rain_delay || "") + ", 'timestamp') }}",
        },
        condition: [
          { condition: "state", entity_id: cfg.global_enable, state: "on" },
          { condition: "template", value_template: "{{ zone_enable == '' or is_state(zone_enable, 'on') }}" },
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
              {
                // Zone already running (an overlapping schedule): don't
                // double-start; extend the timer only if the new block ends
                // later than the current finish.
                conditions: [{ condition: "template", value_template: "{{ already_running }}" }],
                sequence: [
                  {
                    choose: [
                      {
                        conditions: [{ condition: "template", value_template: "{{ new_end_later }}" }],
                        sequence: [
                          { service: "timer.start", target: { entity_id: "{{ zone_timer }}" }, data: { duration: "{{ run_seconds | int }}" } },
                        ],
                      },
                    ],
                    default: [{ stop: "Already running longer — left as is" }],
                  },
                ],
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
      const schedules = this._config.schedules || [];
      const zonesNeedingSetup = zones.filter(
        (z) => z?.entity && !(z.schedule && z.timer && z.enable && this._hass?.states?.[z.schedule])
      ).length;
      const hasZone = zones.some((z) => z?.entity);

      this.shadowRoot.innerHTML = `
        <style>
          .wrap { display: flex; flex-direction: column; gap: 16px; }
          .section-title { font-size: 0.95rem; font-weight: 600; color: var(--primary-text-color); margin: 4px 0 -4px; }
          .section-sub { font-size: 0.8rem; color: var(--secondary-text-color); margin: -8px 0 0; }
          .box { border: 1px solid var(--divider-color); border-radius: 10px; padding: 12px; }
          .box-head { display: flex; align-items: center; margin-bottom: 8px; }
          .box-head span { flex: 1; font-weight: 600; font-size: 0.9rem; color: var(--primary-text-color); }
          .del { border: none; background: transparent; cursor: pointer; color: var(--secondary-text-color); padding: 4px; }
          .del:hover { color: var(--error-color, #db4437); }
          .add, .setup { border: 1px dashed var(--divider-color); border-radius: 10px; background: transparent; padding: 12px; cursor: pointer; color: var(--primary-color); font-weight: 600; font-size: 0.9rem; width: 100%; }
          .add:hover, .setup:hover { background: rgba(var(--rgb-primary-color, 33,150,243), 0.06); }
          .add:disabled { opacity: 0.5; cursor: default; }
          .setup { border-style: solid; }
          .setup.ready { border-color: var(--primary-color); }
          .hint { font-size: 0.8rem; color: var(--secondary-text-color); }
          .status { font-size: 0.8rem; color: var(--primary-color); min-height: 1em; }
        </style>
        <div class="wrap">
          <ha-form id="top"></ha-form>

          <div class="section-title">Zones in your system</div>
          <div class="section-sub">List each physical valve/switch once. “Set up helpers” makes the timer, schedule and enable helpers for them.</div>
          <div id="zones"></div>
          ${
            zones.length < MAX_ZONES
              ? `<button class="add" id="add-zone">＋ Add zone (${zones.length}/${MAX_ZONES})</button>`
              : `<div class="hint">Maximum of ${MAX_ZONES} zones reached.</div>`
          }
          <button class="setup ${zonesNeedingSetup ? "ready" : ""}" id="setup">
            ⚙ Set up helpers${zonesNeedingSetup ? ` (${zonesNeedingSetup} zone${zonesNeedingSetup === 1 ? "" : "s"} need helpers)` : " — re-run to update"}
          </button>
          <div class="status" id="setup-status"></div>

          <div class="section-title">Schedules</div>
          <div class="section-sub">Each schedule is one watering: a name, a zone, its days, a start time and a duration. Add as many as you like — the same zone can appear in several.</div>
          <div id="schedules"></div>
          ${
            hasZone
              ? `<button class="add" id="add-schedule" ${schedules.length >= MAX_SCHEDULES ? "disabled" : ""}>＋ Add schedule${schedules.length >= MAX_SCHEDULES ? " (max reached)" : ""}</button>`
              : `<div class="hint">Add a zone above first, then you can create schedules for it.</div>`
          }

          <div class="hint">
            “Set up helpers” creates one schedule / timer / enable helper per zone, the control
            helpers (global enable, skip-next, rain delay, thresholds), a daily rainfall utility
            meter + 48 h template sensor, and the dispatcher / rain-stop / safety automations — all
            server-side (admin required). Editing a schedule’s days, time or duration regenerates
            that zone’s helper from all its enabled schedules.
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
        const prevStyle = this._config.style;
        const prevDevice = this._config.device;
        this._config = {
          ...this._config,
          title: v.title,
          style: v.style,
          theme: v.theme,
          color_from: v.color_from,
          color_to: v.color_to,
          default_minutes: v.default_minutes,
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
        if (v.style !== prevStyle || v.device !== prevDevice) this._render();
      });

      // ---- zones list
      const zonesEl = this.shadowRoot.getElementById("zones");
      zonesEl.style.display = "flex";
      zonesEl.style.flexDirection = "column";
      zonesEl.style.gap = "12px";
      zones.forEach((zone, idx) => {
        const box = document.createElement("div");
        box.className = "box";
        box.innerHTML = `<div class="box-head"><span>Zone ${idx + 1}</span><button class="del" title="Remove zone">✕</button></div>`;
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
          const removed = this._config.zones[idx];
          const newZones = this._config.zones.filter((_, i) => i !== idx);
          // Drop schedules bound to a removed zone so nothing dangles.
          const newSchedules = (this._config.schedules || []).filter(
            (s) => s.zone !== removed?.entity
          );
          this._config = { ...this._config, zones: newZones, schedules: newSchedules };
          this._fire();
          this._render();
        });
        zonesEl.appendChild(box);
      });

      this.shadowRoot.getElementById("add-zone")?.addEventListener("click", () => {
        const newZones = [...this._config.zones, {}];
        this._config = { ...this._config, zones: newZones };
        this._fire();
        this._render();
      });

      // ---- schedules list
      const schedEl = this.shadowRoot.getElementById("schedules");
      schedEl.style.display = "flex";
      schedEl.style.flexDirection = "column";
      schedEl.style.gap = "12px";
      schedules.forEach((sched, idx) => {
        const box = document.createElement("div");
        box.className = "box";
        const nm = sched.name || `Schedule ${idx + 1}`;
        box.innerHTML = `<div class="box-head"><span>${nm}</span><button class="del" title="Delete schedule">✕</button></div>`;
        const form = document.createElement("ha-form");
        form.hass = this._hass;
        form.schema = this._scheduleSchema();
        form.data = this._scheduleData(sched);
        form.computeLabel = this._label;
        form.computeHelper = this._helper;
        form.addEventListener("value-changed", (ev) => {
          ev.stopPropagation();
          const newSchedules = [...this._config.schedules];
          newSchedules[idx] = this._scheduleFromData(newSchedules[idx] || {}, ev.detail.value);
          this._config = { ...this._config, schedules: newSchedules };
          this._fire();
        });
        box.appendChild(form);
        box.querySelector(".del").addEventListener("click", () => {
          const newSchedules = this._config.schedules.filter((_, i) => i !== idx);
          this._config = { ...this._config, schedules: newSchedules };
          this._fire();
          this._render();
        });
        schedEl.appendChild(box);
      });

      this.shadowRoot.getElementById("add-schedule")?.addEventListener("click", () => {
        const firstZone = this._config.zones.find((z) => z?.entity);
        const newSchedules = [
          ...(this._config.schedules || []),
          {
            id: newScheduleId(),
            name: firstZone
              ? this._hass?.states?.[firstZone.entity]?.attributes?.friendly_name ||
                firstZone.name ||
                "New schedule"
              : "New schedule",
            zone: firstZone?.entity || "",
            days: [],
            start: DEFAULT_START,
            minutes: this._config.default_minutes ?? DEFAULT_MINUTES,
            enabled: true,
          },
        ];
        this._config = { ...this._config, schedules: newSchedules };
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
      "Schedule-centric weekly irrigation planner with rain smarts — schedules are the first-class object (name, zone, days, time, duration, enable), the same zone can appear in several, plain-language summaries, rain-delay and skip controls, and one-click server-side setup.",
    preview: true,
    documentationURL: "https://github.com/mycrouch/irrigation-schedule-card",
  });

  console.info(
    `%c IRRIGATION-SCHEDULE-CARD %c v${VERSION} `,
    "background:#0f2f4a;color:#fff;padding:2px 6px;border-radius:4px 0 0 4px;",
    "background:#039be5;color:#fff;padding:2px 6px;border-radius:0 4px 4px 0;"
  );
})();
