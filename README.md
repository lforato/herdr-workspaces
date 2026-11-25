# herdr-workspaces

Mods for the [Herdr](https://herdr.dev) desktop app.

| Mod | What it does |
| --- | --- |
| [`projects`](mods/projects) | Save terminal layouts (tabs, split panes, a command per pane) as projects, group them into profiles, and start them with `cmd-o`. |

## Install

```sh
git clone https://github.com/lforato/herdr-workspaces ~/herdr-workspaces
ln -s ~/herdr-workspaces/mods/projects ~/.config/herdr-app/mods/projects
```

The folder name must stay `projects`: it is the mod id. Then merge `mods/projects/keys.json` into `~/.config/herdr-app/keys.json`.

## Use

Press `cmd-o`. `cmd-n` new, `cmd-e` edit, `Tab` switches projects / profiles, `Enter` opens, `cmd-s` saves, `Esc` goes back. See [RECIPE.md](mods/projects/RECIPE.md) for the full behavior.
