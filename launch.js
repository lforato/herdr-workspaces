// Builds a project's space through `herdr-app do`, which answers with the new
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

const dirOf = (leaf, folder) => {
  const d = expand((leaf.dir || "").trim());
  return !d ? folder : d.startsWith("/") || !folder ? d : `${folder}/${d}`;
};

// Every pane is a plain shell that gets `cd <dir> && <command>` typed into it
// (a split's own argv would run without your shell's PATH and close on exit).
// Records one resize job per split, outer splits first.
async function build(node, pane, terminal, folder, size, jobs) {
  if (!node.split) {
    const dir = dirOf(node, folder);
    const line = [dir && `cd ${quote(dir)}`, (node.command || "").trim()].filter(Boolean).join(" && ");
    if (line) await hc(["send", terminal, line]);
    return { first: pane, last: pane };
  }
  const right = node.split === "right";
  const r = node.ratio ?? 0.5;
  const job = { right, px: (r - 0.5) * (right ? size.w : size.h) };
  jobs.push(job);
  const s = await hdo("pane.split", { direction: node.split, pane });
  const sa = right ? { w: size.w * r, h: size.h } : { w: size.w, h: size.h * r };
  const sb = right ? { w: size.w - sa.w, h: size.h } : { w: size.w, h: size.h - sa.h };
  const a = await build(node.a, pane, terminal, folder, sa, jobs);
  const b = await build(node.b, s.pane, s.terminal, folder, sb, jobs);
  job.aLast = a.last; // bottom-right leaf of a: its right/bottom border is this split's
  job.bFirst = b.first; // top-left leaf of b: its left/top border is this split's
  return { first: a.first, last: b.last };
}

// Herdr splits 50/50; move each border by the difference. A border only moves
// toward a pane that is there, so grow a's last leaf or b's first one.
async function resize(jobs, cx) {
  await cx.sleep(400); // resizes are ignored until the new panes are laid out
  for (const j of jobs) {
    if (Math.abs(j.px) < 8) continue;
    const grow = j.px > 0;
    const pane = grow ? j.aLast : j.bFirst;
    const direction = j.right ? (grow ? "right" : "left") : grow ? "down" : "up";
    // one call moved at most 300 px in testing
    for (let left = Math.abs(j.px); left > 0; left -= 250)
      await hdo("pane.resize", { pane, direction, px: Math.round(Math.min(250, left)) });
  }
}

// ponytail: Herdr doesn't report pane sizes. Window minus sidebar and chrome,
// measured on one setup. Ratios come out close, not exact.
async function tabArea(vp) {
  const st = JSON.parse((await exec("herdr-app", ["status"])).stdout || "{}");
  const z = st.zoom || 1;
  return { w: (vp?.width ?? 1600) / z - 290, h: (vp?.height ?? 1000) / z - 95 };
}

export async function launchProject(p, cx, vp) {
  const folder = expand(p.folder);
  const tabs = p.tabs?.length ? p.tabs : [{ name: "" }];
  const area = await tabArea(vp);
  let space, firstTab;
  for (const t of tabs) {
    // a new tab is shown at once, which the resizes need
    const r = space ? await hdo("tab.new", { space, name: t.name, folder }) : await hdo("space.new", { name: p.name, folder, tab: t.name });
    space ??= r.space;
    firstTab ??= r.tab;
    const jobs = [];
    await build(layoutOf(t), await paneOf(r.terminal), r.terminal, folder, area, jobs);
    if (jobs.length) await resize(jobs, cx);
  }
  await hdo("tab.select", { id: firstTab });
  // Herdr apps (mods) open against the focused space/terminal, like their key would.
  // mod.open toggles, so wait for each one's overlay to finish before the next.
  for (const name of p.apps ?? []) {
    await hdo("mod.open", { name });
    for (let i = 0; i < 40; i++) {
      const s = JSON.parse((await exec("herdr-app", ["status"])).stdout || "{}");
      if (!s.overlays?.includes(name)) break;
      await cx.sleep(250);
    }
  }
}
