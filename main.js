// Projects: saved space layouts (tabs, split panes, a command per pane) and
// profiles (several projects started together). cmd-o opens it.
// List: type to filter, ↑/↓, Enter opens, tab switches projects/profiles,
// cmd-n new, cmd-e edit, cmd-backspace delete (twice). Editors: cmd-s saves, Esc goes back.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, readTextFile, writeTextFile, appHome, pickFolder, notify, nextCommand } from "herdr";
import { launchProject, expand } from "./launch.js";

const FILE = () => `${appHome()}/data/projects.json`;
const uid = () => Math.random().toString(36).slice(2, 12);

export default class Projects extends View {
  init(_props, cx) {
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

  open(item, cx) {
    if (!item || this.busy) return;
    const projects = this.mode === "projects" ? [item] : item.projects.map((id) => this.data.projects.find((p) => p.id === id)).filter(Boolean);
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const p of projects) await launchProject(p);
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

  paneForm(p = {}) {
    return { key: ++this.n, cmd: this.input(p.command, "command (empty: a shell)"), split: p.split === "right" ? "right" : "down" };
  }

  tabForm(t = { panes: [{}] }) {
    return { key: ++this.n, name: this.input(t.name, "tab name"), panes: (t.panes?.length ? t.panes : [{}]).map((p) => this.paneForm(p)) };
  }

  editProject(p) {
    p ??= { id: null, name: "", folder: "", tabs: [{ name: "", panes: [{ command: "" }] }] };
    this.form = { id: p.id, name: this.input(p.name, "My project"), folder: this.input(p.folder, "~/Projects/my-project"), tabs: p.tabs.map((t) => this.tabForm(t)) };
    this.view = "project";
    this.form.name.focus();
  }

  saveProject(cx) {
    const f = this.form;
    const name = f.name.value().trim();
    if (!name) { this.formError = "Name is required"; cx.notify(); return; }
    const project = {
      id: f.id ?? uid(),
      name,
      folder: f.folder.value().trim(),
      tabs: f.tabs.map((t) => ({ name: t.name.value().trim(), panes: t.panes.map((p) => ({ command: p.cmd.value().trim(), split: p.split })) })),
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
    if (k === "escape") { if (!this.busy) this.close(); cx.stop_propagation(); return; }
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
      div().text_size(11).text_color(t.dim).child(this.busy ? "Opening…" : "Enter open · ↑↓ move · tab projects/profiles · cmd-n new · cmd-e edit · cmd-⌫ delete"),
    ].filter(Boolean);
  }

  renderProject(t) {
    const f = this.form;
    const label = (s) => div().w(64).flex_none().text_size(12).text_color(t.muted).child(s);
    const browse = this.btn(t, "pj-browse", "Browse…", (cx) => cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Use folder" });
      if (dir) f.folder.set_value(dir.startsWith(expand("~")) ? "~" + dir.slice(expand("~").length) : dir);
      cx.notify();
    }));
    const move = (i, by) => (cx) => {
      const j = i + by;
      if (j < 0 || j >= f.tabs.length) return;
      [f.tabs[i], f.tabs[j]] = [f.tabs[j], f.tabs[i]];
      cx.notify();
    };
    const paneRow = (tab, p, pi) => h_flex().gap(6).items_center()
      .child(pi === 0
        ? div().w(70).flex_none().text_size(11.5).text_color(t.dim).child("main")
        : div().id(`pj-split-${p.key}`).w(70).flex_none().px(6).py(4).rounded(6).border_1().border_color(t.border).text_size(11.5).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { p.split = p.split === "right" ? "down" : "right"; cx.notify(); })
          .child(p.split === "right" ? "→ right" : "↓ down"))
      .child(this.field(t, p.cmd))
      .when(tab.panes.length > 1, (el) => el.child(this.btn(t, `pj-rmpane-${p.key}`, "✕", (cx) => { tab.panes.splice(pi, 1); cx.notify(); })));
    const tabCard = (tab, i) => v_flex().gap(6).p(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center()
        .child(div().w(46).flex_none().text_size(11.5).text_color(t.dim).child(`Tab ${i + 1}`))
        .child(this.field(t, tab.name))
        .child(this.btn(t, `pj-up-${tab.key}`, "↑", move(i, -1)))
        .child(this.btn(t, `pj-down-${tab.key}`, "↓", move(i, 1)))
        .when(f.tabs.length > 1, (el) => el.child(this.btn(t, `pj-rmtab-${tab.key}`, "Remove", (cx) => { f.tabs.splice(i, 1); cx.notify(); }, { danger: true }))))
      .children(tab.panes.map((p, pi) => paneRow(tab, p, pi)))
      .child(h_flex().child(this.btn(t, `pj-addpane-${tab.key}`, "+ pane", (cx) => { tab.panes.push(this.paneForm({ split: "right" })); cx.notify(); })));
    return [
      this.header(t, f.id ? "Edit project" : "New project"),
      h_flex().gap(8).items_center().child(label("Name")).child(this.field(t, f.name)),
      h_flex().gap(8).items_center().child(label("Folder")).child(this.field(t, f.folder)).child(browse),
      v_flex().id("pj-tabs").flex_1().min_h(0).overflow_y_scrollbar().gap(8)
        .children(f.tabs.map(tabCard))
        .child(h_flex().child(this.btn(t, "pj-addtab", "+ tab", (cx) => { f.tabs.push(this.tabForm()); cx.notify(); }))),
      this.footer(t, (cx) => this.saveProject(cx)),
    ];
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
