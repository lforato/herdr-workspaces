# herdr-workspaces

<img width="1280" height="640" alt="herdr-workspaces banner" src="https://github.com/user-attachments/assets/20e1dfeb-efde-43ed-a291-196505399b74" />

Mods for the [Herdr](https://herdr.dev) desktop app.

| Mod | What it does |
| --- | --- |
| [`workspaces`](mods/workspaces) | Save terminal layouts (tabs, split panes, a command per pane) as projects, group them into profiles, and start them with `cmd-o`. |

## Install

```sh
git clone https://github.com/lforato/herdr-workspaces ~/herdr-workspaces
ln -s ~/herdr-workspaces/mods/workspaces ~/.config/herdr-app/mods/workspaces
```

The folder name must stay `workspaces`: it is the mod id. Then merge `mods/workspaces/keys.json` into `~/.config/herdr-app/keys.json`.

## Use

Press `cmd-o`. `cmd-n` new, `cmd-e` edit, `Tab` switches projects / profiles, `Enter` opens, `cmd-s` saves, `Esc` goes back. See [RECIPE.md](mods/workspaces/RECIPE.md) for the full behavior.
