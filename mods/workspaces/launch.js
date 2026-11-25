// Builds projects in Herdr through `herdr-app do`, which answers with the new
// space/tab/pane ids (a mod's run() returns null), so splits land on the right pane.
//
// A tab's layout is a tree: a leaf { id, command, dir }, or a split
// { id, split: "right" | "down", ratio, a, b } where `a` is left/top.

import { exec, hc, home } from "herdr";

export const expand = (p) => (p || "").replace(/^~(?=\/|$)/, home());
export const uid = () => Math.random().toString(36).slice(2, 12);
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// Older projects kept a flat list where each pane split off the one before it.
export function layoutOf(tab) {
  if (tab.layout) return tab.layout;
  const panes = tab.panes?.length ? tab.panes : [{}];
  const leaf = (p) => ({ id: uid(), command: p.command ?? "", dir: "" });
  let node = leaf(panes[panes.length - 1]);
  for (let i = panes.length - 2; i >= 0; i--)
    node = { id: uid(), split: panes[i + 1].split === "right" ? "right" : "down", ratio: 0.5, a: leaf(panes[i]), b: node };
  return node;
}

export async function hdo(command, args) {
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

export async function herdr(...argv) {
  try { return JSON.parse((await exec("herdr-app", argv)).stdout || "{}"); } catch { return {}; }
}

async function paneOf(terminal) {
  for (const s of (await herdr("ls")).spaces ?? [])
    for (const t of s.tabs ?? [])
      for (const x of t.terminals ?? []) if (x.terminal === terminal) return x.pane;
  throw new Error(`no pane for ${terminal}`);
}

const dirOf = (leaf, folder) => {
  const d = expand((leaf.dir || "").trim());
  return !d ? folder : d.startsWith("/") || !folder ? d : `${folder}/${d}`;
};

// Every pane is a plain shell that gets `cd <dir> && <command>` typed into it
// (a split's own argv would run without your shell's PATH and close on exit).
// hc send waits for the shell to start (and for anyone typing there), so sends
// aren't awaited here. Records one resize job per split, outer splits first.
async function build(node, pane, terminal, folder, size, jobs, sends) {
  if (!node.split) {
    const dir = dirOf(node, folder);
    const line = [dir && `cd ${quote(dir)}`, (node.command || "").trim()].filter(Boolean).join(" && ");
    if (line) sends.push(hc(["send", terminal, line]));
    return { first: pane, last: pane };
  }
  const right = node.split === "right";
  const r = node.ratio ?? 0.5;
  const job = { right, px: (r - 0.5) * (right ? size.w : size.h) };
  jobs.push(job);
  const s = await hdo("pane.split", { direction: node.split, pane });
  const sa = right ? { w: size.w * r, h: size.h } : { w: size.w, h: size.h * r };
  const sb = right ? { w: size.w - sa.w, h: size.h } : { w: size.w, h: size.h - sa.h };
  const a = await build(node.a, pane, terminal, folder, sa, jobs, sends);
  const b = await build(node.b, s.pane, s.terminal, folder, sb, jobs, sends);
  job.aLast = a.last; // bottom-right leaf of a: its right/bottom border is this split's
  job.bFirst = b.first; // top-left leaf of b: its left/top border is this split's
  return { first: a.first, last: b.last };
}

// Herdr splits 50/50; move each border by the difference. Only a tab on screen
// can be resized, and a border only moves toward a pane that is there, so grow
// a's last leaf or b's first one.
// Only a pane on screen can be resized. A tab just selected can take a moment;
// if you've switched away, the split stays 50/50 rather than failing the launch.
async function resizeWhenShown(cx, args) {
  for (let i = 0; i < 10; i++) {
    try {
      return await hdo("pane.resize", args);
    } catch (e) {
      if (!/on screen/.test(String(e.message))) throw e;
      await cx.sleep(100);
    }
  }
}

async function resize(tab, jobs, cx) {
  await hdo("tab.select", { id: tab });
  await cx.sleep(150); // resizes are ignored until the new panes are laid out
  for (const j of jobs) {
    if (Math.abs(j.px) < 8) continue;
    const grow = j.px > 0;
    const pane = grow ? j.aLast : j.bFirst;
    const direction = j.right ? (grow ? "right" : "left") : grow ? "down" : "up";
    // one call moved at most 300 px in testing
    for (let left = Math.abs(j.px); left > 0; left -= 250)
      await resizeWhenShown(cx, { pane, direction, px: Math.round(Math.min(250, left)) });
  }
}

async function launchProject(p, area, sends, cx) {
  const folder = expand(p.folder);
  // Old projects listed mods in `apps`; they open as mod tabs after the others.
  const tabs = [...(p.tabs?.length ? p.tabs : [{ name: "" }]), ...(p.apps ?? []).map((mod) => ({ name: mod, mod }))];
  let space, firstTab, spare;
  const resizes = [];
  // Built off screen (focus false), so typing elsewhere isn't caught by the new terminals.
  for (const t of tabs) {
    if (t.mod) {
      if (!space) {
        // a space always starts with a terminal tab; it goes once the mod tabs are in
        const r = await hdo("space.new", { name: p.name, folder, focus: false });
        space = r.space;
        spare = r.tab;
      }
      const r = await hdo("tab.new", { space, name: t.name || t.mod, mod: t.mod, focus: false });
      firstTab ??= r.tab;
      continue;
    }
    let r;
    if (space) r = await hdo("tab.new", { space, name: t.name, folder, focus: false });
    else {
      r = await hdo("space.new", { name: p.name, folder, tab: t.name, focus: false });
      space = r.space;
    }
    firstTab ??= r.tab;
    const jobs = [];
    await build(layoutOf(t), await paneOf(r.terminal), r.terminal, folder, area, jobs, sends);
    if (jobs.length) resizes.push([r.tab, jobs]);
  }
  for (const [tab, jobs] of resizes) await resize(tab, jobs, cx);
  await hdo("tab.select", { id: firstTab });
  if (spare && spare !== firstTab) await hdo("tab.close", { id: spare, confirmed: true });
  return [];
}

// job: { projects, vp }. Answers the errors, one line each.
export async function launch(job, cx) {
  // ponytail: Herdr doesn't report pane sizes. Window minus sidebar and chrome,
  // measured on one setup. Ratios come out close, not exact.
  const z = (await herdr("status")).zoom || 1;
  const area = { w: (job.vp?.width ?? 1600) / z - 290, h: (job.vp?.height ?? 1000) / z - 95 };
  const errors = [];
  const sends = [];
  for (const p of job.projects) {
    try {
      errors.push(...(await launchProject(p, area, sends, cx)));
    } catch (e) {
      errors.push(`${p.name}: ${e.message ?? e}`);
    }
  }
  await Promise.all(sends);
  return errors;
}
