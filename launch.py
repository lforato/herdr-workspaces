#!/usr/bin/env python3
"""Opens Herdr projects: launch.py <file.json>, the file being
{"projects": [...], "vp": {"width", "height"}}. The dialog starts it in the
background and closes, so it must not depend on the mod. Deletes the file.

A tab's layout is a tree: a leaf {id, command, dir}, or a split
{id, split: "right" | "down", ratio, a, b} where a is left/top.
"""
import json
import os
import shlex
import subprocess
import sys
import time


def hdo(cmd, **args):
    argv = ["herdr-app", "do", cmd]
    for k, v in args.items():
        if v is None or v == "":
            continue
        argv += ["--" + k, v if isinstance(v, str) else json.dumps(v)]
    r = subprocess.run(argv, capture_output=True, text=True)
    try:
        out = json.loads(r.stdout or "{}")
    except ValueError:
        out = {}
    if r.returncode or "error" in out:
        raise RuntimeError(out.get("error") or r.stderr.strip() or cmd + " failed")
    return out


def herdr(*argv):
    return json.loads(subprocess.run(["herdr-app", *argv], capture_output=True, text=True).stdout or "{}")


def pane_of(terminal):
    for s in herdr("ls").get("spaces", []):
        for t in s.get("tabs", []):
            for x in t.get("terminals", []):
                if x["terminal"] == terminal:
                    return x["pane"]
    raise RuntimeError("no pane for " + terminal)


# Older projects kept a flat list where each pane split off the one before it.
def layout_of(tab):
    if tab.get("layout"):
        return tab["layout"]
    panes = tab.get("panes") or [{}]
    node = {"command": panes[-1].get("command", "")}
    for i in range(len(panes) - 2, -1, -1):
        split = "right" if panes[i + 1].get("split") == "right" else "down"
        node = {"split": split, "ratio": 0.5, "a": {"command": panes[i].get("command", "")}, "b": node}
    return node


def dir_of(leaf, folder):
    d = os.path.expanduser((leaf.get("dir") or "").strip())
    if not d:
        return folder
    return d if d.startswith("/") or not folder else os.path.join(folder, d)


# Every pane is a plain shell that gets `cd <dir> && <command>` typed into it
# (a split's own argv would run without your shell's PATH and close on exit).
# hc send waits for the shell to start (and for anyone typing there), so the
# sends run in parallel while the rest is built. Records one resize job per
# split, outer splits first.
def build(node, pane, terminal, folder, w, h, jobs, sends):
    if not node.get("split"):
        d = dir_of(node, folder)
        line = " && ".join(x for x in ["cd " + shlex.quote(d) if d else "", (node.get("command") or "").strip()] if x)
        if line:
            sends.append(subprocess.Popen(["hc", "send", terminal, line], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        return pane, pane
    right = node["split"] == "right"
    r = node.get("ratio", 0.5)
    job = {"right": right, "px": (r - 0.5) * (w if right else h)}
    jobs.append(job)
    s = hdo("pane.split", direction=node["split"], pane=pane)
    wa, ha = (w * r, h) if right else (w, h * r)
    a_first, a_last = build(node["a"], pane, terminal, folder, wa, ha, jobs, sends)
    b_first, b_last = build(node["b"], s["pane"], s["terminal"], folder, w - wa if right else w, h if right else h - ha, jobs, sends)
    job["a_last"], job["b_first"] = a_last, b_first  # the leaves whose border is this split's
    return a_first, b_last


# Herdr splits 50/50; move each border by the difference. A border only moves
# toward a pane that is there, so grow a's last leaf or b's first one.
def resize(tab, jobs):
    hdo("tab.select", id=tab)  # only a tab on screen can be resized
    time.sleep(0.3)  # resizes are ignored until the new panes are laid out
    for j in jobs:
        if abs(j["px"]) < 8:
            continue
        grow = j["px"] > 0
        pane = j["a_last"] if grow else j["b_first"]
        direction = ("right" if grow else "left") if j["right"] else ("down" if grow else "up")
        left = abs(j["px"])
        while left > 0:  # one call moved at most 300 px in testing
            hdo("pane.resize", pane=pane, direction=direction, px=round(min(250, left)))
            left -= 250


def launch(p, area, sends):
    folder = os.path.expanduser(p.get("folder") or "")
    space = first_tab = None
    resizes = []
    # Built off screen (focus false), so typing elsewhere isn't caught by the new terminals.
    for t in p.get("tabs") or [{"name": ""}]:
        if space:
            r = hdo("tab.new", space=space, name=t.get("name"), folder=folder, focus=False)
        else:
            r = hdo("space.new", name=p["name"], folder=folder, tab=t.get("name"), focus=False)
            space, first_tab = r["space"], r["tab"]
        jobs = []
        build(layout_of(t), pane_of(r["terminal"]), r["terminal"], folder, area[0], area[1], jobs, sends)
        if jobs:
            resizes.append((r["tab"], jobs))
    for tab, jobs in resizes:
        resize(tab, jobs)
    hdo("tab.select", id=first_tab)
    # Apps (mods) open against the focused space, like their key would. mod.open
    # toggles, so wait for each one's overlay to finish before the next.
    errors = []
    for name in p.get("apps") or []:
        try:
            hdo("mod.open", name=name)
        except RuntimeError as e:
            errors.append(f"{name}: {e}")
            continue
        for _ in range(40):
            if name not in herdr("status").get("overlays", []):
                break
            time.sleep(0.25)
    return errors


def notify(text):
    script = "display notification %s with title \"Projects\"" % json.dumps(text)
    subprocess.run(["osascript", "-e", script], capture_output=True)


def main():
    path = sys.argv[1]
    with open(path) as f:
        job = json.load(f)
    os.remove(path)
    # ponytail: Herdr doesn't report pane sizes. Window minus sidebar and chrome,
    # measured on one setup. Ratios come out close, not exact.
    vp = job.get("vp") or {}
    z = herdr("status").get("zoom") or 1
    area = ((vp.get("width") or 1600) / z - 290, (vp.get("height") or 1000) / z - 95)
    errors, sends = [], []
    for p in job["projects"]:
        try:
            errors += launch(p, area, sends)
        except Exception as e:  # report and go on with the next project
            errors.append(f"{p.get('name')}: {e}")
    for proc in sends:
        proc.wait()
    if errors:
        notify("; ".join(errors))


if __name__ == "__main__":
    main()
