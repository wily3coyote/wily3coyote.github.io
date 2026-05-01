(() => {
  "use strict";

  const ROMAN = ["0", "I", "II", "III", "IV", "V", "VI"];
  const TAG_GROUP_ORDER = ["Domain", "Trade", "Wealth", "Legality", "Services"];

  let DATA = null;
  const TAG_TO_GROUP = {};
  const FACTION_BY_ID = {};
  const DISTRICT_BY_ID = {};
  const FACTIONS_BY_DISTRICT_ID = {};
  let ALL_DISTRICT_IDS = [];
  let ALL_TIERS = [];
  let lastViewKey = null;
  let SHAPES_PROMISE = null; // lazy: only loaded when map view is opened
  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---------- Load & prep ----------

  async function load() {
    const res = await fetch("data/core.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    DATA = await res.json();

    DATA.districts.forEach(d => { DISTRICT_BY_ID[d.id] = d; });
    ALL_DISTRICT_IDS = DATA.districts.map(d => d.id);

    for (const group of Object.keys(DATA.tags)) {
      for (const t of DATA.tags[group]) TAG_TO_GROUP[t] = group;
    }

    DATA.factions.forEach(f => {
      const raw = f.districts || [];
      f.isCitywide = raw.includes("*");
      f.districts = expandDistricts(raw);
      FACTION_BY_ID[f.id] = f;
      for (const did of f.districts) {
        (FACTIONS_BY_DISTRICT_ID[did] = FACTIONS_BY_DISTRICT_ID[did] || []).push(f);
      }
    });

    ALL_TIERS = [...new Set(DATA.factions.map(f => f.tier).filter(t => t != null))]
      .sort((a, b) => a - b);
  }

  function expandDistricts(arr) {
    if (!arr.includes("*")) return arr.slice();
    const exclude = new Set(
      arr.filter(x => typeof x === "string" && x.startsWith("!")).map(x => x.slice(1))
    );
    return ALL_DISTRICT_IDS.filter(id => !exclude.has(id));
  }

  // ---------- Tag-browse selection ↔ hash ----------
  //
  // Hash shape: #/tags[/<tag-csv>][?tier=<tier-csv>]
  //   #/tags                          — no filters
  //   #/tags/Occult,Illegal           — tag filter only
  //   #/tags?tier=2,3                 — tier filter only
  //   #/tags/Criminal?tier=2,3        — both
  //
  // Tags use AND, tiers use OR within the row, the two combine with AND.

  function encodeBrowseHash(tags, tiers) {
    let h = "#/tags";
    if (tags && tags.length) {
      h += "/" + tags.slice().sort().map(encodeURIComponent).join(",");
    }
    if (tiers && tiers.length) {
      h += "?tier=" + tiers.slice().sort((a, b) => a - b).join(",");
    }
    return h;
  }

  function parseBrowseHash(rest) {
    // `rest` is whatever comes after "#/tags".
    const out = { tags: [], tiers: [] };
    if (!rest) return out;

    const qIdx = rest.indexOf("?");
    const pathPart = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    const queryPart = qIdx >= 0 ? rest.slice(qIdx + 1) : "";

    if (pathPart.startsWith("/")) {
      const csv = pathPart.slice(1);
      if (csv) out.tags = csv.split(",").map(decodeURIComponent).filter(Boolean);
    }

    if (queryPart) {
      for (const part of queryPart.split("&")) {
        const eq = part.indexOf("=");
        if (eq < 0) continue;
        const key = decodeURIComponent(part.slice(0, eq));
        const val = decodeURIComponent(part.slice(eq + 1));
        if (key === "tier" && val) {
          out.tiers = val.split(",")
            .map(s => parseInt(s, 10))
            .filter(n => !isNaN(n));
        }
      }
    }
    return out;
  }

  // ---------- Fuzzy name scoring ----------

  function score(query, target) {
    const q = query.toLowerCase().trim();
    const t = target.toLowerCase();
    if (!q) return 0;
    if (t === q) return 100000;
    if (t.startsWith(q)) return 50000 - t.length;

    const idx = t.indexOf(q);
    if (idx >= 0) {
      const wordStart = idx === 0 || t[idx - 1] === " ";
      return 20000 + (wordStart ? 5000 : 0) - idx * 10 - t.length;
    }

    let qi = 0, ti = 0, s = 0, prev = -2;
    while (qi < q.length && ti < t.length) {
      if (q[qi] === t[ti]) {
        s += (ti === prev + 1) ? 10 : 1;
        if (ti === 0 || t[ti - 1] === " ") s += 5;
        prev = ti;
        qi++;
      }
      ti++;
    }
    if (qi < q.length) return -1;
    return s;
  }

  function searchByName(query) {
    if (!query.trim()) {
      return DATA.factions.slice().sort(compareByName);
    }
    return DATA.factions
      .map(f => ({ f, s: score(query, f.name) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || compareByName(a.f, b.f))
      .map(x => x.f);
  }

  // ---------- Tag filter ----------

  // Tags: AND (faction must have every selected tag with weight ≥ 1).
  // Tiers: OR within the row (faction.tier ∈ selected tiers); empty = any tier.
  // Cross-row: AND.
  // Sort: sum(selected tag weights) desc, tier desc, name asc.
  // No tags selected → fall back to alphabetical (sum is 0 for everyone).
  function filterFactions(tags, tiers) {
    const tierSet = (tiers && tiers.length) ? new Set(tiers) : null;
    const matches = DATA.factions.filter(f => {
      if (tags.length && !(f.tags && tags.every(t => f.tags[t]))) return false;
      if (tierSet && !tierSet.has(f.tier)) return false;
      return true;
    });

    if (!tags.length) {
      return matches.sort(compareByName).map(f => ({ f, sum: 0 }));
    }
    return matches
      .map(f => ({ f, sum: tags.reduce((s, t) => s + (f.tags[t] || 0), 0) }))
      .sort((a, b) =>
        b.sum - a.sum ||
        (b.f.tier || 0) - (a.f.tier || 0) ||
        compareByName(a.f, b.f)
      );
  }

  // ---------- DOM helpers ----------

  function el(tag, opts) {
    const e = document.createElement(tag);
    if (opts == null) return e;
    if (typeof opts === "string") { e.textContent = opts; return e; }
    if (opts.text != null) e.textContent = opts.text;
    if (opts.cls) e.className = opts.cls;
    if (opts.href != null) e.setAttribute("href", opts.href);
    if (opts.attrs) for (const k in opts.attrs) e.setAttribute(k, opts.attrs[k]);
    if (opts.children) opts.children.forEach(c => { if (c) e.appendChild(c); });
    return e;
  }

  function factionLink(id) {
    const f = FACTION_BY_ID[id];
    if (!f) return el("span", { cls: "related-missing", text: id });
    const a = el("a", { cls: "related-link", href: "#/faction/" + id });
    a.appendChild(el("span", { cls: "related-name", text: f.name }));
    if (f.tier != null) {
      const tier = ROMAN[f.tier] != null ? ROMAN[f.tier] : String(f.tier);
      a.appendChild(el("span", { cls: "related-tier", text: " (Tier " + tier + ")" }));
    }
    return a;
  }

  function tierLabel(f) {
    const t = ROMAN[f.tier] != null ? ROMAN[f.tier] : String(f.tier);
    const hold = f.hold ? f.hold + " hold" : "—";
    return "Tier " + t + " · " + hold;
  }

  // Spec §4.1: ignore a leading "The " when sorting names.
  function nameSortKey(name) {
    return name.replace(/^the\s+/i, "");
  }
  function compareByName(a, b) {
    return nameSortKey(a.name).localeCompare(nameSortKey(b.name));
  }

  // Replace the URL state without adding a history entry, then re-route.
  // Used for tag-chip toggles so back-from-detail returns to the latest
  // selection rather than walking through every chip toggle.
  function replaceAndRoute(href) {
    history.replaceState(null, "", href);
    route();
  }

  // History-aware back link. If the user has history to go back to (the
  // common case — they came from a list or another detail page), use that.
  // Otherwise (deep-link / refresh) fall through to the fallback href.
  function backLink(fallbackHref, label) {
    const a = el("a", { cls: "back-link", href: fallbackHref, text: "← " + label });
    a.addEventListener("click", e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
      if (history.length > 1) {
        e.preventDefault();
        history.back();
      }
    });
    return a;
  }

  function plainResultRow(f, matchingTags) {
    const link = el("a", { cls: "result", href: "#/faction/" + f.id });
    const row = el("div", { cls: "result-row" });
    row.appendChild(el("span", { cls: "result-name", text: f.name }));
    row.appendChild(el("span", { cls: "result-meta", text: tierLabel(f) }));
    link.appendChild(row);

    if (matchingTags && matchingTags.length) {
      const wrap = el("div", { cls: "result-matching" });
      const sorted = matchingTags.slice().sort(
        (a, b) => (f.tags[b] || 0) - (f.tags[a] || 0) || a.localeCompare(b)
      );
      for (const t of sorted) {
        const tagSpan = el("span", { cls: "result-tag" });
        tagSpan.appendChild(el("span", { text: t }));
        tagSpan.appendChild(el("sup", { cls: "tag-weight", text: String(f.tags[t] || 0) }));
        wrap.appendChild(tagSpan);
      }
      link.appendChild(wrap);
    }

    if (f.summary) link.appendChild(el("span", { cls: "result-summary", text: f.summary }));
    const li = el("li");
    li.appendChild(link);
    return li;
  }

  // ---------- Map view ----------

  function loadShapes() {
    if (!SHAPES_PROMISE) {
      SHAPES_PROMISE = fetch("data/districts-shape.json")
        .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
    }
    return SHAPES_PROMISE;
  }

  function renderMap() {
    const app = document.getElementById("app");
    app.innerHTML = "";

    const wrap = el("div", { cls: "map-wrap" });
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "map-svg");
    svg.setAttribute("viewBox", "0 0 1017 1546");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-label", "Doskvol districts map");

    const img = document.createElementNS(SVG_NS, "image");
    img.setAttribute("href", "data/map.png");
    img.setAttribute("width", "1017");
    img.setAttribute("height", "1546");
    img.setAttribute("preserveAspectRatio", "none");
    svg.appendChild(img);

    const overlay = document.createElementNS(SVG_NS, "g");
    overlay.setAttribute("class", "map-overlay");
    svg.appendChild(overlay);

    wrap.appendChild(svg);
    app.appendChild(wrap);

    const districtsLink = el("a", {
      cls: "map-districts-link",
      href: "#/districts",
      text: "Districts"
    });
    app.appendChild(districtsLink);

    loadShapes()
      .then(shapes => {
        for (const [id, shape] of Object.entries(shapes)) {
          if (!shape || !Array.isArray(shape.points) || shape.points.length < 3) continue;
          const d = DISTRICT_BY_ID[id];
          const region = document.createElementNS(SVG_NS, "g");
          region.setAttribute("class", "map-region");
          region.setAttribute("tabindex", "0");
          region.setAttribute("role", "link");
          region.setAttribute("aria-label", d ? d.name : id);

          const poly = document.createElementNS(SVG_NS, "polygon");
          poly.setAttribute("points", shape.points.map(p => p.join(",")).join(" "));
          poly.setAttribute("class", "map-poly");
          poly.setAttribute("vector-effect", "non-scaling-stroke");
          // Defensive defaults so the map shows through even if CSS is stale.
          poly.setAttribute("fill-opacity", "0");
          region.appendChild(poly);

          let cx = 0, cy = 0;
          for (const [x, y] of shape.points) { cx += x; cy += y; }
          cx /= shape.points.length; cy /= shape.points.length;
          const text = document.createElementNS(SVG_NS, "text");
          text.setAttribute("x", cx);
          text.setAttribute("y", cy);
          text.setAttribute("class", "map-label");
          text.setAttribute("display", "none"); // hover toggles to "inline" via CSS
          text.textContent = d ? d.name : id;
          region.appendChild(text);

          const go = () => { location.hash = "#/district/" + id; };
          region.addEventListener("click", go);
          region.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
          });
          overlay.appendChild(region);
        }
      })
      .catch(err => {
        const note = el("div", { cls: "map-error", text: "Couldn't load district shapes: " + err.message });
        wrap.appendChild(note);
      });
  }

  // ---------- Name search view ----------

  function renderSearch() {
    const app = document.getElementById("app");
    app.innerHTML = "";

    const input = el("input", {
      cls: "search-input",
      attrs: {
        type: "search",
        placeholder: "Search factions…",
        autocomplete: "off",
        autocapitalize: "none",
        autocorrect: "off",
        spellcheck: "false",
        "aria-label": "Search factions"
      }
    });
    app.appendChild(input);

    const list = el("ul", { cls: "results" });
    app.appendChild(list);

    function update() {
      const results = searchByName(input.value);
      list.innerHTML = "";
      if (!results.length) {
        const li = el("li");
        li.appendChild(el("div", { cls: "empty-state", text: "No matches." }));
        list.appendChild(li);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const f of results) frag.appendChild(plainResultRow(f, null));
      list.appendChild(frag);
    }

    input.addEventListener("input", update);
    update();

    if (window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      setTimeout(() => input.focus(), 0);
    }
  }

  // ---------- Tag browse view ----------

  function renderTags(state) {
    const app = document.getElementById("app");
    app.innerHTML = "";

    const tags = state.tags || [];
    const tiers = state.tiers || [];
    const tagSet = new Set(tags);
    const tierSet = new Set(tiers);
    const totalActive = tagSet.size + tierSet.size;

    // Status / clear
    const status = el("div", { cls: "tag-status" });
    if (totalActive > 0) {
      const parts = [];
      if (tagSet.size) parts.push(tagSet.size + " tag" + (tagSet.size === 1 ? "" : "s"));
      if (tierSet.size) parts.push(tierSet.size + " tier" + (tierSet.size === 1 ? "" : "s"));
      status.appendChild(el("span", { cls: "tag-status-count", text: parts.join(" · ") }));
      const clear = el("a", { cls: "tag-clear", href: "#/tags", text: "Clear" });
      clear.addEventListener("click", e => { e.preventDefault(); replaceAndRoute("#/tags"); });
      status.appendChild(clear);
    } else {
      status.appendChild(el("span", {
        cls: "tag-status-msg",
        text: "Tap chips to filter. Tags combine with AND, tiers with OR."
      }));
    }
    app.appendChild(status);

    // Tag chip rows by group
    for (const group of TAG_GROUP_ORDER) {
      if (!DATA.tags[group]) continue;
      app.appendChild(buildChipRow({
        label: group,
        items: DATA.tags[group],
        isOn: tag => tagSet.has(tag),
        toHref: tag => {
          const next = new Set(tagSet);
          if (next.has(tag)) next.delete(tag); else next.add(tag);
          return encodeBrowseHash([...next], tiers);
        }
      }));
    }

    // Tier chip row
    app.appendChild(buildChipRow({
      label: "Tier",
      items: ALL_TIERS,
      labelFor: t => ROMAN[t] != null ? ROMAN[t] : String(t),
      isOn: t => tierSet.has(t),
      toHref: t => {
        const next = new Set(tierSet);
        if (next.has(t)) next.delete(t); else next.add(t);
        return encodeBrowseHash(tags, [...next]);
      }
    }));

    // Results
    const results = filterFactions(tags, tiers);
    const headerText = results.length + " " + (results.length === 1 ? "faction" : "factions")
      + (totalActive ? " match" + (results.length === 1 ? "es" : "") + " filters" : " (no filter)");
    app.appendChild(el("div", { cls: "results-header", text: headerText }));

    const list = el("ul", { cls: "results" });
    if (!results.length) {
      const li = el("li");
      li.appendChild(el("div", { cls: "empty-state", text: "No factions match these filters." }));
      list.appendChild(li);
    } else {
      const frag = document.createDocumentFragment();
      for (const { f } of results) {
        frag.appendChild(plainResultRow(f, tagSet.size ? tags : null));
      }
      list.appendChild(frag);
    }
    app.appendChild(list);
  }

  function buildChipRow({ label, items, isOn, toHref, labelFor }) {
    const row = el("div", { cls: "chip-row" });
    row.appendChild(el("span", { cls: "chip-row-label", text: label }));
    for (const item of items) {
      const on = isOn(item);
      const href = toHref(item);
      const chip = el("a", {
        cls: "chip" + (on ? " chip-on" : ""),
        href: href,
        text: labelFor ? labelFor(item) : item,
        attrs: { "aria-pressed": on ? "true" : "false" }
      });
      chip.addEventListener("click", e => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        replaceAndRoute(href);
      });
      row.appendChild(chip);
    }
    return row;
  }

  // ---------- Faction detail view ----------

  function renderFaction(id) {
    const app = document.getElementById("app");
    app.innerHTML = "";

    app.appendChild(backLink("#/", "Back"));

    const f = FACTION_BY_ID[id];
    if (!f) {
      app.appendChild(el("div", { cls: "error", text: "Faction not found: " + id }));
      return;
    }

    const header = el("div", { cls: "faction-header" });
    header.appendChild(el("h2", { cls: "faction-name", text: f.name }));
    header.appendChild(el("div", { cls: "faction-meta", text: tierLabel(f) }));
    app.appendChild(header);

    if (f.summary) app.appendChild(el("p", { cls: "faction-summary", text: f.summary }));

    renderTagsSection(app, f);
    renderDistrictsSection(app, f);
    renderNpcsSection(app, f);
    renderRelatedSection(app, "Allies", f.allies);
    renderRelatedSection(app, "Enemies", f.enemies);
    renderTextSection(app, "Turf", f.turf);
    renderTextSection(app, "Assets", f.assets);
    renderTextSection(app, "Quirks", f.quirks);
    renderTextSection(app, "Situation", f.situation);
    renderClocksSection(app, f.clocks);
    renderTextSection(app, "Notes", f.notes);
  }

  function renderTagsSection(app, f) {
    if (!f.tags || !Object.keys(f.tags).length) return;
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: "Tags" }));

    const grouped = {};
    const other = [];
    for (const [name, weight] of Object.entries(f.tags)) {
      const group = TAG_TO_GROUP[name];
      if (group) (grouped[group] = grouped[group] || []).push([name, weight]);
      else other.push([name, weight]);
    }

    for (const group of TAG_GROUP_ORDER) {
      if (!grouped[group]) continue;
      grouped[group].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      sec.appendChild(tagRow(group, grouped[group]));
    }
    if (other.length) {
      other.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      sec.appendChild(tagRow("Other", other));
    }
    app.appendChild(sec);

    // Post-mount: any row whose chips wrapped below the label gets a class
    // that promotes the label to its own line. Reads offsetTop, which forces
    // synchronous layout — fine on a page this small.
    for (const row of sec.querySelectorAll(".tag-group")) applyTagGroupWrap(row);
  }

  function applyTagGroupWrap(rowEl) {
    const label = rowEl.querySelector(".tag-group-label");
    if (!label) return;
    rowEl.classList.remove("tag-group-wrap");
    const labelTop = label.offsetTop;
    for (const c of rowEl.querySelectorAll(".tag")) {
      if (c.offsetTop > labelTop) {
        rowEl.classList.add("tag-group-wrap");
        return;
      }
    }
  }

  function tagRow(label, items) {
    const row = el("div", { cls: "tag-group" });
    row.appendChild(el("span", { cls: "tag-group-label", text: label }));
    for (const [name, w] of items) {
      const tag = el("a", {
        cls: "tag",
        href: encodeBrowseHash([name], []),
        attrs: { "aria-label": "Filter by " + name }
      });
      tag.appendChild(el("span", { text: name }));
      tag.appendChild(el("sup", { cls: "tag-weight", text: String(w) }));
      row.appendChild(tag);
    }
    return row;
  }

  function renderDistrictsSection(app, f) {
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: "Districts" }));
    if (f.districts && f.districts.length) {
      const wrap = el("div", { cls: "related" });
      for (const id of f.districts) {
        const d = DISTRICT_BY_ID[id];
        const a = el("a", { cls: "related-link", href: "#/district/" + id });
        a.appendChild(el("span", { cls: "related-name", text: d ? d.name : id }));
        wrap.appendChild(a);
      }
      sec.appendChild(wrap);
    } else {
      sec.appendChild(el("p", { cls: "muted", text: "No fixed turf." }));
    }
    app.appendChild(sec);
  }

  function renderNpcsSection(app, f) {
    if (!f.npcs || !f.npcs.length) return;
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: "Notable NPCs" }));
    const ul = el("ul", { cls: "npcs" });
    for (const n of f.npcs) {
      const li = el("li", { cls: "npc" });
      li.appendChild(el("span", { cls: "npc-name", text: n.name }));
      if (n.role) {
        li.appendChild(document.createTextNode(" — "));
        li.appendChild(el("span", { cls: "npc-role", text: n.role }));
      }
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    app.appendChild(sec);
  }

  function renderRelatedSection(app, label, ids) {
    if (!ids || !ids.length) return;
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: label }));
    const wrap = el("div", { cls: "related" });
    ids.forEach(id => wrap.appendChild(factionLink(id)));
    sec.appendChild(wrap);
    app.appendChild(sec);
  }

  function renderTextSection(app, label, body) {
    if (!body) return;
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: label }));
    sec.appendChild(el("p", { text: body }));
    app.appendChild(sec);
  }

  function renderClocksSection(app, clocks) {
    if (!clocks || !clocks.length) return;
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: "Clocks" }));
    const ul = el("ul");
    for (const c of clocks) ul.appendChild(el("li", { text: c.name + " [" + c.size + "]" }));
    sec.appendChild(ul);
    app.appendChild(sec);
  }

  // ---------- District views ----------

  function renderDistrictList() {
    const app = document.getElementById("app");
    app.innerHTML = "";

    const sorted = DATA.districts.slice().sort(compareByName);
    const list = el("ul", { cls: "results" });
    for (const d of sorted) {
      const link = el("a", { cls: "result", href: "#/district/" + d.id });
      const row = el("div", { cls: "result-row" });
      row.appendChild(el("span", { cls: "result-name", text: d.name }));
      const count = (FACTIONS_BY_DISTRICT_ID[d.id] || []).length;
      row.appendChild(el("span", {
        cls: "result-meta",
        text: count + " " + (count === 1 ? "faction" : "factions")
      }));
      link.appendChild(row);
      if (d.summary) link.appendChild(el("span", { cls: "result-summary", text: d.summary }));
      const li = el("li");
      li.appendChild(link);
      list.appendChild(li);
    }
    app.appendChild(list);
  }

  function renderDistrict(id) {
    const app = document.getElementById("app");
    app.innerHTML = "";

    app.appendChild(backLink("#/districts", "Districts"));

    const d = DISTRICT_BY_ID[id];
    if (!d) {
      app.appendChild(el("div", { cls: "error", text: "District not found: " + id }));
      return;
    }

    const header = el("div", { cls: "faction-header" });
    header.appendChild(el("h2", { cls: "faction-name", text: d.name }));
    if (d.tier != null) {
      header.appendChild(el("div", { cls: "faction-meta", text: tierLabel(d) }));
    }
    app.appendChild(header);

    if (d.summary) app.appendChild(el("p", { cls: "faction-summary", text: d.summary }));

    if (d.notable_locations && d.notable_locations.length) {
      const sec = el("section", { cls: "section" });
      sec.appendChild(el("h3", { cls: "section-h", text: "Notable locations" }));
      sec.appendChild(el("p", { text: d.notable_locations.join(", ") }));
      app.appendChild(sec);
    }

    if (d.notes) {
      const sec = el("section", { cls: "section" });
      sec.appendChild(el("h3", { cls: "section-h", text: "Notes" }));
      sec.appendChild(el("p", { text: d.notes }));
      app.appendChild(sec);
    }

    const sortFactions = arr => arr.slice().sort(
      (a, b) => (b.tier || 0) - (a.tier || 0) || compareByName(a, b)
    );
    const all = FACTIONS_BY_DISTRICT_ID[id] || [];
    const specific = sortFactions(all.filter(f => !f.isCitywide));
    const citywide = sortFactions(all.filter(f => f.isCitywide));

    const specSec = el("section", { cls: "section" });
    specSec.appendChild(el("h3", {
      cls: "section-h",
      text: "Factions operating here (" + specific.length + ")"
    }));
    if (!specific.length) {
      specSec.appendChild(el("p", {
        cls: "muted",
        text: "No factions specifically claim turf here."
      }));
    } else {
      const ul = el("ul", { cls: "results" });
      for (const f of specific) ul.appendChild(plainResultRow(f, null));
      specSec.appendChild(ul);
    }
    app.appendChild(specSec);

    if (citywide.length) {
      const det = el("details", { cls: "section section-collapsible" });
      const sum = el("summary", {
        cls: "section-h section-h-toggle",
        text: "Citywide factions also present (" + citywide.length + ")"
      });
      det.appendChild(sum);
      const ul = el("ul", { cls: "results" });
      for (const f of citywide) ul.appendChild(plainResultRow(f, null));
      det.appendChild(ul);
      app.appendChild(det);
    }
  }

  // ---------- Routing & nav ----------

  function viewKeyFromHash(hash) {
    if (hash.startsWith("#/faction/")) return "faction";
    if (hash === "#/tags" || hash.startsWith("#/tags/") || hash.startsWith("#/tags?")) return "tags";
    if (hash === "#/districts" || hash.startsWith("#/district/")) return "districts";
    if (hash === "#/name") return "name";
    return "map";
  }

  function updateNav(viewKey) {
    document.querySelectorAll(".nav-item").forEach(a => {
      const r = a.getAttribute("data-route");
      a.classList.toggle("active", r === viewKey);
    });
  }

  function route() {
    const hash = location.hash || "#/";
    const viewKey = viewKeyFromHash(hash);

    let m;
    if ((m = hash.match(/^#\/faction\/(.+)$/))) {
      renderFaction(decodeURIComponent(m[1]));
    } else if ((m = hash.match(/^#\/district\/(.+)$/))) {
      renderDistrict(decodeURIComponent(m[1]));
    } else if (hash === "#/districts") {
      renderDistrictList();
    } else if (hash === "#/tags" || hash.startsWith("#/tags/") || hash.startsWith("#/tags?")) {
      renderTags(parseBrowseHash(hash.slice("#/tags".length)));
    } else if (hash === "#/name") {
      renderSearch();
    } else {
      renderMap();
    }

    // Scroll to top on view change or whenever we land on a new detail page.
    const isDetail = viewKey === "faction" || hash.startsWith("#/district/");
    if (isDetail || viewKey !== lastViewKey) window.scrollTo(0, 0);
    lastViewKey = viewKey;

    // Faction and district detail aren't tied to a tab; everything else highlights its tab.
    updateNav(viewKey === "faction" || viewKey === "districts" ? null : viewKey);
  }

  // ---------- Init ----------

  load()
    .then(() => {
      window.addEventListener("hashchange", route);
      // Re-evaluate tag-group wrap on viewport changes (rotate, devtools resize).
      // No-op when not currently on a faction page (selector finds nothing).
      window.addEventListener("resize", () => {
        for (const row of document.querySelectorAll(".tag-group")) applyTagGroupWrap(row);
      });
      route();
    })
    .catch(err => {
      const app = document.getElementById("app");
      app.innerHTML = "";
      app.appendChild(el("div", { cls: "error", text: "Failed to load data: " + err.message }));
    });
})();
