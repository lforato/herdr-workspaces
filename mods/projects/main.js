// Projects: saved space layouts (tabs, split panes, a command per pane) and
// profiles (several projects started together). cmd-o opens it.
// List: type to filter, ↑/↓, Enter opens, tab switches projects/profiles,
// cmd-n new, cmd-e edit, cmd-backspace delete (twice). Editors: cmd-s saves, Esc goes back,
// cmd-d / shift-cmd-d split the selected pane.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, h_resizable, v_resizable, resizable_panel } from "gpui-base";
import { theme, props, closeOverlay, openOverlay, readTextFile, writeTextFile, appHome, pickFolder, notify, nextCommand } from "herdr";
import { expand, layoutOf, uid, launch } from "./launch.js";

const FILE = () => `${appHome()}/data/projects.json`;
// The pane canvas: fixed, so split sizes come out of the ratios exactly. Fits mod.json's width.
const CANVAS = { w: 1020, h: 340 };
const MIN = 28; // smallest pane in the canvas, px

const leaves = (n) => (n.split ? [...leaves(n.a), ...leaves(n.b)] : [n]);
const replace = (n, id, fn) => (n.id === id ? fn(n) : n.split ? { ...n, a: replace(n.a, id, fn), b: replace(n.b, id, fn) } : n);
// Splits get new ids so their resizable groups start again from the ratios.
const fresh = (n) => (n.split ? { ...n, id: uid(), a: fresh(n.a), b: fresh(n.b) } : n);
const drop = (n, id) => (!n.split ? n : n.a.id === id ? fresh(n.b) : n.b.id === id ? fresh(n.a) : { ...n, a: drop(n.a, id), b: drop(n.b, id) });
const tilde = (dir) => (dir.startsWith(expand("~")) ? "~" + dir.slice(expand("~").length) : dir);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const countTabs = (p) => (p.tabs?.length ?? 0);
const basename = (p) => (p || "").replace(/\/+$/, "").split("/").pop();
// theme color + alpha (hex pair), e.g. a soft accent fill
const alpha = (c, a) => (/^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) + a : c);

export default class Projects extends View {
  init(_props, cx) {
    // Opened as the small loading dialog (see open()): it holds the keyboard so
    // nothing else is used meanwhile, builds the projects, then closes itself.
    if (props()?.launch) {
      this.job = props().launch;
      this.keys = cx.focus_handle();
      this.keys.focus();
      cx.timer.after(50, () => this.keys.focus());
      cx.spawn(async (cx) => {
        try {
          const errors = await launch(this.job, cx);
          if (errors.length) notify({ title: "Projects", body: errors.join("\n"), level: "error" });
        } finally {
          this.close();
        }
      });
      return;
    }
    this.data = { projects: [], profiles: [] };
    this.raw = null; // file text as last read/written (writeTextFile's stale check)
    this.mode = "projects";
    this.view = "list";
    this.at = 0;
    this.armed = null; // id waiting for a second delete
    this.dirty = false;
    this.n = 0; // element id counter for editor rows
    this.filter = InputState.new({ placeholder: "Search projects, folders or tabs…" });
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

  // Projects match on name, folder or tab names. Profiles show every card.
  items() {
    if (this.mode === "profiles") return this.data.profiles;
    const f = this.filter.value().toLowerCase().trim();
    if (!f) return this.data.projects;
    return this.data.projects.filter((p) =>
      [p.name, p.folder, ...(p.tabs ?? []).map((t) => t.name)].some((s) => (s || "").toLowerCase().includes(f)));
  }

  // A dialog's work stops when it closes, so the launch runs in a small modal
  // dialog of its own that closes when it's done.
  open(item) {
    if (!item) return;
    const projects = this.mode === "projects" ? [item] : item.projects.map((id) => this.data.projects.find((p) => p.id === id)).filter(Boolean);
    if (!projects.length) return;
    openOverlay({ mod: "projects", kind: "dialog", modal: true, width: 340, height: 190, props: { launch: { projects, vp: this.vp } } });
    this.close();
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
    this.dirty = false;
    cx.notify();
  }

  switchMode(mode, cx) {
    this.mode = mode;
    this.at = 0;
    this.armed = null;
    this.filter.focus();
    cx.notify();
  }

  // ---- project editor -----------------------------------------------------

  // Every editor input marks the form dirty and redraws (pane cards mirror their inputs).
  input(value, placeholder) {
    const s = InputState.new({ value: value ?? "", placeholder });
    s.on("change", (_e, cx) => { this.dirty = true; cx.notify(); });
    return s;
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
      name: this.input(p.name, "Project name"),
      folder: this.input(p.folder, "~/Projects/my-project"),
      apps: [...(p.apps ?? [])],
      modInput: this.input("", "Add a mod…"),
      tabs: p.tabs.map((t) => this.tabForm(t)),
      tab: 0,
    };
    this.form.modInput.on("submit", (_e, cx) => this.addMods(cx));
    this.view = "project";
    this.form.name.focus();
  }

