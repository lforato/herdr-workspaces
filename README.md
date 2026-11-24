# herdr-projects

A [Herdr](https://herdr.dev) desktop mod that saves space layouts as projects and starts them in one step.

- **Projects:** a name, a folder, and tabs. Each tab is a pane layout you draw: select a pane, split it vertically or horizontally, drag borders to size it, delete it. Each pane has a command and, optionally, its own folder.
- **Apps:** Herdr mods to open after the layout is built, for example `gitview-tab`. Each opens in the new space, as if you pressed its key there.
- **Profiles:** a group of projects that start together, one space each.
- Create, edit, filter, open and delete them from one dialog. There is no config file to write by hand.

## Install

```sh
git clone https://github.com/lforato/herdr-projects ~/.config/herdr-app/mods/projects
```

Add a key to `~/.config/herdr-app/keys.json`:

```json
{
  "global": { "cmd-o": "mod.open:projects" },
  "mod:projects": { "cmd-n": "projects.new" }
}
```

The `mod:projects` line is optional. Without it, `cmd-n` makes a new space (Herdr's default) instead of a new project.

## Keys

| Key | Where | What |
| --- | --- | --- |
| `cmd-o` | anywhere | Open or close the dialog |
| type | list | Filter by name |
| `↑` / `↓`, `Enter` | list | Move, open |
| `tab` | list | Switch between projects and profiles |
| `cmd-n` / `cmd-e` | list | New, edit |
| `cmd-⌫` (twice) | list | Delete |
| `cmd-s` / `Esc` | editor | Save, back |

## How it works

- Data is saved to `~/.config/herdr-app/data/projects.json`.
- Spaces are built with `herdr-app do`, which returns the new space, tab and pane ids.
- Every pane opens a plain shell. The mod then types `cd <folder> && <command>` into it with `hc send`. A split's own command would run without your shell's PATH and close on exit.
- Herdr splits 50/50. The mod then moves each border with `pane.resize`. Herdr doesn't report pane sizes, so it estimates them from the window size, and ratios come out close but not exact.
- Opening closes the list and shows a small loading dialog with a spinner. It dims the window and takes the keyboard until the project is ready. It builds the tabs and splits off screen, types the commands in parallel while the shells start, sizes the split tabs, selects your first tab, then closes.
- A pane can only be resized while its tab is on screen. The loading dialog shows each split tab for a moment to do it.
