// Projects: saved space layouts (tabs, split panes, a command per pane) and
// profiles (several projects started together). cmd-o opens it.
// List: type to filter, ↑/↓, Enter opens, tab switches projects/profiles,
// cmd-n new, cmd-e edit, cmd-backspace delete (twice). Editors: cmd-s saves, Esc goes back.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, h_resizable, v_resizable, resizable_panel } from "gpui-base";
import { theme, props, closeOverlay, readTextFile, writeTextFile, appHome, pickFolder, notify, nextCommand } from "herdr";
import { expand, layoutOf, uid, launch, hdo, herdr } from "./launch.js";

const FILE = () => `${appHome()}/data/projects.json`;
const LOADING = "Opening…"; // the loading tab's name
// The pane canvas: fixed, so split sizes come out of the ratios exactly. Fits mod.json's width.
const CANVAS = { w: 740, h: 440 };
const MIN = 28; // smallest pane in the canvas, px

const leaves = (n) => (n.split ? [...leaves(n.a), ...leaves(n.b)] : [n]);
const replace = (n, id, fn) => (n.id === id ? fn(n) : n.split ? { ...n, a: replace(n.a, id, fn), b: replace(n.b, id, fn) } : n);
// Splits get new ids so their resizable groups start again from the ratios.
const fresh = (n) => (n.split ? { ...n, id: uid(), a: fresh(n.a), b: fresh(n.b) } : n);
const drop = (n, id) => (!n.split ? n : n.a.id === id ? fresh(n.b) : n.b.id === id ? fresh(n.a) : { ...n, a: drop(n.a, id), b: drop(n.b, id) });
const tilde = (dir) => (dir.startsWith(expand("~")) ? "~" + dir.slice(expand("~").length) : dir);