  addMods(cx) {
    const f = this.form;
    const names = f.modInput.value().split(/[\s,]+/).filter(Boolean);
    for (const n of names) if (!f.apps.includes(n)) f.apps.push(n);
    f.modInput.set_value("");
    cx?.notify();
  }

  saveProject(cx) {
    const f = this.form;
    const name = f.name.value().trim();
    if (!name) { this.formError = "Name is required"; cx.notify(); return; }
    this.addMods();
    const toData = (n) => (n.split
      ? { id: n.id, split: n.split, ratio: Math.round(n.ratio * 1000) / 1000, a: toData(n.a), b: toData(n.b) }
      : { id: n.id, command: n.cmd.value().trim(), dir: n.dir.value().trim() });
    const project = {
      id: f.id ?? uid(),
      name,
      folder: f.folder.value().trim(),
      tabs: f.tabs.map((t) => ({ name: t.name.value().trim(), layout: toData(t.layout) })),
      apps: f.apps,
    };
    const list = this.data.projects;
    const i = list.findIndex((x) => x.id === project.id);
    if (i >= 0) list[i] = project; else list.push(project);
    this.back(cx);
    cx.spawn(async (cx) => { await this.save(); cx.notify(); });
  }

  splitSel(tab, dir, cx) {
    const b = this.leafForm();
    tab.layout = replace(tab.layout, tab.sel, (l) => ({ id: uid(), split: dir, ratio: 0.5, a: l, b }));
    tab.sel = b.id;
    this.dirty = true;
    cx.notify();
  }

  deletePane(tab, cx) {
    if (!tab.layout.split) return;
    tab.layout = drop(tab.layout, tab.sel);
    tab.sel = leaves(tab.layout)[0].id;
    this.dirty = true;
    cx.notify();
  }

  // ---- profile editor -----------------------------------------------------

  editProfile(pf) {
    pf ??= { id: null, name: "", projects: [] };
    const filter = InputState.new({ placeholder: "Filter projects…" });
    filter.on("change", (_e, cx) => cx.notify());
    this.form = { id: pf.id, name: this.input(pf.name, "Profile name"), picks: [...pf.projects], filter };
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
    this.dirty = false;
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
      .bg(t.popover)
      .text_size(12)
      .text_color(t.foreground)
      .on_key_down((e, cx) => this.key(e, cx))
      .children(body);
  }

