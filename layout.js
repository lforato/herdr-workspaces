// A tab's layout is a tree: a leaf { id, command, dir }, or a split
// { id, split: "right" | "down", ratio, a, b } where `a` is left/top.
// launch.py builds it in Herdr.

import { home } from "herdr";

export const expand = (p) => (p || "").replace(/^~(?=\/|$)/, home());
export const uid = () => Math.random().toString(36).slice(2, 12);

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
