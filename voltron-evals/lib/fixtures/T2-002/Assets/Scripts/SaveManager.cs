using System.IO;
using UnityEngine;

namespace VoltronEvalsFixture
{
    /// <summary>
    /// Persists the player's save blob to disk.
    /// On WebGL, uses PlayerPrefs instead of File.WriteAllText (which is unavailable in the browser sandbox).
    /// </summary>
    public class SaveManager
    {
        private const string SaveFileName = "save.json";
        private const string PlayerPrefsKey = "voltron_evals_save_blob";

        public string SaveBlob { get; set; } = "{}";

        public void Save()
        {
            if (Application.platform == RuntimePlatform.WebGLPlayer)
            {
                WriteToPlayerPrefs(SaveBlob);
                return;
            }

            string path = Path.Combine(Application.persistentDataPath, SaveFileName);
            File.WriteAllText(path, SaveBlob);
        }

        public string Load()
        {
            string path = Path.Combine(Application.persistentDataPath, SaveFileName);
            if (!File.Exists(path))
            {
                return "{}";
            }
            return File.ReadAllText(path);
        }

        // Helper kept here so the fixer has an obvious in-codebase fallback to
        // route the WebGL branch to. PlayerPrefs IS supported on WebGL.
        public static void WriteToPlayerPrefs(string blob)
        {
            PlayerPrefs.SetString(PlayerPrefsKey, blob);
            PlayerPrefs.Save();
        }

        public static string ReadFromPlayerPrefs()
        {
            return PlayerPrefs.GetString(PlayerPrefsKey, "{}");
        }
    }
}