  renderLoading(t) {
    const names = this.job.projects.map((p) => p.name).join(", ");
    return v_flex().id("pj-loading").size_full().items_center().justify_center().gap(10).p(18).bg(t.popover).text_color(t.foreground)
      .track_focus(this.keys)
      .on_key_down((_e, cx) => cx.stop_propagation()) // Esc would close it and stop the launch
      .child(div().text_size(40).text_color(t.accent).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 80).child("⠋"))
      .child(div().max_w_full().truncate().text_size(14).font_semibold().child(`Opening ${names}`))
      .child(div().text_size(11.5).text_color(t.dim).child("Building tabs and panes…"));
  }

  key(e, cx) {
    const k = e.key;
    const cmd = e.modifiers?.platform || e.modifiers?.command;
    if (this.view !== "list") {
      const tab = this.view === "project" ? this.form.tabs[this.form.tab] : null;
      if (k === "escape") this.back(cx);
      else if (cmd && k === "s") this.view === "project" ? this.saveProject(cx) : this.saveProfile(cx);
      else if (cmd && k === "d" && tab) this.splitSel(tab, e.modifiers?.shift ? "down" : "right", cx);
      else return;
      cx.stop_propagation();
      return;
    }
    const items = this.items();
    // closing mid-launch cancels it (the launch is this dialog's task)
    if (k === "escape") { this.close(); cx.stop_propagation(); return; }
    const cards = this.mode === "profiles";
    if (k === "down" || (cards && k === "right")) this.at = Math.min(items.length - 1, this.at + 1);
    else if (k === "up" || (cards && k === "left")) this.at = Math.max(0, this.at - 1);
    else if (k === "tab") { this.switchMode(this.mode === "projects" ? "profiles" : "projects", cx); }
    else if (cmd && k === "k") this.filter.focus();
    else if (cmd && k === "n") this.edit(null, cx);
    else if (cmd && k === "e") { if (items[this.at]) this.edit(items[this.at], cx); }
    else if (cmd && k === "backspace") { if (items[this.at]) this.remove(items[this.at], cx); }
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---- shared pieces ------------------------------------------------------

  icon(t, name, size = 16, color = t.muted) {
    return svg(`mods/projects/icons/${name}.svg`).size(size).flex_none().text_color(color);
  }

  tint(t, i) {
    return [t.accent, t.ansi3, t.ansi2, t.ansi4][i % 4];
  }

  tintOf(t, project) {
    return this.tint(t, Math.max(0, this.data.projects.findIndex((p) => p.id === project.id)));
  }

  // Rounded-square initial in the project's tint.
  badge(t, project, size) {
    return div().w(size).h(size).flex_none().flex().items_center().justify_center().rounded(size >= 30 ? 8 : 6)
      .bg(this.tintOf(t, project)).text_color(t.background).text_size(size * 0.42).font_bold()
      .child(((project.name || "?")[0] ?? "?").toUpperCase());
  }

  numBadge(t, n, size = 20) {
    return div().w(size).h(size).flex_none().flex().items_center().justify_center().rounded(5)
      .bg(alpha(t.accent, "26")).text_color(t.accent).text_size(11).font_semibold().child(String(n));
  }

  chip(t, text) {
    return div().px(6).py(1).rounded(5).border_1().border_color(t.border).bg(t.selected).text_size(10.5).text_color(t.muted).child(text);
  }

  kbd(t, k, label) {
    return h_flex().items_center().gap(8)
      .child(div().px(5).py(0).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(k))
      .child(div().text_size(11).text_color(t.dim).child(label));
  }

  label(t, s) {
    return div().text_size(11.5).font_medium().text_color(t.muted).child(s);
  }

  micro(t, s, color) {
    return div().text_size(10).font_semibold().text_color(color ?? t.dim).child(s.toUpperCase());
  }

  // Primary (accent fill), soft (accent tint), or secondary (outlined).
  btn(t, id, label, onClick, { kind = "secondary", icon, hint, danger = false, full = false } = {}) {
    const primary = kind === "primary";
    const soft = kind === "soft";
    const fg = primary ? t.background : soft ? t.accent : danger ? t.blocked : t.muted;
    return h_flex().id(id).h(28).px(11).gap(6).items_center().justify_center().flex_none().rounded(7).text_size(12).font_semibold().cursor_pointer()
      .when(full, (el) => el.w_full())
      .text_color(fg)
      .when(primary, (el) => el.bg(t.accent))
      .when(soft, (el) => el.bg(alpha(t.accent, "1f")).border_1().border_color(alpha(t.accent, "4d")))
      .when(kind === "secondary", (el) => el.border_1().border_color(t.border))
      .hover((s) => (primary ? s.opacity(0.9) : soft ? s.bg(alpha(t.accent, "33")) : s.bg(t.hover)))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .when(Boolean(icon), (el) => el.child(this.icon(t, icon, soft ? 9 : 12, fg)))
      .child(label)
      .when(Boolean(hint), (el) => el.child(div().text_size(11).opacity(0.75).font_normal().child(hint)));
  }

  iconBtn(t, id, name, onClick, { danger = false, armed = false } = {}) {
    const hot = danger && armed;
    return div().id(id).w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .when(hot, (el) => el.bg(alpha(t.blocked, "33")))
      .hover((s) => s.bg(danger ? alpha(t.blocked, "33") : t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(this.icon(t, name, 14, hot || danger ? t.blocked : t.dim));
  }

  field(t, state, { grow = true, icon, prefix, mono = false, h = 30 } = {}) {
    const m = t.typography?.mono ?? "Menlo";
    return h_flex().h(h).flex_none().when(grow, (el) => el.flex_1()).px(10).gap(8).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .when(Boolean(icon), (el) => el.child(this.icon(t, icon, 13, t.dim)))
      .when(Boolean(prefix), (el) => el.child(div().flex_none().font_family(m).text_size(12).text_color(t.dim).child(prefix)))
      .child(Input.new(state).flex_1().h_full().text_size(12.5).text_color(t.foreground).when(mono, (el) => el.font_family(m)));
  }

  shellHeader(t, children) {
    return h_flex().flex_none().items_center().gap(10).flex_wrap().px(18).py(12).border_b_1().border_color(t.border).children(children);
  }

  // ---- list ---------------------------------------------------------------

  renderList(t) {
    const items = this.items();
    this.at = Math.max(0, Math.min(this.at, items.length - 1));
    const projects = this.mode === "projects";
    const seg = (mode, label, count) => {
      const on = this.mode === mode;
      return h_flex().id(`pj-mode-${mode}`).gap(6).items_center().px(10).py(4).rounded(6).cursor_pointer().text_size(12).font_medium()
        .text_color(on ? t.foreground : t.dim)
        .when(on, (el) => el.bg(t.selected))
        .hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => this.switchMode(mode, cx))
        .child(label)
        .child(div().px(6).py(0).rounded(7).text_size(10.5).text_color(t.dim).bg(alpha(t.foreground, "1a")).child(String(count)));
    };
    const header = this.shellHeader(t, [
      div().w(28).h(28).flex_none().flex().items_center().justify_center().rounded(7).bg(t.accent).child(this.icon(t, "terminal", 15, t.background)),
      v_flex().gap(1)
        .child(div().text_size(14).font_semibold().child("Workspaces"))
        .child(div().text_size(11).text_color(t.muted).child(projects ? "Launch a project or a whole profile in one go" : "A profile starts several projects in the order you choose")),
      div().flex_1(),
      h_flex().gap(2).p(3).rounded(9).border_1().border_color(t.border).bg(t.background)
        .child(seg("projects", "Projects", this.data.projects.length))
        .child(seg("profiles", "Profiles", this.data.profiles.length)),
      this.btn(t, "pj-new", projects ? "New project" : "New profile", (cx) => this.edit(null, cx), { kind: "primary", icon: "plus" }),
    ]);
    const search = h_flex().h(32).flex_none().px(12).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
      .child(this.icon(t, "search", 14, t.dim))
      .child(Input.new(this.filter).flex_1().h_full().text_size(12.5).text_color(t.foreground))
      .child(div().px(5).py(0).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child("⌘K"));
    const empty = div().p(12).text_color(t.dim).child(this.data[this.mode].length ? "Nothing matches." : projects ? "No projects yet: ⌘N to add one." : "No profiles yet: ⌘N to group projects.");
    const body = projects
      ? v_flex().flex_1().min_h(0).px(18).py(14).gap(10)
        .child(search)
        .children(this.error ? [div().text_color(t.blocked).child(this.error)] : [])
        .child(v_flex().id("pj-list").flex_1().min_h(0).overflow_y_scrollbar().gap(2).children(items.length ? items.map((x, i) => this.projectRow(t, x, i)) : [empty]))
      : v_flex().id("pj-cards").flex_1().min_h(0).overflow_y_scrollbar().p(18)
        .child(h_flex().flex_wrap().gap(12).items_start()
          .children(items.map((x, i) => this.profileCard(t, x, i)))
          .child(this.newCard(t)));
    const hints = [["↵", projects ? "Open" : "Launch"], ...(projects ? [["↑↓", "Move"]] : []), ["Tab", "Projects / Profiles"], ["⌘N", "New"], ["⌘E", "Edit"], ["⌘⌫", "Delete"]];
    const footer = h_flex().flex_none().items_center().gap(14).px(18).py(8).border_t_1().border_color(t.border)
      .children(hints.map(([k, l]) => this.kbd(t, k, l)))
      .child(div().flex_1())
      .child(div().id("pj-esc").cursor_pointer().on_click((_e, cx) => this.close()).child(this.kbd(t, "Esc", "Close")));
    return [header, body, footer];
  }

  projectRow(t, x, i) {
    const mono = t.typography?.mono ?? "Menlo";
    const on = i === this.at;
    const names = (x.tabs ?? []).map((tb) => tb.name?.trim() || "tab");
    const armed = this.armed === x.id;
    return h_flex().id(`pj-row-${x.id}`).px(10).py(8).gap(10).items_center().rounded(9).cursor_pointer().border_1()
      .border_color(on ? alpha(t.foreground, "1f") : "#00000000")
      .when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.selected))
      .on_click((_e, cx) => { this.at = i; this.open(x, cx); })
      .child(this.badge(t, x, 30))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().gap(8).items_baseline().min_w(0)
          .child(div().flex_none().text_size(13).font_semibold().child(x.name))
          .child(div().truncate().font_family(mono).text_size(11).text_color(t.dim).child(x.folder || "no folder")))
        .child(h_flex().gap(5).items_center().flex_wrap()
          .children(names.slice(0, 4).map((n) => this.chip(t, n)))
          .children(names.length > 4 ? [div().ml(3).text_size(11).text_color(t.dim).child(`+${names.length - 4} more`)] : [])))
      .child(this.btn(t, `pj-open-${x.id}`, "Open", () => this.open(x), { kind: "soft", icon: "play" }))
      .child(this.iconBtn(t, `pj-edit-${x.id}`, "pencil", (cx) => this.edit(x, cx)))
      .child(armed
        ? this.btn(t, `pj-del-${x.id}`, "Confirm delete", (cx) => this.remove(x, cx), { danger: true })
        : this.iconBtn(t, `pj-del-${x.id}`, "trash", (cx) => this.remove(x, cx), { danger: true }));
  }

  profileCard(t, pf, i) {
    const on = i === this.at;
    const armed = this.armed === pf.id;
    const projects = pf.projects.map((id) => this.data.projects.find((p) => p.id === id)).filter(Boolean);
    return v_flex().id(`pj-card-${pf.id}`).w(290).flex_none().p(14).gap(10).rounded(12).border_1()
      .border_color(on ? alpha(t.accent, "66") : t.border).bg(t.raised ?? t.surface)
      .on_click((_e, cx) => { this.at = i; cx.notify(); })
      .child(h_flex().items_start().gap(2)
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_size(14).font_semibold().child(pf.name))
          .child(div().text_size(11).text_color(t.dim).child(`${plural(projects.length, "project")} · starts top to bottom`)))
        .child(this.iconBtn(t, `pj-pedit-${pf.id}`, "pencil", (cx) => { this.at = i; this.edit(pf, cx); }))
        .child(armed
          ? this.btn(t, `pj-pdel-${pf.id}`, "Confirm", (cx) => this.remove(pf, cx), { danger: true })
          : this.iconBtn(t, `pj-pdel-${pf.id}`, "trash", (cx) => { this.at = i; this.remove(pf, cx); }, { danger: true })))
      .child(v_flex().gap(4).children(projects.map((p, n) =>
        h_flex().h(30).px(8).gap(8).items_center().rounded(7).bg(t.background)
          .child(this.numBadge(t, n + 1, 18))
          .child(div().w(8).h(8).flex_none().rounded(4).bg(this.tintOf(t, p)))
          .child(div().flex_1().truncate().text_size(12.5).child(p.name))
          .child(div().text_size(11).text_color(t.dim).child(plural(countTabs(p), "tab"))))))
      .child(this.btn(t, `pj-launch-${pf.id}`, "Launch profile", () => { this.mode = "profiles"; this.open(pf); }, { kind: "soft", icon: "play", full: true }));
  }

  newCard(t) {
    return v_flex().id("pj-newcard").w(290).h(150).flex_none().items_center().justify_center().gap(6).rounded(12).border_1().border_dashed().border_color(t.border)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.edit(null, cx))
      .child(this.icon(t, "plus", 18, t.dim))
      .child(div().text_size(12.5).font_medium().text_color(t.dim).child("New profile"));
  }

  // ---- editors ------------------------------------------------------------

  editorHeader(t, crumb, name, { dirty = false, onSave } = {}) {
    return this.shellHeader(t, [
      h_flex().id("pj-back").gap(3).items_center().cursor_pointer().text_color(t.muted).text_size(12.5)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => this.back(cx))
        .child(this.icon(t, "chevron-left", 14, t.muted))
        .child(crumb),
      div().text_size(14).text_color(t.dim).child("/"),
      h_flex().w(300).max_w_full().h(28).items_center().child(Input.new(name).flex_1().h_full().text_size(15).font_semibold().text_color(t.foreground)),
      div().flex_1(),
      this.formError
        ? div().text_size(12).text_color(t.blocked).child(this.formError)
        : div().text_size(12).text_color(t.dim).child(dirty ? "Unsaved changes" : ""),
      this.btn(t, "pj-cancel", "Cancel", (cx) => this.back(cx)),
      this.btn(t, "pj-save", "Save", onSave, { kind: "primary", hint: "⌘S" }),
    ]);
  }

  renderProject(t) {
    const f = this.form;
    const tab = f.tabs[f.tab];
    const mono = t.typography?.mono ?? "Menlo";
    const header = this.editorHeader(t, "Projects", f.name, { dirty: this.dirty, onSave: (cx) => this.saveProject(cx) });
    const browse = this.btn(t, "pj-browse", "Browse…", (cx) => cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Use folder" });
      if (dir) f.folder.set_value(tilde(dir));
      cx.notify();
    }));
    const mods = h_flex().min_h(30).flex_1().flex_wrap().px(6).py(3).gap(5).items_center().rounded(7).border_1().border_color(t.input).bg(t.background)
      .children(f.apps.map((m) => h_flex().gap(6).items_center().px(6).py(2).rounded(5).border_1().border_color(t.border).bg(t.selected)
        .child(div().font_family(mono).text_size(11.5).child(m))
        .child(div().id(`pj-rmmod-${m}`).cursor_pointer().on_click((_e, cx) => { f.apps = f.apps.filter((x) => x !== m); this.dirty = true; cx.notify(); })
          .child(this.icon(t, "x", 10, t.dim)))))
      .child(Input.new(f.modInput).flex_1().min_w(100).h(22).text_size(12.5).text_color(t.foreground));
    const fields = h_flex().flex_none().gap(12).px(18).py(12).border_b_1().border_color(t.border).items_end()
      .child(v_flex().flex_1().gap(6).child(this.label(t, "Project folder"))
        .child(h_flex().gap(6).child(this.field(t, f.folder, { icon: "folder", mono: true })).child(browse)))
      .child(v_flex().flex_1().gap(6).child(this.label(t, "Herdr mods to open")).child(mods));
    const main = v_flex().flex_1().min_w(0).p(18).gap(10)
      .child(this.renderTabs(t, f))
      .child(div().w(CANVAS.w + 14).flex_none().p(6).rounded(10).border_1().border_color(t.border).bg(t.chrome ?? t.background)
        .child(div().w(CANVAS.w).h(CANVAS.h).child(this.renderNode(t, tab, tab.layout, CANVAS.w, CANVAS.h))))
      .child(this.renderPanel(t, f, tab))
      .child(h_flex().items_center().gap(14).text_size(11).text_color(t.dim)
        .child("Click the active tab's name to rename · Drag a divider to resize")
        .child(div().flex_1())
        .child(this.kbd(t, "⌘D", "split right"))
        .child(this.kbd(t, "⇧⌘D", "split down")));
    return [header, v_flex().flex_1().min_h(0).child(fields).child(v_flex().flex_1().min_h(0).child(main))];
  }

  // Tabs across the top: click one to edit its panes; the active one's name is editable.
  renderTabs(t, f) {
    const row = (tab, i) => {
      const on = f.tab === i;
      const count = plural(leaves(tab.layout).length, "pane");
      return h_flex().id(`pj-tab-${tab.key}`).h(30).px(10).gap(6).items_center().rounded(7).cursor_pointer().border_1()
        .border_color(on ? t.accent : "#00000000")
        .when(on, (el) => el.bg(alpha(t.accent, "1a")))
        .hover((s) => s.bg(on ? alpha(t.accent, "1a") : t.hover))
        .on_click((_e, cx) => { f.tab = i; cx.notify(); })
        .child(on
          ? h_flex().w(90).h_full().items_center().child(Input.new(tab.name).flex_1().h_full().text_size(12).text_color(t.foreground))
          : div().text_size(12).text_color(t.foreground).child(tab.name.value().trim() || `Tab ${i + 1}`))
        .child(div().text_size(10.5).text_color(t.dim).child(count))
        .when(on && f.tabs.length > 1, (el) => el.child(div().id(`pj-rmtab-${tab.key}`).cursor_pointer()
          .on_click((_e, cx) => {
            cx.stop_propagation();
            f.tabs.splice(i, 1);
            f.tab = Math.min(f.tab > i ? f.tab - 1 : f.tab, f.tabs.length - 1);
            this.dirty = true;
            cx.notify();
          })
          .child(this.icon(t, "x", 10, t.dim))));
    };
    return h_flex().flex_none().flex_wrap().gap(3).items_center()
      .children(f.tabs.map(row))
      .child(this.iconBtn(t, "pj-addtab", "plus", (cx) => { f.tabs.push(this.tabForm()); f.tab = f.tabs.length - 1; this.dirty = true; cx.notify(); }));
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

  // A pane card: "PANE n", its folder, and the command it starts with.
  renderLeaf(t, tab, n) {
    const on = tab.sel === n.id;
    const mono = t.typography?.mono ?? "Menlo";
    const idx = leaves(tab.layout).findIndex((l) => l.id === n.id) + 1;
    const dir = n.dir.value().trim();
    const cmd = n.cmd.value().trim();
    return div().size_full().p(3).child(
      v_flex().id(`pj-leaf-${n.id}`).size_full().overflow_hidden().p(10).gap(8).rounded(8).border_1()
        .border_color(on ? t.accent : t.border)
        .bg(on ? alpha(t.accent, "14") : t.surface ?? t.background)
        .on_mouse_down("left", (_e, cx) => { if (tab.sel !== n.id) { tab.sel = n.id; cx.notify(); } })
        .child(h_flex().gap(8).items_center()
          .child(this.micro(t, `Pane ${idx}`, on ? t.accent : t.dim))
          .child(div().px(6).py(1).rounded(5).bg(t.background).font_family(mono).text_size(11).text_color(t.muted).child(dir ? (dir.startsWith("/") || dir.startsWith("~") ? dir : `./${dir}`) : "project folder")))
        .child(cmd
          ? h_flex().gap(8).items_baseline().child(div().text_color(t.accent).font_family(mono).text_size(12.5).child("❯")).child(div().font_family(mono).text_size(12.5).child(cmd))
          : div().italic().text_size(12.5).text_color(t.dim).child("Plain shell, no command")));
  }

  // Edits the selected pane, in a bar under the canvas.
  renderPanel(t, f, tab) {
    const all = leaves(tab.layout);
    const leaf = all.find((l) => l.id === tab.sel) ?? all[0];
    const idx = all.indexOf(leaf) + 1;
    const only = all.length === 1;
    const folder = basename(f.folder.value().trim());
    const tool = (id, icon, text, dir) => h_flex().id(id).h(30).px(10).gap(6).items_center().flex_none().rounded(7).border_1().border_color(t.border).text_size(12).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.splitSel(tab, dir, cx))
      .child(this.icon(t, icon, 13, t.muted))
      .child(text);
    return h_flex().flex_none().gap(12).p(12).items_end().rounded(10).border_1().border_color(t.border).bg(t.chrome ?? t.background)
      .child(v_flex().w(130).flex_none().gap(3).pb(4)
        .child(this.micro(t, `Pane ${idx} · ${tab.name.value().trim() || "tab"}`, t.accent))
        .child(div().text_size(13).font_semibold().child("What runs in this pane")))
      .child(v_flex().w(220).flex_none().gap(5).child(this.label(t, "Directory"))
        .child(this.field(t, leaf.dir, { grow: false, mono: true, prefix: folder ? `${folder}/` : undefined }).w_full()))
      .child(v_flex().flex_1().min_w(0).gap(5).child(this.label(t, "Command on start"))
        .child(this.field(t, leaf.cmd, { grow: false, mono: true }).w_full()))
      .child(tool("pj-split-right", "split-vertical", "Split right", "right"))
      .child(tool("pj-split-down", "split-horizontal", "Split down", "down"))
      .child(h_flex().id("pj-rmpane").gap(6).items_center().flex_none().h(30).px(6).text_size(12).font_medium()
        .text_color(only ? t.dim : t.blocked)
        .when(only, (el) => el.opacity(0.5))
        .when(!only, (el) => el.cursor_pointer().on_click((_e, cx) => this.deletePane(tab, cx)))
        .child(this.icon(t, "trash", 13, only ? t.dim : t.blocked))
        .child("Delete pane"));
  }

  renderProfile(t) {
    const f = this.form;
    const header = this.editorHeader(t, "Profiles", f.name, { onSave: (cx) => this.saveProfile(cx) });
    const mono = t.typography?.mono ?? "Menlo";
    const byId = (id) => this.data.projects.find((p) => p.id === id);
    const sub = (p) => h_flex().gap(0).min_w(0)
      .child(div().truncate().font_family(mono).text_size(11).text_color(t.dim).child(`${p.folder || "no folder"} · ${plural(countTabs(p), "tab")}`));
    const picked = f.picks.map(byId).filter(Boolean).map((p, i) =>
      h_flex().h(48).px(12).gap(10).items_center().rounded(9).border_1().border_color(t.border).bg(t.raised ?? t.surface)
        .child(this.numBadge(t, i + 1, 20))
        .child(this.badge(t, p, 26))
        .child(v_flex().flex_1().min_w(0).gap(1).child(div().truncate().text_size(12.5).font_semibold().child(p.name)).child(sub(p)))
        .child(this.iconBtn(t, `pj-unpick-${p.id}`, "x", (cx) => { f.picks = f.picks.filter((x) => x !== p.id); cx.notify(); })));
    const q = f.filter.value().toLowerCase();
    const avail = this.data.projects.filter((p) => !f.picks.includes(p.id) && p.name.toLowerCase().includes(q)).map((p) =>
      h_flex().id(`pj-pick-${p.id}`).h(48).px(12).gap(10).items_center().rounded(9).border_1().border_dashed().border_color(t.border).cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { f.picks = [...f.picks, p.id]; cx.notify(); })
        .child(this.badge(t, p, 26))
        .child(v_flex().flex_1().min_w(0).gap(1).child(div().truncate().text_size(12.5).font_semibold().child(p.name)).child(sub(p)))
        .child(h_flex().gap(4).items_center().text_color(t.accent).text_size(12).font_semibold().child(this.icon(t, "plus", 12, t.accent)).child("Add")));
    const section = (title, hint) => h_flex().items_center().child(div().flex_1().text_size(13).font_semibold().child(title)).child(div().text_size(11).text_color(t.dim).child(hint));
    const left = v_flex().flex_1().min_w(280).gap(8)
      .child(section("Launch order", "Click ✕ to remove · re-add to reorder"))
      .children(picked.length ? picked : [div().p(12).text_color(t.dim).child("No projects yet. Add some from the right.")])
      .child(h_flex().gap(8).items_center().p(10).rounded(8).bg(t.background).text_size(12).text_color(t.muted)
        .child(this.icon(t, "info", 13, t.dim))
        .child("Each project opens in its own space, one after another, top to bottom."));
    const right = v_flex().flex_1().min_w(280).gap(8)
      .child(section("Add projects", "Click to add to the end"))
      .child(this.field(t, f.filter, { icon: "search", h: 32 }))
      .children(avail.length ? avail : [div().p(12).text_color(t.dim).child(this.data.projects.length ? "Nothing to add." : "No projects yet.")]);
    return [header, h_flex().id("pj-profile").flex_1().min_h(0).overflow_y_scrollbar().items_start().flex_wrap().gap(24).px(18).py(18).child(left).child(right)];
  }
}
