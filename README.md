# herdr-projects

A [Herdr](https://herdr.dev) desktop mod that saves space layouts as projects and starts them in one step.

- **Projects:** a name, a folder, and tabs. Each tab has panes, and each pane has a command and a split direction (right or down).
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
- The mod builds spaces with `herdr-app do`, which returns the new space, tab and pane ids.
- The first pane of each tab runs its command as `sh -c "<command>"` inside your shell. The shell stays open after the command exits.
- Split panes open a plain shell. The mod then types `cd <folder> && <command>` into it with `hc send`. A split's own command would run without your shell's PATH and close on exit.
- Don't close the dialog while it shows "Opening…". The launch runs in the dialog and stops if it closes.
