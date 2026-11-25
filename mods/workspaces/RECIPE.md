# Workspaces

A Herdr desktop mod (id `workspaces`, folder `mods/workspaces`) that saves terminal layouts as **projects**, groups them into **profiles**, and starts them in one step. Opened with `cmd-o`. Built with `gpui-kit` / `gpui-base`; colors come from Herdr's `theme()` so it follows the active theme.

## Files

- `mod.json`: `{ "place": "none", "title": "Workspaces", "overlay": { "kind": "dialog", "width": 1080, "height": 0.85, "modal": true } }`
- `main.js`: the UI, one `View` class with three views (list, project editor, profile editor) plus a small loading dialog.
- `launch.js`: builds a project in Herdr.
- `icons/*.svg`: lucide-style 2px line icons, loaded with `svg("mods/workspaces/icons/<name>.svg")`.
- `keys.json`: `cmd-o` opens the dialog; `cmd-n` makes a new project instead of a new space.

## Data

Saved to `~/.config/herdr-app/data/projects.json` with `readTextFile` / `writeTextFile` (pass the last-read text so stale writes are refused).

```json
{
  "projects": [{ "id": "", "name": "", "folder": "~/Projects/x", "apps": ["gitview-tab"],
    "tabs": [{ "name": "server", "layout": { "id": "", "split": "right", "ratio": 0.5,
      "a": { "id": "", "command": "nvim .", "dir": "" }, "b": { "id": "", "command": "", "dir": "api" } } }] }],
  "profiles": [{ "id": "", "name": "", "projects": ["<project id>"] }]
}
```

A layout is a tree: a leaf `{ id, command, dir }` or a split `{ id, split: "right" | "down", ratio, a, b }` (`a` is left/top). Old projects may have a flat `panes` list; `layoutOf` converts it.

## Screens

- **List:** header with a Projects | Profiles switch (with counts) and a primary "New" button; a search field (`cmd-k`) matching name, folder and tab names; rows with an initial badge in a theme tint, name, mono folder path, up to 4 tab chips plus "+N more", and Open / edit / delete. Footer shows key hints. Profiles show as cards: numbered projects, "Launch profile", edit, delete, and a dashed "New profile" card.
- **Project editor:** inline name, folder with Browse, mods as chips, a tab strip with pane counts, a resizable pane canvas (fixed size so ratios are exact), and a bar under it to edit the selected pane's directory and command, split right/down (`cmd-d` / `shift-cmd-d`) and delete the pane. `cmd-s` saves, `Esc` goes back.
- **Profile editor:** launch order list on the left, filterable "Add projects" list on the right.
- Deleting asks for a second press (`cmd-backspace` twice, or click twice).

## Launching

1. Open a small modal loading dialog that holds the keyboard; close the list.
2. For each project run `herdr-app do space.new` / `tab.new` (`focus: false`) and `pane.split` to build every tab's tree. Each pane is a plain shell; type `cd <dir> && <command>` into it with `hc send` (a split's own command would lack the shell's PATH and close on exit).
3. Herdr splits 50/50. Move each border with `pane.resize` using sizes estimated from the window size (Herdr doesn't report pane sizes). A pane can only be resized while its tab is on screen, so select each split tab briefly and retry on "on screen" errors.
4. Select the first tab, then `mod.open` each of the project's `apps` one at a time.
5. Close the dialog; report errors with `notify`.

## Not included

Drag-to-reorder for tabs and profile projects, and per-pane focus on tab open.
