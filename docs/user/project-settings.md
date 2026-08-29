# Customize project appearance

## Project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files. If it does not find an image, it chooses a built-in
icon from the saved project name. In web and desktop, this icon stays the same when the sidebar
shows a repository label such as `owner/repo`.

To choose a different icon or emoji:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Next to **Project icon**, select **Choose icon**.
4. Search the full Lucide icon set and choose a color, or switch to **Emoji** and choose or paste
   an emoji.

To use an image from the project instead, select **Choose file**, search for an image, and select
it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Keep the default branch current

Turn on **Automatically pull** in a project's settings to keep its default-branch checkout current.
T3 Code checks in the background and when the server starts. It uses the branch's configured
upstream and only performs a fast-forward pull when the checkout has no working-tree changes,
untracked files, or local commits.

The pull is skipped if the checkout is on another branch, has no upstream, or contains local work.
Pull failures do not prevent the server from starting.

## Sidebar accent

Add `accentColor` to `t3.json` to tint every sidebar thread row for the project. The tint is
strongest at the right edge of the row and fades out toward the left. A single color generates
restrained idle, active, and selected tints:

```json
{
  "accentColor": "#1688f0"
}
```

For exact control, set all three row colors:

```json
{
  "accentColor": {
    "idle": "#7ea7d8",
    "active": "#3d7ec4",
    "selected": "#5c93cd"
  }
}
```

Colors must use six-digit hex notation. Exact colors replace the generated tints and the same
values apply to both the light and dark themes, so pick mid-strength colors that stay readable
behind text on each.