export default class Projects extends View {
  init(_props, cx) {
    // Mounted as the new space's loading tab (see open()): build, then close this tab.
    if (props()?.launch) {
      this.job = props().launch;
      cx.spawn(async (cx) => {
        const errors = await launch(this.job, cx);
        if (errors.length) notify({ title: "Projects", body: errors.join("\n"), level: "error" });
        const space = ((await herdr("ls")).spaces ?? []).find((s) => s.id === this.job.first.space);
        const me = space?.tabs.find((t) => t.name === LOADING && !t.terminals?.length);
        if (me) await hdo("tab.close", { id: me.id, confirmed: true });
      });
      return;
    }
    this.data = { projects: [], profiles: [] };
    this.raw = null; // file text as last read/written (writeTextFile's stale check)
    this.mode = "projects";
    this.view = "list";
    this.at = 0;
    this.armed = null; // id waiting for a second delete
    this.busy = false;
    this.n = 0; // element id counter for editor rows
    this.filter = InputState.new({ placeholder: "Filter by name…" });
    this.filter.on("change", (_e, cx) => { this.at = 0; this.armed = null; cx.notify(); });
    this.filter.on("submit", (_e, cx) => this.open(this.items()[this.at], cx));
    this.filter.focus();
    cx.timer.after(300, () => this.view === "list" && this.filter.focus());
    cx.spawn(async (cx) => {
      this.raw = await readTextFile(FILE());
      if (this.raw) {
        try { this.data = { projects: [], profiles: [], ...JSON.parse(this.raw) }; } catch (e) { this.error = `projects.json: ${e.message}`; }
      }
      cx.notify();
    });
    // cmd-n is global space.new; keys.json's "mod:projects" section sends it here instead.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new" && this.view === "list") this.edit(null, cx);
        cx.notify();
      }
    });
  }

  close() { closeOverlay(props().overlay); }

  async save() {
    const text = JSON.stringify(this.data, null, 2) + "\n";
    try {
      await writeTextFile(FILE(), text, this.raw);
      this.raw = text;
    } catch (e) {
      notify({ title: "Projects", body: `Not saved (file changed on disk?): ${e.message ?? e}`, level: "error" });
    }
  }

  // ---- list ---------------------------------------------------------------

  items() {
    const f = this.filter.value().toLowerCase();
    return this.data[this.mode].filter((x) => x.name.toLowerCase().includes(f));
  }

  // The dialog makes the first space and a loading tab running this mod, then
  // closes; the loading tab builds the rest (a dialog's work stops when it closes).
  open(item, cx) {
    if (!item || this.busy) return;
    const projects = this.mode === "projects" ? [item] : item.projects.map((id) => this.data.projects.find((p) => p.id === id)).filter(Boolean);
    if (!projects.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const p = projects[0];
        const first = await hdo("space.new", { name: p.name, folder: expand(p.folder), tab: p.tabs?.[0]?.name });
        await hdo("tab.new", { space: first.space, name: LOADING, mod: "projects", props: { launch: { projects, vp: this.vp, first } } });
        this.close();
      } catch (e) {
        notify({ title: "Projects", body: `${item.name}: ${e.message ?? e}`, level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  remove(item, cx) {
    if (this.armed !== item.id) { this.armed = item.id; cx.notify(); return; }
    this.armed = null;
    this.data[this.mode] = this.data[this.mode].filter((x) => x !== item);
    if (this.mode === "projects") for (const pf of this.data.profiles) pf.projects = pf.projects.filter((id) => id !== item.id);
    this.at = Math.max(0, Math.min(this.at, this.items().length - 1));
    cx.spawn(async (cx) => { await this.save(); cx.notify(); });
    cx.notify();
  }

  edit(item, cx) {
    this.armed = null;
    if (this.mode === "projects") this.editProject(item);
    else this.editProfile(item);
    cx.notify();
  }

  // ---- project editor -----------------------------------------------------

  input(value, placeholder) {
    return InputState.new({ value: value ?? "", placeholder });
  }

  leafForm(l = {}) {
    return { id: l.id ?? uid(), cmd: this.input(l.command, "command (empty: just a shell)"), dir: this.input(l.dir, "project folder") };
  }

  tabForm(t = { name: "" }) {
    const form = (n) => (n.split ? { id: n.id ?? uid(), split: n.split, ratio: n.ratio ?? 0.5, a: form(n.a), b: form(n.b) } : this.leafForm(n));
    const layout = form(layoutOf(t));
    return { key: ++this.n, name: this.input(t.name, "Tab name"), layout, sel: leaves(layout)[0].id };
  }

  editProject(p) {
    p ??= { id: null, name: "", folder: "", tabs: [{ name: "" }] };
    this.form = {
      id: p.id,
      name: this.input(p.name, "My project"),
      folder: this.input(p.folder, "~/Projects/my-project"),
      apps: this.input((p.apps ?? []).join(", "), "Herdr mods to open, e.g. gitview-tab"),
      tabs: p.tabs.map((t) => this.tabForm(t)),
      tab: 0,
    };
    this.view = "project";
    this.form.name.focus();
  }

  saveProject(cx) {
    const f = this.form;
    const name = f.name.value().trim();
    if (!name) { this.formError = "Name is required"; cx.notify(); return; }
    const toData = (n) => (n.split
      ? { id: n.id, split: n.split, ratio: Math.round(n.ratio * 1000) / 1000, a: toData(n.a), b: toData(n.b) }
      : { id: n.id, command: n.cmd.value().trim(), dir: n.dir.value().trim() });
    const project = {
      id: f.id ?? uid(),
      name,
      folder: f.folder.value().trim(),
      tabs: f.tabs.map((t) => ({ name: t.name.value().trim(), layout: toData(t.layout) })),
      apps: f.apps.value().split(/[\s,]+/).filter(Boolean),
    };
    const list = this.data.projects;
    const i = list.findIndex((x) => x.id === project.id);
    if (i >= 0) list[i] = project; else list.push(project);
    this.back(cx);
    cx.spawn(async (cx) => { await this.save(); cx.notify(); });
  }

  // ---- profile editor -----------------------------------------------------

  editProfile(pf) {
    pf ??= { id: null, name: "", projects: [] };
    this.form = { id: pf.id, name: this.input(pf.name, "My profile"), picks: [...pf.projects] };
    this.view = "profile";
    this.form.name.focus();
  }

  saveProfile(cx) {
    const f = this.form;
    const name = f.name.value().trim();
    if (!name) { this.formError = "Name is required"; cx.notify(); return; }
    if (!f.picks.length) { this.formError = "Pick at least one project"; cx.notify(); return; }
    const profile = { id: f.id ?? uid(), name, projects: f.picks };
    const list = this.data.profiles;
    const i = list.findIndex((x) => x.id === profile.id);
    if (i >= 0) list[i] = profile; else list.push(profile);
    this.back(cx);
    cx.spawn(async (cx) => { await this.save(); cx.notify(); });
  }

  back(cx) {
    this.view = "list";
    this.form = null;
    this.formError = null;
    this.filter.focus();
    cx.notify();
  }

  // ---- render -------------------------------------------------------------

  render() {
    const t = theme();
    if (this.job) return this.renderLoading(t);
    try { this.vp = globalThis.window?.viewport_size?.(); } catch {}
    const body = this.view === "list" ? this.renderList(t) : this.view === "project" ? this.renderProject(t) : this.renderProfile(t);
    return v_flex()
      .id("projects")
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .on_key_down((e, cx) => this.key(e, cx))
      .children(body);
  }

  renderLoading(t) {
    const names = this.job.projects.map((p) => p.name).join(", ");
    return v_flex().size_full().items_center().justify_center().gap(14).bg(t.background).text_color(t.foreground)
      .child(div().text_size(56).text_color(t.accent).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80).child("⠋"))
      .child(div().text_size(15).font_semibold().child(`Opening ${names}`))
      .child(div().text_size(12).text_color(t.dim).child("Building tabs and panes, starting commands…"));
  }

  key(e, cx) {
    const k = e.key;
    const cmd = e.modifiers?.platform || e.modifiers?.command;
    if (this.view !== "list") {
      if (k === "escape") this.back(cx);
      else if (cmd && k === "s") this.view === "project" ? this.saveProject(cx) : this.saveProfile(cx);
      else return;
      cx.stop_propagation();
      return;
    }
    const items = this.items();
    // closing mid-launch cancels it (the launch is this dialog's task)
    if (k === "escape") { this.close(); cx.stop_propagation(); return; }
    if (k === "down") this.at = Math.min(items.length - 1, this.at + 1);
    else if (k === "up") this.at = Math.max(0, this.at - 1);
    else if (k === "tab") { this.mode = this.mode === "projects" ? "profiles" : "projects"; this.at = 0; this.armed = null; }
    else if (cmd && k === "n") this.edit(null, cx);
    else if (cmd && k === "e") { if (items[this.at]) this.edit(items[this.at], cx); }
    else if (cmd && k === "backspace") { if (items[this.at]) this.remove(items[this.at], cx); }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  btn(t, id, label, onClick, { primary = false, danger = false } = {}) {
    return div()
      .id(id)
      .px(10)
      .py(4)
      .rounded(6)
      .text_size(12)
      .cursor_pointer()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(danger ? t.blocked : t.muted))
      .hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover).text_color(danger ? t.blocked : t.foreground)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  // grow: fill a row's width (flex_1 in a column would stretch it tall instead)
  field(t, state, grow = true) {
    return h_flex().h(32).flex_none().when(grow, (el) => el.flex_1()).px(10).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .child(Input.new(state).flex_1().h_full().text_size(12.8).text_color(t.foreground));
  }

  header(t, title, right) {
    return h_flex().items_center().gap(8)
      .child(div().flex_1().text_size(15).font_semibold().child(title))
      .children(right ?? [])
      .child(div().id("pj-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => (this.view === "list" ? this.close() : this.back(cx)))
        .child("Esc"));
  }

  renderList(t) {
    const items = this.items();
    this.at = Math.max(0, Math.min(this.at, items.length - 1));
    const tabBtn = (mode, label) => div().id(`pj-mode-${mode}`).px(10).py(4).rounded(6).cursor_pointer()
      .text_color(this.mode === mode ? t.foreground : t.dim)
      .when(this.mode === mode, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.mode = mode; this.at = 0; this.armed = null; this.filter.focus(); cx.notify(); })
      .child(label);
    const summary = (x) => this.mode === "projects"
      ? `${x.tabs.length} tab${x.tabs.length === 1 ? "" : "s"} · ${x.folder || "no folder"}`
      : x.projects.map((id) => this.data.projects.find((p) => p.id === id)?.name).filter(Boolean).join(", ");
    const row = (x, i) => h_flex()
      .id(`pj-row-${x.id}`)
      .px(10)
      .h(44)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(i === this.at, (el) => el.bg(t.hover))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.at = i; this.open(x, cx); })
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().font_semibold().child(x.name))
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(summary(x))))
      .child(this.btn(t, `pj-edit-${x.id}`, "Edit", (cx) => this.edit(x, cx)))
      .child(this.btn(t, `pj-del-${x.id}`, this.armed === x.id ? "Confirm delete" : "Delete", (cx) => this.remove(x, cx), { danger: true }));
    const empty = div().p(12).text_color(t.dim).child(this.data[this.mode].length ? "Nothing matches." : this.mode === "projects" ? "No projects yet: cmd-n to add one." : "No profiles yet: cmd-n to group projects.");
    return [
      this.header(t, "Projects", [tabBtn("projects", "Projects"), tabBtn("profiles", "Profiles"), this.btn(t, "pj-new", this.mode === "projects" ? "New project" : "New profile", (cx) => this.edit(null, cx), { primary: true })]),
      this.field(t, this.filter, false),
      this.error ? div().text_color(t.blocked).child(this.error) : null,
      v_flex().id("pj-list").flex_1().min_h(0).overflow_y_scrollbar().gap(2).children(items.length ? items.map(row) : [empty]),
      div().text_size(11).text_color(t.dim).child("Enter open · ↑↓ move · tab projects/profiles · cmd-n new · cmd-e edit · cmd-⌫ delete"),
    ].filter(Boolean);
  }

  renderProject(t) {
    const f = this.form;
    const tab = f.tabs[f.tab];
    const label = (s) => div().w(56).flex_none().text_size(12).text_color(t.muted).child(s);
    const browse = (id, state) => this.btn(t, id, "Browse…", (cx) => cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Use folder" });
      if (dir) state.set_value(tilde(dir));
      cx.notify();
    }));
    return [
      this.header(t, f.id ? "Edit project" : "New project"),
      h_flex().gap(8).items_center().child(label("Name")).child(this.field(t, f.name)),
      h_flex().gap(8).items_center().child(label("Folder")).child(this.field(t, f.folder)).child(browse("pj-browse", f.folder)),
      h_flex().gap(8).items_center().child(label("Apps")).child(this.field(t, f.apps)),
      h_flex().flex_1().min_h(0).gap(14).items_start()
        .child(this.renderTabs(t, f))
        .child(v_flex().gap(10)
          .child(div().w(CANVAS.w).h(CANVAS.h).flex_none().child(this.renderNode(t, tab, tab.layout, CANVAS.w, CANVAS.h)))
          .child(this.renderTools(t, tab))),
      this.footer(t, (cx) => this.saveProject(cx)),
    ];
  }

  // Tabs down the left: click one to edit its panes, hover to rename or remove it.
  renderTabs(t, f) {
    const row = (tab, i) => {
      const on = f.tab === i;
      const hover = this.hoverTab === tab.key;
      return h_flex().id(`pj-tab-${tab.key}`).h(36).px(8).gap(4).items_center().rounded(7).cursor_pointer()
        .when(on, (el) => el.bg(t.solid).text_color(t.solid_foreground))
        .when(!on, (el) => el.border_1().border_color(t.border).hover((s) => s.bg(t.hover)))
        .on_hover((h, cx) => { this.hoverTab = h ? tab.key : this.hoverTab === tab.key ? null : this.hoverTab; cx.notify(); })
        .on_click((_e, cx) => { f.tab = i; cx.notify(); })
        .child(on || hover
          ? Input.new(tab.name).flex_1().h_full().text_size(12.5).text_color(on ? t.solid_foreground : t.foreground)
          : div().flex_1().truncate().text_size(12.5).child(tab.name.value().trim() || `Tab ${i + 1}`))
        .when(hover && f.tabs.length > 1, (el) => el.child(div().id(`pj-rmtab-${tab.key}`).px(4).rounded(4).text_size(11).cursor_pointer()
          .text_color(on ? t.solid_foreground : t.dim)
          .hover((s) => s.text_color(t.blocked))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            f.tabs.splice(i, 1);
            f.tab = Math.min(f.tab > i ? f.tab - 1 : f.tab, f.tabs.length - 1);
            cx.notify();
          })
          .child("✕")));
    };
    return v_flex().id("pj-tabs").w(170).flex_none().max_h_full().overflow_y_scrollbar().gap(6)
      .children(f.tabs.map(row))
      .child(div().id("pj-addtab").h(36).flex().items_center().justify_center().rounded(7).border_1().border_dashed().border_color(t.border)
        .text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { f.tabs.push(this.tabForm()); f.tab = f.tabs.length - 1; cx.notify(); })
        .child("+"));
  }

  // A split is a resizable group (drag its border); a leaf is a pane card.
  renderNode(t, tab, n, w, h) {
    if (!n.split) return this.renderLeaf(t, tab, n);
    const right = n.split === "right";
    const [wa, ha] = right ? [w * n.ratio, h] : [w, h * n.ratio];
    const [wb, hb] = right ? [w - wa, h] : [w, h - ha];
    return (right ? h_resizable : v_resizable)(`pj-g-${n.id}`).size_full()
      .on_resize((sizes) => { const sum = sizes[0] + sizes[1]; if (sum > 0) n.ratio = sizes[0] / sum; })
      .child(resizable_panel().size(right ? wa : ha).size_range(MIN).child(this.renderNode(t, tab, n.a, wa, ha)))
      .child(resizable_panel().size(right ? wb : hb).size_range(MIN).child(this.renderNode(t, tab, n.b, wb, hb)));
  }

  // A pane card looks like a small terminal: two typed lines, `cd <folder>` and `❯ <command>`.
  renderLeaf(t, tab, n) {
    const on = tab.sel === n.id;
    const mono = t.typography?.mono ?? "Menlo";
    const row = (prompt, state, color) => h_flex().flex_none().h(30).gap(8).items_center()
      .child(div().w(22).flex_none().font_family(mono).text_size(13).text_color(on ? t.accent : t.dim).child(prompt))
      .child(Input.new(state).flex_1().h_full().font_family(mono).text_size(13.5).text_color(color));
    return div().size_full().p(3).child(
      v_flex().id(`pj-leaf-${n.id}`).size_full().overflow_hidden().px(12).pt(8).rounded(8).border_1()
        .border_color(on ? t.accent : t.border)
        .bg(on ? t.selected : t.background)
        .on_mouse_down("left", (_e, cx) => { if (tab.sel !== n.id) { tab.sel = n.id; cx.notify(); } })
        .child(row("cd", n.dir, t.muted))
        .child(row("❯", n.cmd, t.foreground)));
  }

  // Acts on the selected pane.
  renderTools(t, tab) {
    const only = !tab.layout.split;
    const icon = (right) => div().w(22).h(16).flex().when(right, (el) => el.flex_row()).when(!right, (el) => el.flex_col())
      .rounded(3).border_1().border_color(t.muted)
      .child(div().flex_1().border_color(t.muted).when(right, (el) => el.border_r_1()).when(!right, (el) => el.border_b_1()))
      .child(div().flex_1());
    const tool = (id, glyph, text, onClick, { danger = false, off = false } = {}) => h_flex().id(id).h(34).px(12).gap(8).items_center()
      .rounded(7).border_1().border_color(t.border).text_size(12)
      .text_color(off ? t.dim : danger ? t.blocked : t.foreground)
      .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .when(off, (el) => el.opacity(0.5))
      .child(glyph)
      .child(text);
    const split = (dir) => (cx) => {
      const b = this.leafForm();
      tab.layout = replace(tab.layout, tab.sel, (l) => ({ id: uid(), split: dir, ratio: 0.5, a: l, b }));
      tab.sel = b.id;
      cx.notify();
    };
    return h_flex().w(CANVAS.w).gap(8).items_center()
      .child(tool("pj-split-right", icon(true), "Split vertically", split("right")))
      .child(tool("pj-split-down", icon(false), "Split horizontally", split("down")))
      .child(div().flex_1().text_size(11).text_color(t.dim).child("Click a pane to select it · drag a border to resize"))
      .child(tool("pj-rmpane", div().child("🗑"), "Delete pane", (cx) => {
        tab.layout = drop(tab.layout, tab.sel);
        tab.sel = leaves(tab.layout)[0].id;
        cx.notify();
      }, { danger: true, off: only }));
  }

  renderProfile(t) {
    const f = this.form;
    const row = (p) => {
      const on = f.picks.includes(p.id);
      return h_flex().id(`pj-pick-${p.id}`).px(10).h(34).gap(10).items_center().rounded(7).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { f.picks = on ? f.picks.filter((x) => x !== p.id) : [...f.picks, p.id]; cx.notify(); })
        .child(div().w(18).text_color(on ? t.accent : t.dim).child(on ? "☑" : "☐"))
        .child(div().flex_1().truncate().child(p.name))
        .child(div().text_size(11.5).text_color(t.dim).child(on ? `#${f.picks.indexOf(p.id) + 1}` : ""));
    };
    return [
      this.header(t, f.id ? "Edit profile" : "New profile"),
      h_flex().gap(8).items_center().child(div().w(64).text_size(12).text_color(t.muted).child("Name")).child(this.field(t, f.name)),
      div().text_size(12).text_color(t.muted).child("Projects to start, in the order picked:"),
      v_flex().id("pj-picks").flex_1().min_h(0).overflow_y_scrollbar().gap(2).children(this.data.projects.map(row)),
      this.footer(t, (cx) => this.saveProfile(cx)),
    ];
  }

  footer(t, onSave) {
    return h_flex().gap(8).items_center()
      .child(div().flex_1().text_size(12).text_color(t.blocked).child(this.formError ?? ""))
      .child(this.btn(t, "pj-cancel", "Cancel", (cx) => this.back(cx)))
      .child(this.btn(t, "pj-save", "Save  ⌘S", onSave, { primary: true }));
  }
}
