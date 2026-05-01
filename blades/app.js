(() => {
  "use strict";

  const ROMAN = ["0", "I", "II", "III", "IV", "V", "VI"];
  const TAG_GROUP_ORDER = ["Domain", "Trade", "Wealth", "Legality", "Services"];

  let DATA = null;
  const TAG_TO_GROUP = {};
  const FACTION_BY_ID = {};
  const DISTRICT_BY_ID = {};
  let ALL_DISTRICT_IDS = [];

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
      f.districts = expandDistricts(f.districts || []);
      FACTION_BY_ID[f.id] = f;
    });
  }

  function expandDistricts(arr) {
    if (!arr.includes("*")) return arr.slice();
    const exclude = new Set(
      arr.filter(x => typeof x === "string" && x.startsWith("!")).map(x => x.slice(1))
    );
    return ALL_DISTRICT_IDS.filter(id => !exclude.has(id));
  }

  // ---------- Fuzzy scoring ----------

  // Higher is better. Returns -1 if not all query chars are matchable.
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

    // subsequence match
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

  function search(query) {
    if (!query.trim()) {
      return DATA.factions.slice().sort((a, b) => a.name.localeCompare(b.name));
    }
    return DATA.factions
      .map(f => ({ f, s: score(query, f.name) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s || a.f.name.localeCompare(b.f.name))
      .map(x => x.f);
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
    return el("a", { cls: "related-link", href: "#/faction/" + id, text: f.name });
  }

  function tierLabel(f) {
    const t = ROMAN[f.tier] != null ? ROMAN[f.tier] : String(f.tier);
    const hold = f.hold ? f.hold + " hold" : "—";
    return "Tier " + t + " · " + hold;
  }

  // ---------- Search view ----------

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
      const results = search(input.value);
      list.innerHTML = "";
      if (results.length === 0) {
        const li = el("li");
        li.appendChild(el("div", { cls: "empty-state", text: "No matches." }));
        list.appendChild(li);
        return;
      }
      const frag = document.createDocumentFragment();
      for (const f of results) {
        const li = el("li");
        const link = el("a", {
          cls: "result",
          href: "#/faction/" + f.id,
          children: [
            el("div", {
              cls: "result-row",
              children: [
                el("span", { cls: "result-name", text: f.name }),
                el("span", { cls: "result-meta", text: tierLabel(f) })
              ]
            }),
            f.summary ? el("span", { cls: "result-summary", text: f.summary }) : null
          ]
        });
        li.appendChild(link);
        frag.appendChild(li);
      }
      list.appendChild(frag);
    }

    input.addEventListener("input", update);
    update();

    // Auto-focus on desktop only — avoid pop-up keyboard surprise on mobile.
    if (window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
      setTimeout(() => input.focus(), 0);
    }
  }

  // ---------- Faction detail view ----------

  function renderFaction(id) {
    const app = document.getElementById("app");
    app.innerHTML = "";

    app.appendChild(el("a", { cls: "back-link", href: "#/", text: "← Search" }));

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

    renderTags(app, f);
    renderDistricts(app, f);
    renderNpcs(app, f);
    renderRelated(app, "Allies", f.allies);
    renderRelated(app, "Enemies", f.enemies);
    renderText(app, "Turf", f.turf);
    renderText(app, "Assets", f.assets);
    renderText(app, "Quirks", f.quirks);
    renderText(app, "Situation", f.situation);
    renderClocks(app, f.clocks);
    renderText(app, "Notes", f.notes);

    window.scrollTo(0, 0);
  }

  function renderTags(app, f) {
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
  }

  function tagRow(label, items) {
    const row = el("div", { cls: "tag-group" });
    row.appendChild(el("span", { cls: "tag-group-label", text: label }));
    for (const [name, w] of items) {
      const tag = el("span", { cls: "tag" });
      tag.appendChild(el("span", { text: name }));
      tag.appendChild(el("sup", { cls: "tag-weight", text: String(w) }));
      row.appendChild(tag);
    }
    return row;
  }

  function renderDistricts(app, f) {
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: "Districts" }));
    if (f.districts && f.districts.length) {
      const names = f.districts
        .map(id => (DISTRICT_BY_ID[id] && DISTRICT_BY_ID[id].name) || id);
      sec.appendChild(el("p", { text: names.join(", ") }));
    } else {
      sec.appendChild(el("p", { cls: "muted", text: "No fixed turf." }));
    }
    app.appendChild(sec);
  }

  function renderNpcs(app, f) {
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

  function renderRelated(app, label, ids) {
    if (!ids || !ids.length) return;
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: label }));
    const wrap = el("div", { cls: "related" });
    ids.forEach(id => wrap.appendChild(factionLink(id)));
    sec.appendChild(wrap);
    app.appendChild(sec);
  }

  function renderText(app, label, body) {
    if (!body) return;
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: label }));
    sec.appendChild(el("p", { text: body }));
    app.appendChild(sec);
  }

  function renderClocks(app, clocks) {
    if (!clocks || !clocks.length) return;
    const sec = el("section", { cls: "section" });
    sec.appendChild(el("h3", { cls: "section-h", text: "Clocks" }));
    const ul = el("ul");
    for (const c of clocks) {
      ul.appendChild(el("li", { text: c.name + " [" + c.size + "]" }));
    }
    sec.appendChild(ul);
    app.appendChild(sec);
  }

  // ---------- Routing ----------

  function route() {
    const hash = location.hash || "#/";
    const m = hash.match(/^#\/faction\/(.+)$/);
    if (m) {
      renderFaction(decodeURIComponent(m[1]));
    } else {
      renderSearch();
    }
  }

  // ---------- Init ----------

  load()
    .then(() => {
      window.addEventListener("hashchange", route);
      route();
    })
    .catch(err => {
      const app = document.getElementById("app");
      app.innerHTML = "";
      app.appendChild(el("div", { cls: "error", text: "Failed to load data: " + err.message }));
    });
})();
