# herdr-workspaces

<img width="1280" height="640" alt="herdr-workspaces banner@1x (1)" src="https://github.com/user-attachments/assets/20e1dfeb-efde-43ed-a291-196505399b74" />

A [Herdr](https://herdr.dev) desktop mod that saves your terminal layouts as **projects** and starts them in one step. Group projects into **profiles** to start several at once.

- **Project:** a name, a folder, and tabs. Each tab is a pane layout you draw: split panes right or down, drag dividers to size them, delete them. Each pane has a command and, optionally, its own directory.
- **Mods:** Herdr mods to open after the layout is built, for example `gitview-tab`.
- **Profile:** an ordered list of projects that start together, one space each.
- Everything is edited in the dialog. There is no config file to write by hand.

## Install

The mod folder must be named `projects`, since that is the mod id.

```sh
git clone https://github.com/lforato/herdr-workspaces ~/.config/herdr-app/mods/projects
```

Add a key to `~/.config/herdr-app/keys.json`:

```json
{
  "global": { "cmd-o": "mod.open:projects" },
  "mod:projects": { "cmd-n": "projects.new" }
}
```

The `mod:projects` line is optional. Without it, `cmd-n` makes a new space (Herdr's default) instead of a new project.

The dialog uses your Herdr theme colors.

## Use

1. Press `cmd-o` to open the dialog.
2. **New project** (`cmd-n`): set a name and folder, add tabs, then select a pane and set its directory and command. `Split right` / `Split down` (`cmd-d` / `shift-cmd-d`) add panes. Save with `cmd-s`.
3. Press `Enter` (or click **Open**) to start a project. Herdr builds the tabs and panes, types each command, and selects the first tab.
4. Switch to **Profiles** (`Tab`), create one, add projects in the order you want, and **Launch profile**.

## Keys

| Key | Where | What |
| --- | --- | --- |
| `cmd-o` | anywhere | Open or close the dialog |
| type / `cmd-k` | projects list | Search by name, folder or tab |
| `↑` `↓` / `Enter` | list | Move, open |
| `Tab` | list | Switch projects / profiles |
| `cmd-n` / `cmd-e` | list | New, edit |
| `cmd-⌫` (twice) | list | Delete |
| `cmd-d` / `shift-cmd-d` | project editor | Split pane right / down |
| `cmd-s` / `Esc` | editor | Save, back |

## How it works

- Data is saved to `~/.config/herdr-app/data/projects.json`.
- Spaces are built with `herdr-app do`, which returns the new space, tab and pane ids.
- Every pane opens a plain shell, then the mod types `cd <folder> && <command>` into it. A split's own command would run without your shell's PATH and close on exit.
- Herdr splits 50/50. The mod then moves each border with `pane.resize`. Herdr doesn't report pane sizes, so it estimates them from the window size and ratios come out close, not exact.
- While a project opens, a small loading dialog holds the keyboard. A pane can only be resized while its tab is on screen, so it shows each split tab for a moment.

## Not supported yet

- Reordering tabs or profile projects by dragging. To reorder a profile, remove a project and add it back.
- Focusing a specific pane when a tab opens.
