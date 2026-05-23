# T2-002 Fixture — Unity WebGL Save bug

## Supported platforms

| Platform | Save backend | Notes |
|---|---|---|
| Windows / macOS / Linux standalone | `System.IO.File` | persistent data path |
| WebGL | (broken — throws `PlatformNotSupportedException`) | should fall back to `PlayerPrefs` |

## Bug

`Assets/Scripts/SaveManager.cs` calls `System.IO.File.WriteAllText` unconditionally.
In the WebGL player the synchronous filesystem API is not available, so the
`Save()` path throws `PlatformNotSupportedException` at runtime.

## Expected fix shape

Gate the file-write on `Application.platform != RuntimePlatform.WebGLPlayer`.
Route the WebGL branch to `PlayerPrefs` using the existing helpers
`WriteToPlayerPrefs` / `ReadFromPlayerPrefs`. The non-WebGL branch should keep
calling `File.WriteAllText` so desktop builds continue to work.
