# Customize project appearance

## Project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

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
    "idle": "#071525",
    "active": "#245181",
    "selected": "#173b60"
  }
}
```

Colors must use six-digit hex notation. Exact colors replace the generated tints, so choose values
that remain readable with your light and dark sidebar themes.
