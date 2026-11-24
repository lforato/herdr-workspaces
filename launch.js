// Builds a project's space through `herdr-app do`, which answers with the new
// space/tab/pane ids (a mod's run() returns null), so splits land on the right pane.

import { exec, hc, home } from "herdr";

export const expand = (p) => (p || "").replace(/^~(?=\/|$)/, home());
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

async function hdo(command, args) {
  const argv = ["do", command];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === "") continue;
    argv.push(`--${k}`, typeof v === "string" ? v : JSON.stringify(v));
  }
  const r = await exec("herdr-app", argv);
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch {}
  if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${command} failed`);
  return out;
}

async function paneOf(terminal) {
  const r = await exec("herdr-app", ["ls"]);
  const data = JSON.parse(r.stdout);
  for (const s of Array.isArray(data) ? data : data.spaces ?? [])
    for (const t of s.tabs ?? [])
      for (const x of t.terminals ?? []) if (x.terminal === terminal) return x.pane;
  throw new Error(`no pane for ${terminal}`);
}

// Tabs/spaces run argv inside your interactive shell, which stays open after it exits.
const argvFor = (cmd) => ((cmd || "").trim() ? ["sh", "-c", cmd.trim()] : undefined);

// A split's argv runs bare (login PATH, pane closes on exit), and its folder follows
// whatever had focus. So: open a plain shell, then type `cd <folder> && <command>` into it.
async function splits(tab, terminal, folder) {
  let pane = await paneOf(terminal);
  for (const p of tab.panes.slice(1)) {
    const r = await hdo("pane.split", { direction: p.split === "right" ? "right" : "down", pane });
    pane = r.pane;
    const cmd = (p.command || "").trim();
    const line = [folder && `cd ${quote(folder)}`, cmd].filter(Boolean).join(" && ");
    if (line) await hc(["send", r.terminal, line]);
  }
}

export async function launchProject(p) {
  const folder = expand(p.folder);
  const tabs = p.tabs?.length ? p.tabs : [{ name: "", panes: [{ command: "" }] }];
  const [first, ...rest] = tabs;
  const r = await hdo("space.new", { name: p.name, folder, tab: first.name, argv: argvFor(first.panes[0]?.command) });
  await splits(first, r.terminal, folder);
  for (const t of rest) {
    const r2 = await hdo("tab.new", { space: r.space, name: t.name, folder, argv: argvFor(t.panes[0]?.command) });
    await splits(t, r2.terminal, folder);
  }
  await hdo("tab.select", { id: r.tab });
}
